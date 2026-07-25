// Offscreen ffmpeg.wasm host. Jobs are intentionally serialized: a single
// ffmpeg virtual filesystem cannot safely process overlapping downloads.

const { FFmpeg } = FFmpegWASM;
const FFMPEG_LOG_LIMIT = 40;
const STALE_JOB_MS = 5 * 60_000;
const SINGLE_THREAD_STALL_MS = 90_000;

let ffmpeg;
let ffmpegLoad;
const ffmpegMode = 'single-thread';
let activeJob;
const ffmpegLogs = [];

function sendProgress(value, status, percent = value * 100) {
  if (!activeJob) return;
  const progress = Number.isFinite(value) ? value : 0;
  chrome.runtime.sendMessage({
    t: 'nova-progress',
    tabId: activeJob.tabId,
    jobId: activeJob.id,
    value: Math.max(0, Math.min(1, progress)),
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    ...(status ? { status } : {}),
  }).catch(() => {});
}

function processingStatus(job) {
  if (job.format === 'mp3') return 'Кодирование MP3…';
  if (job.scaleHeight) return `Масштабирование до ${job.scaleHeight}p…`;
  return job.transcode ? 'Перекодирование в H.264/AAC…' : 'Склейка дорожек…';
}

function emitProcessingProgress(value) {
  if (!activeJob || activeJob.phase !== 'processing' || !Number.isFinite(value)) return;
  const progress = Math.max(0, Math.min(1, value));
  const now = Date.now();
  if (progress <= activeJob.lastProgress) return;
  if (progress < 1 && progress - activeJob.lastProgress < 0.001 && now - activeJob.lastProgressAt < 250) return;
  activeJob.lastProgress = progress;
  activeJob.lastProgressAt = now;
  const pipelineProgress = 0.1 + (progress * 0.85);
  sendProgress(pipelineProgress, processingStatus(activeJob), pipelineProgress * 100);
}

function progressFromLog(message) {
  if (!activeJob || typeof message !== 'string') return;
  if (!activeJob.duration) {
    const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (durMatch) {
      const durSec = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
      if (Number.isFinite(durSec) && durSec > 0) activeJob.duration = durSec;
    }
  }
  if (!activeJob.duration) return;

  const microseconds = /(?:^|\s)(?:out_time_us|out_time_ms)=(\d+)/.exec(message);
  const clock = /(?:out_time|time)=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
  const seconds = microseconds
    ? Number(microseconds[1]) / 1_000_000
    : (clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : NaN);
  if (!Number.isFinite(seconds)) return;
  emitProcessingProgress(seconds / activeJob.duration);
}

function createFFmpegInstance() {
  const instance = new FFmpeg();
  instance.on('progress', ({ progress }) => emitProcessingProgress(progress));
  instance.on('log', ({ message }) => {
    ffmpegLogs.push(message);
    if (ffmpegLogs.length > FFMPEG_LOG_LIMIT) ffmpegLogs.shift();
    const integrityError = ffmpegIntegrityError([message]);
    if (activeJob && integrityError && !activeJob.integrityError) activeJob.integrityError = integrityError;
    progressFromLog(message);
  });
  return instance;
}

async function loadSingleThreadFFmpeg() {
  const instance = createFFmpegInstance();
  const base = chrome.runtime.getURL('vendor/ffmpeg/');
  await instance.load({
    coreURL: `${base}ffmpeg-core.js`,
    wasmURL: `${base}ffmpeg-core.wasm`,
  });
  return instance;
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!ffmpegLoad) {
    ffmpegLoad = loadSingleThreadFFmpeg()
      .then((instance) => {
        ffmpeg = instance;
        return instance;
      })
      .catch((error) => {
      ffmpegLoad = undefined;
      throw error;
    });
  }
  return ffmpegLoad;
}

async function execWithProgressWatchdog(instance, args, job, timeoutMs) {
  let timer;
  const stalled = new Promise((_, reject) => {
    const check = () => {
      const remaining = timeoutMs - (Date.now() - job.lastProgressAt);
      if (remaining <= 0) {
        const error = new Error(`ffmpeg не показывает прогресс более ${Math.round(timeoutMs / 1000)} секунд`);
        error.code = 'FFMPEG_STALLED';
        reject(error);
        return;
      }
      timer = setTimeout(check, Math.min(1_000, remaining));
    };
    timer = setTimeout(check, Math.min(1_000, timeoutMs));
  });
  try {
    return await Promise.race([instance.exec(args), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeInputFiles(instance, inputs) {
  // FFmpeg transfers the provided buffer to its Worker and detaches it. Always
  // send a disposable copy so the offscreen document retains local ownership.
  for (const input of inputs) await instance.writeFile(input.name, input.bytes.slice());
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatParts(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function extensionFor(mime) {
  if (/webm/i.test(mime)) return 'webm';
  if (/mp4/i.test(mime)) return 'mp4';
  return 'bin';
}

function hasMp4Box(bytes, expected) {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = (bytes[offset] * 0x1000000)
      + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8)
      + bytes[offset + 3];
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === expected) return true;
    if (size === 0) break;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      const high = (bytes[offset + 8] * 0x1000000)
        + (bytes[offset + 9] << 16)
        + (bytes[offset + 10] << 8)
        + bytes[offset + 11];
      const low = (bytes[offset + 12] * 0x1000000)
        + (bytes[offset + 13] << 16)
        + (bytes[offset + 14] << 8)
        + bytes[offset + 15];
      if (high !== 0 || low < 16) break;
      offset += low;
    } else {
      if (size < 8) break;
      offset += size;
    }
  }
  return false;
}

function assertContainerHeader(bytes, mime, track) {
  const isWebM = bytes.length >= 4
    && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
  const isMp4 = bytes.length >= 8
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  const validMp4 = isMp4 && hasMp4Box(bytes, 'moov')
    && (hasMp4Box(bytes, 'moof') || hasMp4Box(bytes, 'mdat'));
  if ((/webm/i.test(mime) && !isWebM) || (/mp4/i.test(mime) && !validMp4)) {
    const signature = [...bytes.subarray(0, 12)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(' ');
    throw new Error(`повреждён заголовок дорожки ${track} (${mime || 'unknown'}; ${signature || 'empty'})`);
  }
}

function beginJob(message) {
  if (activeJob?.phase === 'receiving' && Date.now() - activeJob.lastActivity > STALE_JOB_MS) {
    activeJob.video.length = 0;
    activeJob.videoPrefix.length = 0;
    activeJob.audio.length = 0;
    activeJob = undefined;
  }
  if (activeJob) return { ok: false, error: 'другая загрузка уже обрабатывается' };
  if (typeof message.jobId !== 'string' || !message.jobId) return { ok: false, error: 'идентификатор задания отсутствует' };
  if (!Number.isInteger(message.tabId)) return { ok: false, error: 'вкладка загрузки не определена' };
  activeJob = {
    id: message.jobId,
    tabId: message.tabId,
    phase: 'receiving',
    lastActivity: Date.now(),
    video: [],
    videoPrefix: [],
    audio: [],
    videoMime: message.videoMime || '',
    videoPrefixMime: message.videoPrefixMime || '',
    videoPrefixBoundary: Math.max(0, Number(message.videoPrefixBoundary) || 0),
    audioMime: message.audioMime || '',
    filename: message.filename || 'video.mp4',
    transcode: Boolean(message.transcode),
    format: message.format || 'mp4',
    scaleHeight: Number(message.scaleHeight) || 0,
    duration: Number(message.duration) > 0 ? Number(message.duration) : 0,
    audioCaptureRate: Math.min(4, Math.max(1, Number(message.audioCaptureRate) || 1)),
    lastProgress: 0,
    lastProgressAt: 0,
  };
  getFFmpeg().catch(() => {}); // warm up while chunks arrive
  return { ok: true };
}

function appendChunk(message) {
  if (!activeJob || activeJob.phase !== 'receiving' || message.jobId !== activeJob.id) {
    return { ok: false, error: 'задание загрузки не найдено' };
  }
  if (message.track !== 'video' && message.track !== 'video-prefix'
    && message.track !== 'audio') {
    return { ok: false, error: 'неизвестный тип дорожки' };
  }
  const target = message.track === 'video-prefix' ? 'videoPrefix' : message.track;
  activeJob[target].push(decodeBase64(message.b64));
  activeJob.lastActivity = Date.now();
  return { ok: true };
}

function abortJob(message) {
  if (activeJob?.id === message.jobId && activeJob.phase === 'receiving') {
    activeJob.video.length = 0;
    activeJob.videoPrefix.length = 0;
    activeJob.audio.length = 0;
    activeJob = undefined;
  }
  return { ok: true };
}

function buildRuns(job, videoName, audioName, videoPrefixName) {
  const progressOutput = ['-progress', 'pipe:1', '-nostats'];
  const audioInput = ['-i', audioName];
  if (job.format === 'mp3') {
    const tempoFilters = [];
    let remainingRate = job.audioCaptureRate || 1;
    while (remainingRate > 2.0001) {
      tempoFilters.push('atempo=0.5');
      remainingRate /= 2;
    }
    if (remainingRate > 1.0001) tempoFilters.push(`atempo=${(1 / remainingRate).toFixed(8)}`);
    // Rebuild timestamps from the decoded sample count. This removes WebM
    // timeline gaps/offsets that can otherwise make an MP3 appear ~10s longer
    // even when the output-level -t limit is present. This must run before
    // atrim: trimming the original discontinuous timeline can discard valid
    // samples from the end of the recording.
    tempoFilters.push('asetpts=N/SR/TB');
    if (job.duration > 0) tempoFilters.push(`atrim=duration=${job.duration.toFixed(3)}`);
    const restoreDuration = ['-filter:a', tempoFilters.join(',')];
    const exactDuration = job.duration > 0 ? ['-t', job.duration.toFixed(3)] : [];
    return [{
      out: 'out.mp3', type: 'audio/mpeg', extension: '.mp3',
      args: [...progressOutput, ...audioInput, '-vn', ...restoreDuration,
        ...exactDuration, '-c:a', 'libmp3lame', '-b:a', '192k', '-threads', '0', 'out.mp3'],
    }];
  }

  const videoInput = ['-i', videoName];
  if (videoPrefixName && job.videoPrefixBoundary > 0) {
    const boundary = job.videoPrefixBoundary.toFixed(3);
    const scale = job.scaleHeight ? `scale=-2:${job.scaleHeight},` : '';
    const audioFilter = job.duration > 0
      ? `asetpts=PTS-STARTPTS,atrim=duration=${job.duration.toFixed(3)}`
      : 'asetpts=PTS-STARTPTS';
    const filter = [
      `[0:v:0]trim=duration=${boundary},${scale}setsar=1,setpts=PTS-STARTPTS[prefix]`,
      `[1:v:0]${scale}setsar=1,setpts=PTS-STARTPTS+${boundary}/TB[tail]`,
      '[prefix][tail]concat=n=2:v=1:a=0,settb=AVTB[video]',
      `[2:a:0]${audioFilter}[audio]`,
    ].join(';');
    const exactDuration = job.duration > 0 ? ['-t', job.duration.toFixed(3)] : [];
    return [{
      out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
      args: [
        ...progressOutput,
        '-i', videoPrefixName,
        ...videoInput,
        ...audioInput,
        '-filter_complex', filter,
        '-map', '[video]', '-map', '[audio]',
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-threads', '0', '-c:a', 'aac', '-b:a', '160k',
        ...exactDuration, '-shortest', '-movflags', '+faststart', 'out.mp4',
      ],
    }];
  }
  if (job.transcode) {
    const scale = job.scaleHeight ? ['-vf', `scale=-2:${job.scaleHeight}`] : [];
    return [{
      out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
      args: [
        ...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-threads', '0', ...scale, '-c:a', 'aac', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart', 'out.mp4',
      ],
    }];
  }

  return [
    {
      out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
      args: [...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-strict', '-2', '-shortest', '-movflags', '+faststart', 'out.mp4'],
    },
    {
      out: 'out.webm', type: 'video/webm', extension: '.webm',
      args: [...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-shortest', 'out.webm'],
    },
  ];
}

function ffmpegIntegrityError(logs) {
  // Fragmented MP4 with B-frames can legitimately make FFmpeg repair a
  // non-monotonic DTS warning. Reject only explicit corrupt/invalid input;
  // ordinary timestamp correction is not sufficient evidence of a bad file.
  const message = logs.find((line) => /packet corrupt|corrupt decoded frame|invalid data found when processing input|crc mismatch/i.test(line));
  return message ? `ffmpeg обнаружил повреждённую временную шкалу: ${message}` : '';
}

// libmp3lame at 192 kbit/s writes a constant 24 000 bytes per second, so the
// encoded size is an accurate duration probe. A short MP3 means the assembled
// track lost a chunk (usually its opening segments) before encoding: fail
// loudly instead of handing the user a silently truncated file.
const MP3_BYTES_PER_SECOND = 192_000 / 8;

function mp3LengthMismatch(job, bytes) {
  if (job.format !== 'mp3' || !(job.duration > 10) || !bytes?.length) return '';
  const encodedSeconds = bytes.length / MP3_BYTES_PER_SECOND;
  const tolerance = Math.max(3, job.duration * 0.01);
  if (Math.abs(encodedSeconds - job.duration) <= tolerance) return '';
  return `MP3 получился ${encodedSeconds.toFixed(1)} сек вместо ${job.duration.toFixed(1)} сек`
    + ' — часть аудиодорожки не была захвачена';
}

async function finalizeJob(message) {
  if (!activeJob || activeJob.phase !== 'receiving' || message.jobId !== activeJob.id) {
    throw new Error('задание загрузки не найдено');
  }

  const job = activeJob;
  job.phase = 'processing';
  const files = new Set();
  let instance;

  try {
    sendProgress(0.02, 'Инициализация движка кодирования…');
    instance = await getFFmpeg();

    sendProgress(0.06, 'Подготовка буферов дорожек…');
    const inputs = [];
    const audioName = `audio.${extensionFor(job.audioMime)}`;
    const audioBytes = concatParts(job.audio);
    if (!audioBytes.length) throw new Error('пустые данные аудио');
    assertContainerHeader(audioBytes, job.audioMime, 'audio');
    inputs.push({ name: audioName, bytes: audioBytes });
    files.add(audioName);

    let videoName;
    let videoPrefixName;
    if (job.format !== 'mp3') {
      videoName = `video.${extensionFor(job.videoMime)}`;
      const videoBytes = concatParts(job.video);
      if (!videoBytes.length) throw new Error('пустые данные видео');
      assertContainerHeader(videoBytes, job.videoMime, 'video');
      inputs.push({ name: videoName, bytes: videoBytes });
      files.add(videoName);
      if (job.videoPrefixBoundary > 0) {
        const videoPrefixBytes = concatParts(job.videoPrefix);
        if (!videoPrefixBytes.length) throw new Error('пустые данные префикса видео');
        videoPrefixName = `video-prefix.${extensionFor(job.videoPrefixMime)}`;
        assertContainerHeader(videoPrefixBytes, job.videoPrefixMime, 'video-prefix');
        inputs.push({ name: videoPrefixName, bytes: videoPrefixBytes });
        files.add(videoPrefixName);
      }
    }
    await writeInputFiles(instance, inputs);

    let output;
    let selectedRun;
    let lastError = '';
    for (const run of buildRuns(job, videoName, audioName, videoPrefixName)) {
      ffmpegLogs.length = 0;
      job.integrityError = '';
      job.lastProgress = 0;
      job.lastProgressAt = Date.now();
      sendProgress(0, processingStatus(job), 0);
      files.add(run.out);
      const exitCode = await execWithProgressWatchdog(instance, run.args, job, SINGLE_THREAD_STALL_MS);
      const integrityError = job.integrityError || ffmpegIntegrityError(ffmpegLogs);
      let lengthError = '';
      if (exitCode === 0 && !integrityError) {
        const candidate = await instance.readFile(run.out).catch(() => null);
        if (candidate?.length) {
          lengthError = mp3LengthMismatch(job, candidate);
          if (!lengthError) {
            output = candidate;
            selectedRun = run;
            break;
          }
        }
      }
      lastError = integrityError || lengthError
        || `ffmpeg код ${exitCode}: ${ffmpegLogs.slice(-6).join(' | ')}`;
    }

    if (!selectedRun) throw new Error(lastError || 'ffmpeg не собрал файл');
    sendProgress(0.97, 'Подготовка файла к сохранению…', 97);

    const filename = job.filename.replace(/\.(mp4|webm|mp3)$/i, '') + selectedRun.extension;
    const url = URL.createObjectURL(new Blob([output], { type: selectedRun.type }));
    let downloadAccepted = false;
    try {
      const response = await chrome.runtime.sendMessage({ t: 'nova-save', url, filename });
      if (!response?.ok) throw new Error(response?.error || 'не удалось сохранить файл');
      downloadAccepted = true;
      sendProgress(1, 'Файл передан браузеру…', 100);
    } finally {
      // chrome.downloads reads the object URL asynchronously after accepting it.
      if (downloadAccepted) setTimeout(() => URL.revokeObjectURL(url), 60_000);
      else URL.revokeObjectURL(url);
    }
    return { ok: true, filename };
  } catch (error) {
    error.details = {
      format: job.format,
      transcode: job.transcode,
      scaleHeight: job.scaleHeight,
      audioMime: job.audioMime,
      videoMime: job.videoMime,
      ffmpegLogs: ffmpegLogs.slice(-10),
      ffmpegMode,
    };
    throw error;
  } finally {
    if (instance) {
      for (const name of files) {
        try { await instance.deleteFile(name); } catch (e) {}
      }
    }
    job.video.length = 0;
    job.videoPrefix.length = 0;
    job.audio.length = 0;
    if (activeJob === job) activeJob = undefined;
  }
}

async function reportError(error) {
  const detail = String(error?.stack || error?.message || error);
  await chrome.runtime.sendMessage({
    t: 'nova-error',
    context: 'offscreen/finalize',
    error: detail,
    details: error?.details,
  }).catch(() => {});
  return { ok: false, error: detail, logged: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.t !== 'string') return false;

  if (message.t === 'nova-begin') {
    sendResponse(beginJob(message));
    return false;
  }
  if (message.t === 'nova-warmup') {
    getFFmpeg()
      .then(() => sendResponse({ ok: true, mode: ffmpegMode }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.stack || error) }));
    return true;
  }
  if (message.t === 'nova-chunk') {
    try { sendResponse(appendChunk(message)); }
    catch (error) { sendResponse({ ok: false, error: String(error) }); }
    return false;
  }
  if (message.t === 'nova-abort') {
    sendResponse(abortJob(message));
    return false;
  }
  if (message.t === 'nova-finalize') {
    finalizeJob(message).then(sendResponse).catch(async (error) => sendResponse(await reportError(error)));
    return true;
  }
  return false;
});
