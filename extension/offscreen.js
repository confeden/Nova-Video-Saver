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

// ---- service worker messaging -------------------------------------------
// This document keeps working for minutes at a time while the MV3 service
// worker may be idle-terminated or already shutting down. A message that
// lands in that window fails with "Could not establish connection. Receiving
// end does not exist." even though the worker restarts moments later — that
// race silently threw away finished downloads. Every call therefore retries,
// and a heartbeat keeps the worker awake for as long as a job is running.
const WORKER_RETRY_DELAYS = [150, 400, 1_000, 2_000, 4_000, 6_000, 8_000, 8_000];
const KEEPALIVE_INTERVAL_MS = 20_000;
let keepAliveTimer;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isWorkerAsleep(error) {
  return /could not establish connection|receiving end does not exist|message port closed/i
    .test(String(error?.message || error));
}

async function sendToWorker(message, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (attempt >= retries || !isWorkerAsleep(error)) throw error;
      await wait(WORKER_RETRY_DELAYS[Math.min(attempt, WORKER_RETRY_DELAYS.length - 1)]);
    }
  }
}

// Diagnostics and progress: never allowed to fail a job, but a single retry
// keeps the journal readable — a lost log line is exactly what hides the real
// cause in an error report.
function notifyWorker(message, retries = 1) {
  return sendToWorker(message, { retries }).catch(() => null);
}

function logToWorker(tag, text) {
  return notifyWorker({ t: 'nova-log', tag, text });
}

let busyFinalizers = 0;

function jobsActive() {
  return Boolean(activeJob) || liveJobs.size > 0 || busyFinalizers > 0;
}

function updateKeepAlive() {
  if (jobsActive()) {
    if (keepAliveTimer) return;
    notifyWorker({ t: 'nova-ping' }, 0);
    keepAliveTimer = setInterval(() => {
      if (!jobsActive()) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
        return;
      }
      notifyWorker({ t: 'nova-ping' }, 0);
    }, KEEPALIVE_INTERVAL_MS);
  } else if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}

function sendProgress(value, status, percent = value * 100) {
  if (!activeJob) return;
  const progress = Number.isFinite(value) ? value : 0;
  notifyWorker({
    t: 'nova-progress',
    tabId: activeJob.tabId,
    jobId: activeJob.id,
    value: Math.max(0, Math.min(1, progress)),
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    ...(status ? { status } : {}),
  }, 0);
}

function processingStatus(job) {
  if (job.format === 'mp3') {
    return job.audioFormat === 'original'
      ? 'Извлечение оригинальной аудиодорожки…'
      : `Кодирование ${String(job.audioFormat || 'mp3').toUpperCase()}…`;
  }
  if (job.scaleHeight) return `Масштабирование до ${job.scaleHeight}p…`;
  if (job.loopVideo === -1) return 'Зацикливание видео под звук…';
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

// ---- WebCodecs / Mediabunny hardware transcode ---------------------------
// Re-encoding VP9→H.264 in wasm x264 runs far below realtime. Mediabunny
// (MPL-2.0, vendored ESM bundle) drives the OS hardware encoder through
// WebCodecs instead: typically 3–8x realtime. Any failure falls back to the
// proven ffmpeg pipeline below.
let mediabunnyLoad;

function getMediabunny() {
  if (!mediabunnyLoad) {
    mediabunnyLoad = import(chrome.runtime.getURL('vendor/mediabunny/mediabunny.min.mjs'))
      .catch((error) => {
        mediabunnyLoad = undefined;
        throw error;
      });
  }
  return mediabunnyLoad;
}

async function tryWebcodecsTranscode(job, videoBytes, audioBytes) {
  if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') {
    throw new Error('WebCodecs недоступен в этом браузере');
  }
  const {
    Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget,
    Mp4OutputFormat, QUALITY_HIGH,
    getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  } = await getMediabunny();

  const videoCodec = await getFirstEncodableVideoCodec(['avc'], { width: 2560, height: 1440 });
  if (!videoCodec) throw new Error('кодировщик H.264 недоступен');
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus']);
  if (!audioCodec) throw new Error('кодировщик аудио недоступен');

  const videoInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([videoBytes])) });
  const audioInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([audioBytes])) });
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

  // «Сжатый MP4, почти без потерь»: H.264 needs headroom over the VP9/AV1
  // source for equal quality, but an uncapped quality preset can triple the
  // file size. Target ~1.5× the source bitrate, bounded to sane limits.
  const sourceBitsPerSecond = job.duration > 0 ? (videoBytes.length * 8) / job.duration : 0;
  const videoBitrate = sourceBitsPerSecond > 0
    ? Math.round(Math.min(Math.max(sourceBitsPerSecond * 1.5, 700_000), 16_000_000))
    : QUALITY_HIGH;

  // Composable conversions add their tracks to one shared Output; matching
  // codecs (already-H.264 video, already-AAC audio) are stream-copied.
  const videoConversion = await Conversion.init({
    input: videoInput,
    output,
    composable: true,
    video: { codec: videoCodec, bitrate: videoBitrate },
    audio: { discard: true },
  });
  const audioConversion = await Conversion.init({
    input: audioInput,
    output,
    composable: true,
    audio: { codec: audioCodec, bitrate: 192e3 },
    video: { discard: true },
  });
  const discarded = [...videoConversion.discardedTracks, ...audioConversion.discardedTracks];
  if (discarded.length) {
    throw new Error(`дорожка не поддерживается WebCodecs: ${discarded.map((entry) => entry.reason).join(', ')}`);
  }

  let lastTick = Date.now();
  videoConversion.onProgress = (progress) => {
    lastTick = Date.now();
    if (!activeJob) return;
    const value = 0.1 + Math.max(0, Math.min(1, progress)) * 0.85;
    activeJob.lastProgressAt = lastTick;
    sendProgress(value, 'Аппаратное перекодирование в H.264/AAC…');
  };

  let stallTimer;
  const stallGuard = new Promise((_, reject) => {
    const check = () => {
      if (Date.now() - lastTick > 120_000) {
        reject(new Error('аппаратное перекодирование не показывает прогресс более 120 секунд'));
        return;
      }
      stallTimer = setTimeout(check, 5_000);
    };
    stallTimer = setTimeout(check, 5_000);
  });
  try {
    await output.start();
    await Promise.race([
      Promise.all([videoConversion.execute(), audioConversion.execute()]),
      stallGuard,
    ]);
    await output.finalize();
  } catch (error) {
    await videoConversion.cancel?.().catch(() => {});
    await audioConversion.cancel?.().catch(() => {});
    try {
      if (output.state === 'started' || output.state === 'pending') await output.cancel();
    } catch (cancelError) {}
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
  const buffer = output.target.buffer;
  if (!buffer?.byteLength) throw new Error('WebCodecs вернул пустой результат');
  return new Uint8Array(buffer);
}

// Stream-copy remux through Mediabunny. ffmpeg's mov demuxer gives up part way
// through a fragmented MP4 assembled from captured segments (exit code 0, a few
// seconds of output); Mediabunny parses the fragment index itself and either
// produces the whole track or fails loudly.
async function muxVodWithMediabunny(job, videoSource, audioSource) {
  const {
    Input, Output, Conversion, ALL_FORMATS, BufferTarget, Mp4OutputFormat,
  } = await getMediabunny();
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoInput = new Input({ formats: ALL_FORMATS, source: videoSource });
  const audioInput = new Input({ formats: ALL_FORMATS, source: audioSource });
  const videoConversion = await Conversion.init({
    input: videoInput, output, composable: true, audio: { discard: true },
  });
  const audioConversion = await Conversion.init({
    input: audioInput, output, composable: true, video: { discard: true },
  });
  const discarded = [...videoConversion.discardedTracks, ...audioConversion.discardedTracks];
  if (discarded.length) {
    throw new Error(`дорожка не поддерживается: ${discarded.map((entry) => entry.reason).join(', ')}`);
  }
  let lastTick = Date.now();
  videoConversion.onProgress = (progress) => {
    lastTick = Date.now();
    if (!activeJob) return;
    activeJob.lastProgressAt = lastTick;
    sendProgress(0.1 + Math.max(0, Math.min(1, progress)) * 0.85, 'Сборка дорожек…');
  };
  audioConversion.onProgress = () => { lastTick = Date.now(); };
  let stallTimer;
  const stallGuard = new Promise((_, reject) => {
    const check = () => {
      if (Date.now() - lastTick > 120_000) {
        reject(new Error('сборка не показывает прогресс более 120 секунд'));
        return;
      }
      stallTimer = setTimeout(check, 5_000);
    };
    stallTimer = setTimeout(check, 5_000);
  });
  try {
    await output.start();
    await Promise.race([
      Promise.all([videoConversion.execute(), audioConversion.execute()]),
      stallGuard,
    ]);
    await output.finalize();
  } catch (error) {
    await videoConversion.cancel?.().catch(() => {});
    await audioConversion.cancel?.().catch(() => {});
    try {
      if (output.state === 'started' || output.state === 'pending') await output.cancel();
    } catch (cancelError) {}
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
  const buffer = output.target.buffer;
  if (!buffer?.byteLength) throw new Error('сборка вернула пустой файл');
  const bytes = new Uint8Array(buffer);
  const short = outputDurationMismatch(job, bytes);
  if (short) throw new Error(short);
  return bytes;
}

// Kicks off the mux while the tracks are still being transferred, on a worker
// thread so this document keeps answering messages. Eligibility is decided from
// the begin message alone, so nothing here waits for bytes: the parser blocks
// on its first read until the first chunks land.
//
// The sizes below are NOT given to mediabunny — the worker feeds it an unsized
// ReadableStream precisely so it can never be told a track is shorter than it
// is (see mux_worker.js). They gate the path and drive the progress bar.
function startStreamingMux(job) {
  if (job.format === 'mp3' || job.transcode || job.muxed) return;
  if (job.scaleHeight || job.videoPrefixBoundary > 0) return;
  // A looped/paired-audio job is not a copy remux: the video has to be repeated
  // and the MP3 re-encoded, neither of which this path can do.
  if (job.loopVideo !== null) return;
  if (!(job.streams.video.expected > 0) || !(job.streams.audio.expected > 0)) return;

  let worker;
  try {
    worker = new Worker('mux_worker.js', { type: 'module' });
  } catch (error) {
    logToWorker('mux', `mux worker unavailable: ${String(error?.message || error)}`);
    return;
  }
  // Until the worker reports `ready` it has not imported mediabunny yet and may
  // still bow out; nothing is transferred to it before that, so the document
  // can fall back with every byte intact. Everything bound for the worker goes
  // through one queue — chunks AND the completion notices. Sending `complete`
  // directly while chunks were still queued is what made an adopted (staged)
  // job fail every time: begin and finalize are milliseconds apart there, so
  // the worker saw `complete` first, compared 0 received bytes against the
  // announced size and gave up, and the chunks it never got were also gone
  // from `job[track]`, leaving the fallback with nothing ("пустые данные
  // аудио").
  const bridge = {
    worker, ready: false, queue: [], lastTick: Date.now(), settled: false, startedAt: Date.now(),
  };
  job.muxWorker = bridge;
  job.stage = 'mediabunny-stream';

  job.streamMux = new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (bridge.settled) return;
      bridge.settled = true;
      job.muxWorker = null;
      try { worker.terminate(); } catch (e) {}
      fn(value);
    };
    worker.onmessage = (event) => {
      const message = event.data || {};
      bridge.lastTick = Date.now();
      if (message.t === 'ready') {
        bridge.ready = true;
        for (const queued of bridge.queue) worker.postMessage(queued.message, queued.transfer);
        bridge.queue.length = 0;
        return;
      }
      if (message.t === 'progress') {
        if (activeJob === job) {
          job.lastProgressAt = Date.now();
          sendProgress(0.1 + message.value * 0.85, 'Сборка дорожек…');
        }
        return;
      }
      if (message.t === 'tick') return;
      // The parse has begun. Under the old sized source this could not happen
      // before the last byte of a fragmented MP4 had arrived (the parser probes
      // the file's final four bytes for the fragment index), so the mux never
      // truly overlapped the transfer. A small number here is the proof that it
      // now does.
      if (message.t === 'parsing') {
        logToWorker('mux', `stream mux parsing after ${Date.now() - bridge.startedAt} ms`);
        return;
      }
      if (message.t === 'unavailable') {
        logToWorker('mux', `mux worker could not load mediabunny: ${message.message}`);
        settle(reject, new Error(message.message || 'worker не загрузил mediabunny'));
        return;
      }
      if (message.t === 'done') {
        bridge.consumed = message.consumed || null;
        settle(resolve, new Uint8Array(message.bytes));
        return;
      }
      if (message.t === 'error') {
        // The worker hands back what it received; whatever never left this
        // document is still in the queue. Both are needed, and in this order:
        // the worker's chunks came first, the queued ones follow.
        for (const [track, buffers] of [['video', message.video], ['audio', message.audio]]) {
          if (!Array.isArray(buffers)) continue;
          job[track] = buffers.map((buffer) => new Uint8Array(buffer));
        }
        restoreQueuedChunks(job, bridge);
        settle(reject, new Error(message.message || 'сборка в worker не удалась'));
      }
    };
    worker.onerror = (event) => {
      restoreQueuedChunks(job, bridge);
      settle(reject, new Error(`worker сборки завершился аварийно: ${event?.message || 'без сообщения'}`));
    };
    worker.onmessageerror = () => {
      restoreQueuedChunks(job, bridge);
      settle(reject, new Error('worker сборки не смог принять данные'));
    };
  });
  job.streamMux.catch(() => {});

  worker.postMessage({
    t: 'start',
    videoSize: job.streams.video.expected,
    audioSize: job.streams.audio.expected,
  });

  // Adopted staged tracks are already here; hand them over as the first chunks.
  for (const track of ['video', 'audio']) {
    if (!job[track].length) continue;
    for (const bytes of job[track]) sendToMuxWorker(bridge, track, bytes);
    job[track] = [];
  }
}

// One ordered channel to the worker. Before `ready` the messages wait here, so
// a chunk can never end up behind the `complete` that closes its track.
function sendToMuxWorker(bridge, track, bytes) {
  const message = { t: 'chunk', track, bytes: bytes.buffer };
  if (bridge.ready) bridge.worker.postMessage(message, [bytes.buffer]);
  else bridge.queue.push({ message, transfer: [bytes.buffer], track, bytes });
}

function completeMuxWorkerTrack(bridge, track, sent) {
  const message = { t: 'complete', track, sent };
  if (bridge.ready) bridge.worker.postMessage(message);
  else bridge.queue.push({ message, transfer: [] });
}

// Whatever never left this document goes back to the job, so the buffered
// fallback still has the bytes. Idempotent: the queue is drained as it goes.
function restoreQueuedChunks(job, bridge) {
  if (!bridge?.queue?.length) return 0;
  let restored = 0;
  for (const queued of bridge.queue) {
    if (!queued.bytes || (queued.track !== 'video' && queued.track !== 'audio')) continue;
    job[queued.track].push(queued.bytes);
    restored += queued.bytes.length;
  }
  bridge.queue.length = 0;
  return restored;
}

// Feeds one received chunk to the mux worker, or keeps it here when there is
// no worker (mp3, transcode, prefix concat and every fallback path).
function routeChunkToWorker(job, track, bytes) {
  const bridge = job.muxWorker;
  if (!bridge || (track !== 'video' && track !== 'audio')) return false;
  sendToMuxWorker(bridge, track, bytes);
  return true;
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

// Counterpart of the page's encodeBase64. Native fromBase64 is ~5x the atob +
// charCodeAt loop (2.7 ms vs 14.4 ms per 4 MiB chunk). Do NOT "simplify" the
// fallback to Uint8Array.from(atob(v), c => c.charCodeAt(0)): measured 403 ms,
// nearly 30x worse than the explicit loop.
const HAS_NATIVE_BASE64 = typeof Uint8Array.fromBase64 === 'function';

function decodeBase64(value) {
  if (!value) return new Uint8Array(0);
  if (HAS_NATIVE_BASE64) return Uint8Array.fromBase64(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---- track bookkeeping ---------------------------------------------------
// How much of each track has arrived and how much is expected. The bytes
// themselves live in the mux worker while it runs (`mux_worker.js` owns the
// reader), so nothing here needs to address them.
function createTrackStream(chunks, expectedSize) {
  return {
    chunks,
    starts: [],
    received: 0,
    expected: Math.max(0, Number(expectedSize) || 0),
    complete: false,
    failure: null,
  };
}

function completeTrackStream(stream) {
  if (!stream) return;
  stream.complete = true;
}

function failTrackStream(stream, error) {
  if (!stream) return;
  stream.failure = error instanceof Error ? error : new Error(String(error));
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

// A track the assembler had to resync and rebuild keeps a valid ftyp and moov,
// but the bytes between them can hold a partially captured box whose size field
// stops a strict chain walk dead. Look for the box header directly in that case:
// a plausible size in front of the type is enough to tell a real header from the
// four ASCII bytes appearing inside media data.
function scanForMp4Box(bytes, expected, limit) {
  const end = Math.min(bytes.length - 8, limit);
  const [a, b, c, d] = [...expected].map((character) => character.charCodeAt(0));
  for (let offset = 4; offset <= end; offset += 4) {
    if (bytes[offset + 4] !== a || bytes[offset + 5] !== b
      || bytes[offset + 6] !== c || bytes[offset + 7] !== d) continue;
    const size = (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (size >= 8 && size <= bytes.length - offset) return true;
  }
  return false;
}

function hasMp4Box(bytes, expected) {
  if (scanForMp4BoxChain(bytes, expected)) return true;
  return scanForMp4Box(bytes, expected, 16 * 1024 * 1024);
}

function scanForMp4BoxChain(bytes, expected) {
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

// A bare MPEG audio file (Coub's looped soundtrack) starts either with an ID3
// tag or straight with a frame sync — eleven set bits. Without this check a
// truncated or error-page body would only be noticed by ffmpeg, several
// seconds later and with a far less readable message.
function isMpegAudio(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0;
}

function assertContainerHeader(bytes, mime, track) {
  const isWebM = bytes.length >= 4
    && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
  const isMp4 = bytes.length >= 8
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  const validMp4 = isMp4 && hasMp4Box(bytes, 'moov')
    && (hasMp4Box(bytes, 'moof') || hasMp4Box(bytes, 'mdat'));
  if ((/webm/i.test(mime) && !isWebM) || (/mp4/i.test(mime) && !validMp4)
    || (/mpeg|mp3/i.test(mime) && !isMpegAudio(bytes))) {
    const signature = [...bytes.subarray(0, 12)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(' ');
    throw new Error(`повреждён заголовок дорожки ${track} (${mime || 'unknown'}; ${signature || 'empty'})`);
  }
}

function beginJob(message) {
  if (activeJob?.phase === 'receiving' && Date.now() - activeJob.lastActivity > STALE_JOB_MS) {
    // Same reason as in abortJob: the mux worker now begins parsing with the
    // first chunk, so an abandoned receiving job leaves a live worker holding a
    // full copy of both tracks until the document itself is torn down.
    if (activeJob.muxWorker) {
      try { activeJob.muxWorker.worker.terminate(); } catch (e) {}
      activeJob.muxWorker = null;
    }
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
    // One already-muxed stream instead of separate tracks: HLS sites hand over
    // MPEG-TS with audio and video interleaved. It arrives on the video track
    // and there is no companion audio to wait for.
    muxed: Boolean(message.muxed),
    format: message.format || 'mp4',
    audioFormat: ['original', 'mp3', 'm4a', 'aac', 'flac', 'wav'].includes(message.audioFormat)
      ? message.audioFormat : 'mp3',
    videoId: /^[A-Za-z0-9_-]{6,}$/.test(String(message.videoId || '')) ? String(message.videoId) : '',
    audioQuality: message.audioQuality === 'best' ? 'best' : 'standard',
    // Coub-shaped job: a short muted video plus a separate soundtrack that
    // outlasts it. -1 repeats the video until the audio ends, 0 plays it once
    // and cuts the audio to match; null means this is an ordinary job and the
    // paired-audio run set below is not used at all.
    loopVideo: message.loopVideo === -1 || message.loopVideo === 0 ? message.loopVideo : null,
    scaleHeight: Number(message.scaleHeight) || 0,
    duration: Number(message.duration) > 0 ? Number(message.duration) : 0,
    audioCaptureRate: Math.min(4, Math.max(1, Number(message.audioCaptureRate) || 1)),
    lastProgress: 0,
    lastProgressAt: 0,
    stage: 'receiving',
  };
  // Adopt what the page shipped during the capture, per track and only where
  // it said the bytes are the finished file. A size mismatch means something
  // was lost on the way, so that track is transferred again instead.
  const adopt = { audio: false, video: false };
  if (staging && staging.id === message.jobId && Date.now() - staging.at < STAGING_TTL_MS) {
    for (const track of ['audio', 'video']) {
      const declared = Number(track === 'audio' ? message.audioSize : message.videoSize) || 0;
      if (!message.staged?.[track] || !declared) continue;
      if (stagedBytesFor(track) !== declared) continue;
      activeJob[track] = staging[track];
      adopt[track] = true;
    }
  }
  dropStaging();
  activeJob.staged = adopt;
  activeJob.streams = {
    video: createTrackStream(activeJob.video, message.videoSize),
    audio: createTrackStream(activeJob.audio, message.audioSize),
  };
  for (const track of ['audio', 'video']) {
    if (!adopt[track]) continue;
    const stream = activeJob.streams[track];
    for (const part of activeJob[track]) {
      stream.starts.push(stream.received);
      stream.received += part.length;
    }
    completeTrackStream(stream);
  }
  if (adopt.audio || adopt.video) {
    const adoptedBytes = (adopt.audio ? activeJob.streams.audio.received : 0)
      + (adopt.video ? activeJob.streams.video.received : 0);
    logToWorker('transfer', `adopted staged tracks; audio=${adopt.audio}`
      + ` video=${adopt.video} bytes=${adoptedBytes}`);
  }
  // Diagnostics must describe this job only: the tail of a previous run's
  // ffmpeg output otherwise ends up in this job's error report.
  ffmpegLogs.length = 0;
  updateKeepAlive();
  getFFmpeg().catch(() => {}); // warm up while chunks arrive
  startStreamingMux(activeJob);
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
  const bytes = decodeBase64(message.b64);
  const length = bytes.length;
  // Straight to the worker when there is one: it owns the bytes from then on,
  // which is what keeps a single copy in memory. Read the length first — the
  // transfer neuters the view.
  if (!routeChunkToWorker(activeJob, target, bytes)) activeJob[target].push(bytes);
  const stream = activeJob.streams?.[target];
  if (stream) {
    stream.received += length;
    stream.starts.push(stream.received - length);
  }
  activeJob.lastActivity = Date.now();
  return { ok: true };
}

// ---- staging: track bytes that arrive while the capture still runs --------
// The page ships captured parts as they appear, long before it knows whether
// the finished track will be exactly that stream (assembly can still reorder
// or drop parts). Nothing here is trusted: `nova-begin` adopts the staged
// bytes only for the tracks the page verified byte for byte, and the rest is
// transferred the normal way.
const STAGING_TTL_MS = 20 * 60_000;
let staging;

function openStaging(message) {
  if (typeof message.jobId !== 'string' || !message.jobId) {
    return { ok: false, error: 'идентификатор задания отсутствует' };
  }
  staging = { id: message.jobId, video: [], audio: [], bytes: 0, at: Date.now() };
  return { ok: true };
}

function stageChunk(message) {
  if (!staging || staging.id !== message.jobId) return { ok: false, error: 'нет области приёма' };
  if (message.track !== 'video' && message.track !== 'audio') {
    return { ok: false, error: 'неизвестный тип дорожки' };
  }
  const bytes = decodeBase64(message.b64);
  staging[message.track].push(bytes);
  staging.bytes += bytes.length;
  staging.at = Date.now();
  return { ok: true };
}

function dropStaging() {
  staging = undefined;
}

function stagedBytesFor(track) {
  if (!staging) return 0;
  return staging[track].reduce((total, part) => total + part.length, 0);
}

function abortJob(message) {
  if (staging?.id === message.jobId) dropStaging();
  if (activeJob?.id === message.jobId && activeJob.phase === 'receiving') {
    // Release the streaming mux first: its reads are waiting for bytes that
    // will now never arrive, and an abandoned conversion would hold the whole
    // job alive. The worker now starts parsing with the first chunk instead of
    // idling until both tracks are complete, so leaving it running after a
    // cancel would burn a core and hold a full copy of both tracks until the
    // document is torn down.
    const aborted = new Error('загрузка отменена');
    failTrackStream(activeJob.streams?.video, aborted);
    failTrackStream(activeJob.streams?.audio, aborted);
    if (activeJob.muxWorker) {
      try { activeJob.muxWorker.worker.terminate(); } catch (e) {}
      activeJob.muxWorker = null;
    }
    activeJob.video.length = 0;
    activeJob.videoPrefix.length = 0;
    activeJob.audio.length = 0;
    activeJob = undefined;
    updateKeepAlive();
  }
  return { ok: true };
}

function buildRuns(job, videoName, audioName, videoPrefixName, coverName) {
  const progressOutput = ['-progress', 'pipe:1', '-nostats'];
  // Already-muxed input (HLS MPEG-TS): both tracks are in one file and are
  // H.264/AAC, so the whole job is a stream copy into MP4. The retry rebuilds
  // timestamps, which a playlist assembled from separate segments can need.
  if (job.muxed) {
    return [
      {
        out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
        args: [...progressOutput, '-i', videoName, '-c', 'copy',
          '-movflags', '+faststart', 'out.mp4'],
      },
      {
        out: 'repaired.mp4', type: 'video/mp4', extension: '.mp4',
        args: [...progressOutput, '-fflags', '+genpts+igndts', '-i', videoName,
          '-c', 'copy', '-movflags', '+faststart', 'repaired.mp4'],
      },
    ];
  }
  // Coub: a muted H.264 loop plus a soundtrack that is usually many times
  // longer. `-stream_loop -1` repeats the video input and `-shortest` stops at
  // the end of the audio, so the video is copied — never re-encoded — and only
  // the MP3 is converted (MP3 in MP4 is legal but plays badly on Apple devices
  // and in some editors, so it is not stream-copied).
  if (job.loopVideo !== null) {
    const loop = job.loopVideo === -1 ? ['-stream_loop', '-1'] : [];
    const run = (out, extra, videoArgs) => ({
      out, type: 'video/mp4', extension: '.mp4',
      args: [...progressOutput, ...extra, ...loop, '-i', videoName, '-i', audioName,
        '-map', '0:v:0', '-map', '1:a:0', ...videoArgs,
        '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out],
    });
    return [
      run('out.mp4', [], ['-c:v', 'copy']),
      // A fragmented source can come back with timestamps ffmpeg refuses to
      // stitch across loop boundaries; rebuilding them costs nothing.
      run('repaired.mp4', ['-fflags', '+genpts+igndts'], ['-c:v', 'copy']),
      // Last resort. Slow, but a re-encode never inherits a loop-boundary
      // timestamp problem.
      run('reencoded.mp4', ['-fflags', '+genpts'],
        ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '0']),
    ];
  }

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
    const best = job.audioQuality === 'best';
    const encodeRun = (out, type, extension, codecArgs, extraArgs = []) => ({
      out, type, extension,
      args: [...progressOutput, ...audioInput, '-vn', ...restoreDuration,
        ...exactDuration, ...codecArgs, '-threads', '0', ...extraArgs, out],
    });
    // Same encode with the thumbnail attached as the cover picture (ID3 APIC
    // for MP3, covr atom for M4A). Distinct output name: ffmpeg without -y
    // must never collide with the coverless twin that follows it.
    const coverEncodeRun = (out, type, extension, codecArgs, extraArgs = []) => ({
      out: `cover-${out}`, type, extension,
      args: [...progressOutput, ...audioInput, '-i', coverName,
        '-map', '0:a:0', '-map', '1:v:0', ...restoreDuration, ...exactDuration,
        ...codecArgs, '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
        '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
        '-threads', '0', ...extraArgs, `cover-${out}`],
    });
    // Cover runs come first with a coverless twin after each: a rejected
    // thumbnail can never fail the whole job.
    const pushEncoded = (out, type, extension, codecArgs, extraArgs = []) => {
      if (coverName) runs.push(coverEncodeRun(out, type, extension, codecArgs, extraArgs));
      runs.push(encodeRun(out, type, extension, codecArgs, extraArgs));
    };
    const runs = [];
    if (job.audioFormat === 'original' && (job.audioCaptureRate || 1) <= 1.0001) {
      // Passthrough of the source stream: AAC stays in .m4a, Opus/Vorbis go to
      // their native Ogg containers. Encoded fallback below covers copy errors.
      const sourceIsAac = /mp4a|aac/i.test(job.audioMime || '');
      const sourceIsVorbis = /vorbis/i.test(job.audioMime || '');
      const copyOut = sourceIsAac ? 'out.m4a' : (sourceIsVorbis ? 'out.ogg' : 'out.opus');
      const copyType = sourceIsAac ? 'audio/mp4' : 'audio/ogg';
      if (sourceIsAac && coverName) {
        // AAC passthrough into M4A supports the cover; Ogg/Opus does not.
        runs.push({
          out: 'cover-out.m4a', type: copyType, extension: '.m4a',
          args: [...progressOutput, ...audioInput, '-i', coverName,
            '-map', '0:a:0', '-map', '1:v:0', ...exactDuration,
            '-c:a', 'copy', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
            '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
            '-movflags', '+faststart', 'cover-out.m4a'],
        });
      }
      runs.push({
        out: copyOut, type: copyType, extension: `.${copyOut.split('.').pop()}`,
        args: [...progressOutput, ...audioInput, '-vn', ...exactDuration,
          '-c:a', 'copy', ...(sourceIsAac ? ['-movflags', '+faststart'] : []), copyOut],
      });
      pushEncoded('out.m4a', 'audio/mp4', '.m4a',
        ['-c:a', 'aac', '-b:a', '256k'], ['-movflags', '+faststart']);
    } else if (job.audioFormat === 'm4a' || (job.audioFormat === 'original')) {
      pushEncoded('out.m4a', 'audio/mp4', '.m4a',
        ['-c:a', 'aac', '-b:a', best ? '256k' : '192k'], ['-movflags', '+faststart']);
    } else if (job.audioFormat === 'aac') {
      runs.push(encodeRun('out.aac', 'audio/aac', '.aac',
        ['-c:a', 'aac', '-b:a', best ? '256k' : '192k']));
    } else if (job.audioFormat === 'flac') {
      runs.push(encodeRun('out.flac', 'audio/flac', '.flac',
        ['-c:a', 'flac', '-compression_level', '5']));
    } else if (job.audioFormat === 'wav') {
      runs.push(encodeRun('out.wav', 'audio/wav', '.wav', ['-c:a', 'pcm_s16le']));
    } else {
      pushEncoded('out.mp3', 'audio/mpeg', '.mp3',
        ['-c:a', 'libmp3lame', ...(best ? ['-q:a', '0'] : ['-b:a', '192k'])],
        ['-id3v2_version', '3']);
    }
    return runs;
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
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-threads', '0', '-c:a', 'aac', '-b:a', '160k',
        ...exactDuration, '-shortest', '-movflags', '+faststart', 'out.mp4',
      ],
    }];
  }
  if (job.transcode) {
    const scale = job.scaleHeight ? ['-vf', `scale=-2:${job.scaleHeight}`] : [];
    // Single-threaded wasm x264 runs far below realtime, so re-encode only the
    // tracks that actually need it: an H.264 source is stream-copied and AAC
    // audio is stream-copied. 'ultrafast' keeps unavoidable re-encodes usable.
    const videoIsH264 = /avc[13]|h264/i.test(job.videoMime || '');
    const audioIsAac = /mp4a|aac/i.test(job.audioMime || '');
    const videoArgs = (videoIsH264 && !job.scaleHeight)
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', ...scale];
    const audioArgs = audioIsAac ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
    return [{
      out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
      args: [
        ...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        ...videoArgs, '-threads', '0', ...audioArgs,
        '-shortest', '-movflags', '+faststart', 'out.mp4',
      ],
    }];
  }

  // A fragmented-MP4 video track muxed with -c copy can stop at the first
  // fragment boundary ffmpeg dislikes, yielding a short file with exit code 0.
  // The retries below rebuild timestamps and drop -shortest, so a track the
  // demuxer ends early no longer truncates the other one.
  return [
    {
      out: 'out.mp4', type: 'video/mp4', extension: '.mp4',
      args: [...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-strict', '-2', '-shortest', '-movflags', '+faststart', 'out.mp4'],
    },
    {
      out: 'repaired.mp4', type: 'video/mp4', extension: '.mp4',
      args: [...progressOutput, '-fflags', '+genpts+igndts',
        ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', 'repaired.mp4'],
    },
    {
      out: 'out.webm', type: 'video/webm', extension: '.webm',
      args: [...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy', '-shortest', 'out.webm'],
    },
    {
      // Last resort: re-encode the video, which never inherits a broken
      // fragment index. Slow, but it always yields the full length.
      out: 'reencoded.mp4', type: 'video/mp4', extension: '.mp4',
      args: [...progressOutput, ...videoInput, ...audioInput, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-threads', '0', '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', 'reencoded.mp4'],
    },
  ];
}

// Duration of a finished MP4/WebM, read straight from the container. A stream
// copy can silently stop at a bad fragment boundary and produce a short file
// with exit code 0 — that must not reach the user as "готово".
// EBML numbers are variable width: the leading zero bits of the first byte give
// the total length. IDs keep their marker bit so they compare against the
// spec's constants; sizes have it stripped.
function readEbmlNumber(bytes, offset, stripMarker) {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = stripMarker ? (first & (mask - 1)) : first;
  for (let index = 1; index < length; index++) value = (value * 256) + bytes[offset + index];
  return { value, length };
}

// Matroska keeps the playable length in Segment > Info > Duration, expressed in
// TimecodeScale units. A captured stream often declares Segment with unknown
// size, which simply means "to the end of the file".
function webmDurationSeconds(bytes) {
  const SEGMENT = 0x18538067;
  const INFO = 0x1549a966;
  const TIMECODE_SCALE = 0x2ad7b1;
  const DURATION = 0x4489;
  let scale = 1_000_000;
  let duration = null;

  const walk = (start, end, depth) => {
    let offset = start;
    while (offset < end && duration === null) {
      const id = readEbmlNumber(bytes, offset, false);
      if (!id) return;
      const size = readEbmlNumber(bytes, offset + id.length, true);
      if (!size) return;
      const contentStart = offset + id.length + size.length;
      const contentEnd = Math.min(end, contentStart + size.value);
      if (contentEnd <= offset) return;
      if (id.value === SEGMENT || id.value === INFO) {
        if (depth >= 3) return;
        walk(contentStart, contentEnd, depth + 1);
      } else if (id.value === TIMECODE_SCALE) {
        let raw = 0;
        for (let index = contentStart; index < contentEnd; index++) raw = (raw * 256) + bytes[index];
        if (raw > 0) scale = raw;
      } else if (id.value === DURATION) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + contentStart, contentEnd - contentStart);
        if (size.value === 4) duration = view.getFloat32(0);
        else if (size.value === 8) duration = view.getFloat64(0);
      }
      offset = contentEnd;
    }
  };

  walk(0, bytes.length, 0);
  return duration > 0 ? (duration * scale) / 1e9 : null;
}

function findBytes(haystack, needle, from, limit) {
  const end = Math.min(haystack.length - needle.length, limit);
  for (let index = from; index <= end; index++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) { matched = false; break; }
    }
    if (matched) return index;
  }
  return -1;
}

// Ogg carries the length only as the granule position of the final page. Opus
// counts granules at 48 kHz regardless of the source rate, and the ID header's
// pre-skip is decoder priming rather than playable audio.
function oggDurationSeconds(bytes) {
  const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
  const opusHead = findBytes(bytes, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0, 65_536);
  if (opusHead < 0 || opusHead + 12 > bytes.length) return null; // Vorbis: rate not read here
  const preSkip = bytes[opusHead + 10] + (bytes[opusHead + 11] * 256);
  let pageStart = -1;
  for (let index = bytes.length - 4; index >= 0; index--) {
    if (bytes[index] === CAPTURE[0] && bytes[index + 1] === CAPTURE[1]
      && bytes[index + 2] === CAPTURE[2] && bytes[index + 3] === CAPTURE[3]) {
      pageStart = index;
      break;
    }
  }
  if (pageStart < 0 || pageStart + 14 > bytes.length) return null;
  let granule = 0;
  for (let index = 7; index >= 0; index--) granule = (granule * 256) + bytes[pageStart + 6 + index];
  const samples = granule - preSkip;
  return samples > 0 ? samples / 48_000 : null;
}

function containerDurationSeconds(bytes) {
  try {
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return webmDurationSeconds(bytes);
    }
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
      return oggDurationSeconds(bytes);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const walk = (start, end, depth) => {
      let offset = start;
      while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5],
          bytes[offset + 6], bytes[offset + 7]);
        let header = 8;
        if (size === 1) {
          size = Number(view.getBigUint64(offset + 8));
          header = 16;
        }
        if (size === 0) size = end - offset;
        if (size < 8) return null;
        if (type === 'mvhd') {
          const version = bytes[offset + header];
          const timescale = version === 1
            ? view.getUint32(offset + header + 20) : view.getUint32(offset + header + 12);
          const duration = version === 1
            ? Number(view.getBigUint64(offset + header + 24)) : view.getUint32(offset + header + 16);
          return timescale > 0 ? duration / timescale : null;
        }
        if (type === 'moov' && depth < 2) {
          const found = walk(offset + header, offset + size, depth + 1);
          if (found !== null) return found;
        }
        offset += size;
      }
      return null;
    };
    return walk(0, bytes.length, 0);
  } catch (error) {
    return null;
  }
}

function outputDurationMismatch(job, bytes) {
  if (job.format === 'mp3' || !(job.duration > 10)) return '';
  const actual = containerDurationSeconds(bytes);
  if (actual === null || !(actual > 0)) return '';
  if (actual >= job.duration * 0.9) return '';
  return `собранный файл длится ${actual.toFixed(1)} сек вместо ${job.duration.toFixed(1)} сек`;
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
  // The probe assumes 192k CBR; VBR and other codecs have no fixed byte rate.
  if (job.format !== 'mp3' || job.audioFormat !== 'mp3' || job.audioQuality === 'best'
    || !(job.duration > 10) || !bytes?.length) return '';
  const encodedSeconds = bytes.length / MP3_BYTES_PER_SECOND;
  const tolerance = Math.max(3, job.duration * 0.01);
  if (Math.abs(encodedSeconds - job.duration) <= tolerance) return '';
  return `MP3 получился ${encodedSeconds.toFixed(1)} сек вместо ${job.duration.toFixed(1)} сек`
    + ' — часть аудиодорожки не была захвачена';
}

// ---- recovery store ------------------------------------------------------
// A finished file must never be lost because the browser end of the pipe was
// momentarily unavailable. When chrome.downloads cannot be reached, the
// output is parked in OPFS and handed over on the next flush — automatic at
// the start of every session, or on demand from the popup.
const RECOVERY_DIR = 'nvs-recovered';
const RECOVERY_KEY = 'nova_recovered';
const RECOVERY_KEEP_MS = 10 * 60_000;
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RECOVERY_MAX_BYTES = 4 * 1024 * 1024 * 1024;

async function recoveryDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECOVERY_DIR, { create: true });
}

async function readRecoveryIndex() {
  const stored = await chrome.storage.local.get(RECOVERY_KEY).catch(() => ({}));
  return Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [];
}

async function writeRecoveryIndex(entries) {
  await chrome.storage.local.set({ [RECOVERY_KEY]: entries }).catch(() => {});
}

async function stashForRecovery(blob, filename) {
  const dir = await recoveryDirectory();
  const id = `${Date.now()}-${Math.round(Math.random() * 1e9).toString(36)}.bin`;
  const handle = await dir.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    await dir.removeEntry(id).catch(() => {});
    throw error;
  }
  const entries = await readRecoveryIndex();
  entries.push({
    id, filename, type: blob.type || '', bytes: blob.size, createdAt: Date.now(), savedAt: 0,
  });
  await writeRecoveryIndex(entries);
  logToWorker('recovery', `parked finished file for later saving; file=${filename} bytes=${blob.size}`);
  return id;
}

// Hands every parked file to chrome.downloads and prunes what is already
// gone. Entries handed over stay listed for RECOVERY_KEEP_MS: chrome.downloads
// reads the object URL asynchronously, so deleting the OPFS file immediately
// would break the download it just accepted.
let recoveryFlush = Promise.resolve();

// Creating this document starts a flush on its own, and the worker asks for
// one right after: overlapping passes would read the same index and hand the
// same file to chrome.downloads twice.
function flushRecoveredFiles() {
  recoveryFlush = recoveryFlush.catch(() => {}).then(() => runRecoveryFlush());
  return recoveryFlush;
}

async function runRecoveryFlush() {
  const entries = await readRecoveryIndex();
  if (!entries.length) return { ok: true, saved: 0, pending: 0 };
  let dir;
  try {
    dir = await recoveryDirectory();
  } catch (error) {
    return { ok: false, saved: 0, pending: entries.length, error: String(error?.message || error) };
  }
  const remaining = [];
  let saved = 0;
  let failed = '';
  for (const entry of entries) {
    const expired = Date.now() - Number(entry.createdAt || 0) > RECOVERY_MAX_AGE_MS;
    const handedOver = entry.savedAt && Date.now() - Number(entry.savedAt) > RECOVERY_KEEP_MS;
    if (expired || handedOver) {
      await dir.removeEntry(entry.id).catch(() => {});
      continue;
    }
    if (entry.savedAt) {
      remaining.push(entry);
      continue;
    }
    let file;
    try {
      file = await (await dir.getFileHandle(entry.id)).getFile();
    } catch (error) {
      // The parked file is gone (storage cleared, profile reset): drop the
      // entry rather than advertising a file that can never be saved.
      logToWorker('recovery', `parked file missing, dropping entry; file=${entry.filename}`);
      continue;
    }
    try {
      if (!file.size) throw new Error('файл восстановления пуст');
      await saveBlob(file, entry.filename);
      saved++;
      remaining.push({ ...entry, savedAt: Date.now() });
      logToWorker('recovery', `saved parked file; file=${entry.filename} bytes=${file.size}`);
    } catch (error) {
      failed = String(error?.message || error);
      remaining.push(entry);
    }
  }
  await writeRecoveryIndex(remaining);
  const pending = remaining.filter((entry) => !entry.savedAt).length;
  return { ok: !pending, saved, pending, ...(failed ? { error: failed } : {}) };
}

// Single exit for every finished file: retry the handover, and only if the
// browser stays unreachable park the result instead of discarding it.
async function deliverOutput(blob, filename) {
  try {
    await saveBlob(blob, filename);
    return;
  } catch (error) {
    // Parking duplicates the file on disk, so multi-gigabyte live recordings
    // are reported instead: their source tracks are still in OPFS.
    if (!isWorkerAsleep(error) || blob.size > RECOVERY_MAX_BYTES) throw error;
    let parked = false;
    try {
      await stashForRecovery(blob, filename);
      parked = true;
    } catch (stashError) {
      logToWorker('recovery', `could not park finished file: ${String(stashError?.message || stashError)}`);
    }
    if (!parked) throw error;
    const failure = new Error('браузер не принял файл на сохранение (служебный процесс расширения был'
      + ' перезапущен). Готовый файл сохранён во временном хранилище — откройте значок NVS и нажмите'
      + ' «Сохранить готовый файл».');
    failure.recovered = true;
    throw failure;
  }
}

async function finalizeJob(message) {
  if (!activeJob || activeJob.phase !== 'receiving' || message.jobId !== activeJob.id) {
    throw new Error('задание загрузки не найдено');
  }

  const job = activeJob;
  job.phase = 'processing';
  job.stage = 'engine';
  const files = new Set();
  let instance;

  try {
    sendProgress(0.02, 'Инициализация движка кодирования…');
    instance = await getFFmpeg();

    job.stage = 'buffers';
    sendProgress(0.06, 'Подготовка буферов дорожек…');

    let output;
    let selectedRun;
    let lastError = '';

    // The streaming mux has been running since the first chunks arrived, so by
    // now it is usually all but finished. Telling it the tracks are complete is
    // the last thing it waits for. Everything below — concatenation, header
    // checks, ffmpeg inputs — exists only for the paths it cannot take, and is
    // skipped entirely when it succeeds: that is a full copy of each track not
    // allocated.
    if (job.streamMux) {
      completeTrackStream(job.streams.video);
      completeTrackStream(job.streams.audio);
      for (const track of ['video', 'audio']) {
        try {
          if (job.muxWorker) {
            completeMuxWorkerTrack(job.muxWorker, track, job.streams[track].received);
          }
        } catch (e) {}
      }
      const startedWaitingAt = Date.now();
      // A wedged conversion must not hold the download forever: the worker
      // reports progress for both tracks, so silence is the signal.
      let stallTimer;
      const stallGuard = new Promise((_, rejectStall) => {
        const check = () => {
          if (Date.now() - (job.muxWorker?.lastTick || startedWaitingAt) > 120_000) {
            rejectStall(new Error('сборка не показывает прогресс более 120 секунд'));
            return;
          }
          stallTimer = setTimeout(check, 5_000);
        };
        stallTimer = setTimeout(check, 5_000);
      });
      const bridgeAtStart = job.muxWorker;
      try {
        output = await Promise.race([job.streamMux, stallGuard]);
        const short = outputDurationMismatch(job, output);
        if (short) throw new Error(short);
        // A copy remux writes out what it read, give or take container
        // overhead. Measured failure: 62.8 MB of tracks came back as a 14.4 MB
        // file whose header still claimed the full 700 s, so the duration check
        // waved it through and the user got a video missing most of its frames.
        const inputBytes = job.streams.video.received + job.streams.audio.received;
        const consumed = bridgeAtStart?.consumed;
        if (inputBytes > 0 && output.length < inputBytes * 0.8) {
          throw new Error(`сборка вернула ${output.length} байт из ${inputBytes}`
            + ` (прочитано video=${consumed?.video ?? '?'} audio=${consumed?.audio ?? '?'})`);
        }
        selectedRun = { out: 'mediabunny.mp4', type: 'video/mp4', extension: '.mp4' };
        logToWorker('mux', `mediabunny worker-remux ok; bytes=${output.length}`
          + ` input=${inputBytes} consumed=${consumed?.video ?? '?'}+${consumed?.audio ?? '?'}`
          + ` duration=${(containerDurationSeconds(output) || 0).toFixed(1)}`
          + ` muxAfterTransfer=${((Date.now() - startedWaitingAt) / 1000).toFixed(1)}s`);
      } catch (error) {
        output = undefined;
        try { job.muxWorker?.worker.postMessage({ t: 'cancel' }); } catch (e) {}
        // A stall or a rejected output leaves the bridge alive with bytes still
        // queued; the buffered path below needs them back.
        const restored = restoreQueuedChunks(job, bridgeAtStart);
        logToWorker('mux', `stream remux unavailable, falling back: ${String(error?.message || error)}`
          + (restored ? `; вернули из очереди ${restored} байт` : ''));
      } finally {
        clearTimeout(stallTimer);
      }
    }

    const inputs = [];
    let audioName = null;
    let audioBytes = null;
    let videoName;
    let videoPrefixName;
    let videoBytes = null;
    let coverName = null;
    if (!selectedRun) {
      // A muxed job carries everything on the video track; there is no separate
      // audio buffer to validate or hand to ffmpeg.
      audioName = job.muxed ? null : `audio.${extensionFor(job.audioMime)}`;
      audioBytes = job.muxed ? null : concatParts(job.audio);
      if (!job.muxed) {
        if (!audioBytes.length) throw new Error('пустые данные аудио');
        assertContainerHeader(audioBytes, job.audioMime, 'audio');
        inputs.push({ name: audioName, bytes: audioBytes });
        files.add(audioName);
      }

      if (job.muxed) {
        videoName = 'input.ts';
        videoBytes = concatParts(job.video);
        if (!videoBytes.length) throw new Error('пустые данные потока');
        // MPEG-TS has no ftyp/EBML header to check; its packets start with 0x47.
        if (videoBytes[0] !== 0x47) throw new Error('поток не является MPEG-TS');
        inputs.push({ name: videoName, bytes: videoBytes });
        files.add(videoName);
      } else if (job.format !== 'mp3') {
        videoName = `video.${extensionFor(job.videoMime)}`;
        videoBytes = concatParts(job.video);
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

      // The chunks have just been concatenated into one buffer per track and
      // nothing reads them again — every path below works from
      // `videoBytes`/`audioBytes`. Holding both copies doubled this document's
      // footprint on a long video.
      job.video.length = 0;
      job.videoPrefix.length = 0;
      job.audio.length = 0;

      // Thumbnail as embedded cover art for audio outputs that support pictures.
      // Best effort: any failure just means a coverless file.
      if (job.format === 'mp3' && job.videoId
        && ['original', 'mp3', 'm4a'].includes(job.audioFormat)) {
        sendProgress(0.07, 'Загрузка обложки…');
        const cover = await sendToWorker({ t: 'nova-fetch-cover', videoId: job.videoId }, { retries: 3 })
          .catch(() => null);
        if (cover?.ok && cover.b64) {
          try {
            inputs.push({ name: 'cover.jpg', bytes: decodeBase64(cover.b64) });
            files.add('cover.jpg');
            coverName = 'cover.jpg';
          } catch (error) { coverName = null; }
        }
      }
    }
    // Hardware path first: only for plain transcode jobs (no prefix concat,
    // no downscale — those still need ffmpeg's filter graph).
    if (job.format !== 'mp3' && job.transcode && !videoPrefixName && !job.scaleHeight && videoBytes) {
      job.stage = 'webcodecs';
      sendProgress(0.08, 'Запуск аппаратного перекодирования…');
      try {
        output = await tryWebcodecsTranscode(job, videoBytes, audioBytes);
        const shortOutput = outputDurationMismatch(job, output);
        if (shortOutput) throw new Error(shortOutput);
        selectedRun = { out: 'webcodecs.mp4', type: 'video/mp4', extension: '.mp4' };
      } catch (error) {
        output = undefined;
        logToWorker('webcodecs',
          `hardware transcode unavailable, falling back to ffmpeg: ${String(error?.message || error)}`);
      }
    }

    // Plain (non-transcoding) mux of a captured video: Mediabunny first. Its
    // fragment-aware copy avoids the truncated files ffmpeg's stream copy
    // produces for fMP4 video paired with WebM audio.
    // Mediabunny reads fMP4 and WebM, not MPEG-TS: a muxed job goes straight to
    // ffmpeg rather than paying for a parse that cannot succeed.
    if (!selectedRun && job.format !== 'mp3' && !job.transcode && !videoPrefixName
      && !job.scaleHeight && !job.muxed && job.loopVideo === null && videoBytes) {
      job.stage = 'mediabunny';
      sendProgress(0.08, 'Сборка дорожек…');
      try {
        // In memory, not through a Blob: a Blob-backed source answers every one
        // of mediabunny's tens of thousands of reads asynchronously, and the
        // Blob is one more full copy of the track.
        const { BufferSource } = await getMediabunny();
        output = await muxVodWithMediabunny(
          job,
          new BufferSource(videoBytes.buffer),
          new BufferSource(audioBytes.buffer),
        );
        selectedRun = { out: 'mediabunny.mp4', type: 'video/mp4', extension: '.mp4' };
        logToWorker('mux', `mediabunny copy-remux ok; bytes=${output.length}`
          + ` duration=${(containerDurationSeconds(output) || 0).toFixed(1)}`);
      } catch (error) {
        output = undefined;
        logToWorker('mux', `mediabunny copy-remux unavailable, using ffmpeg: ${String(error?.message || error)}`);
      }
    }

    if (!selectedRun) {
      job.stage = 'ffmpeg-write';
      await writeInputFiles(instance, inputs);
    }
    for (const run of selectedRun ? [] : buildRuns(job, videoName, audioName, videoPrefixName, coverName)) {
      ffmpegLogs.length = 0;
      job.integrityError = '';
      job.lastProgress = 0;
      job.lastProgressAt = Date.now();
      job.stage = `ffmpeg:${run.out}`;
      sendProgress(0, processingStatus(job), 0);
      files.add(run.out);
      const exitCode = await execWithProgressWatchdog(instance, run.args, job, SINGLE_THREAD_STALL_MS);
      const integrityError = job.integrityError || ffmpegIntegrityError(ffmpegLogs);
      let lengthError = '';
      if (exitCode === 0 && !integrityError) {
        const candidate = await instance.readFile(run.out).catch(() => null);
        if (candidate?.length) {
          lengthError = mp3LengthMismatch(job, candidate) || outputDurationMismatch(job, candidate);
          if (!lengthError) {
            output = candidate;
            selectedRun = run;
            break;
          }
          logToWorker('ffmpeg', `run ${run.out} rejected: ${lengthError}`);
        }
      }
      lastError = integrityError || lengthError
        || `ffmpeg код ${exitCode}: ${ffmpegLogs.slice(-6).join(' | ')}`;
    }

    if (!selectedRun) throw new Error(lastError || 'ffmpeg не собрал файл');
    logToWorker('mux', `output ready; run=${selectedRun.out} bytes=${output.length}`
      + ` duration=${(containerDurationSeconds(output) || 0).toFixed(1)} expected=${(job.duration || 0).toFixed(1)}`
      + ` file=${job.filename}`);
    job.stage = 'saving';
    sendProgress(0.97, 'Подготовка файла к сохранению…', 97);

    const filename = job.filename.replace(/\.(mp4|webm|mp3|m4a|aac|flac|wav|ogg|opus)$/i, '') + selectedRun.extension;
    await deliverOutput(new Blob([output], { type: selectedRun.type }), filename);
    job.stage = 'saved';
    sendProgress(1, 'Файл передан браузеру…', 100);
    return { ok: true, filename };
  } catch (error) {
    error.details = {
      stage: job.stage,
      format: job.format,
      transcode: job.transcode,
      scaleHeight: job.scaleHeight,
      audioMime: job.audioMime,
      videoMime: job.videoMime,
      // Only meaningful once an ffmpeg run has actually started; the array is
      // cleared per job so a previous job's tail can no longer masquerade as
      // the cause of this failure.
      ffmpegLogs: String(job.stage || '').startsWith('ffmpeg') ? ffmpegLogs.slice(-10) : [],
      ffmpegMode,
      ...(error?.recovered ? { recovered: true } : {}),
    };
    throw error;
  } finally {
    if (instance) {
      for (const name of files) {
        try { await instance.deleteFile(name); } catch (e) {}
      }
    }
    // A worker still parsing (or waiting for bytes that will never come) would
    // otherwise outlive its job and keep its copy of the track.
    if (job.muxWorker) {
      try { job.muxWorker.worker.terminate(); } catch (e) {}
      job.muxWorker = null;
    }
    job.video.length = 0;
    job.videoPrefix.length = 0;
    job.audio.length = 0;
    if (activeJob === job) activeJob = undefined;
    updateKeepAlive();
  }
}

// ---- live recording jobs -------------------------------------------------
// Live fragments stream into OPFS as they arrive, so page and offscreen RAM
// stay flat no matter how long the broadcast runs. Finalize muxes both track
// files with stream copy; recordings too large for the wasm filesystem are
// saved as separate video/audio files instead of failing.
const LIVE_DIR = 'nvs-live';
const LIVE_MAX_BYTES = 24 * 1024 * 1024 * 1024;
const LIVE_MUX_LIMIT = 1_400_000_000;
const LIVE_MEMFS_FALLBACK_LIMIT = 700_000_000;
const liveJobs = new Map();

async function liveDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LIVE_DIR, { create: true });
}

async function cleanupStaleLiveFiles() {
  try {
    const dir = await liveDirectory();
    for await (const name of dir.keys()) {
      const activeJob = [...liveJobs.values()].some((job) => name.startsWith(job.id));
      if (!activeJob) await dir.removeEntry(name).catch(() => {});
    }
  } catch (error) { /* OPFS unavailable: live begin will report it */ }
}
cleanupStaleLiveFiles();

const LIVE_STALE_MS = 10 * 60_000;

async function evictStaleLiveJobs() {
  for (const [jobId, job] of [...liveJobs]) {
    if (Date.now() - job.lastActivity <= LIVE_STALE_MS) continue;
    // The recording tab is gone (closed/crashed) and can never abort its job;
    // release the slot so future recordings are not blocked until restart.
    liveJobs.delete(jobId);
    await closeLiveWriters(job).catch(() => {});
    await removeLiveFiles(job);
  }
}

function beginLiveJob(message) {
  if (typeof message.jobId !== 'string' || !message.jobId) {
    return { ok: false, error: 'идентификатор записи отсутствует' };
  }
  if (!Number.isInteger(message.tabId)) return { ok: false, error: 'вкладка записи не определена' };
  if (liveJobs.has(message.jobId)) return { ok: false, error: 'эта запись уже начата' };
  if (liveJobs.size >= 2) return { ok: false, error: 'слишком много одновременных записей эфира' };
  liveJobs.set(message.jobId, {
    id: message.jobId,
    tabId: message.tabId,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    files: {},
    writers: {},
    writeChain: {},
    mimes: {},
    bytes: { video: 0, audio: 0 },
  });
  updateKeepAlive();
  getFFmpeg().catch(() => {});
  return { ok: true };
}

async function liveWriter(job, track) {
  if (!job.writers[track]) {
    const dir = await liveDirectory();
    job.files[track] = await dir.getFileHandle(`${job.id}-${track}.bin`, { create: true });
    job.writers[track] = await job.files[track].createWritable();
  }
  return job.writers[track];
}

function appendLiveChunk(message) {
  const job = liveJobs.get(message.jobId);
  if (!job) return Promise.resolve({ ok: false, error: 'запись эфира не найдена' });
  const track = message.track === 'audio' ? 'audio' : 'video';
  if (message.mime && !job.mimes[track]) job.mimes[track] = String(message.mime);
  let bytes;
  try {
    bytes = decodeBase64(message.b64);
  } catch (error) {
    return Promise.resolve({ ok: false, error: `повреждённый фрагмент: ${String(error?.message || error)}` });
  }
  if (job.bytes.video + job.bytes.audio + bytes.length > LIVE_MAX_BYTES) {
    return Promise.resolve({ ok: false, error: 'превышен предельный размер записи (24 ГБ)' });
  }
  job.lastActivity = Date.now();
  // Per-track write chain keeps fragments ordered and gives the sender real
  // backpressure: the response is sent only after the bytes are on disk.
  job.writeChain[track] = (job.writeChain[track] || Promise.resolve()).then(async () => {
    const writer = await liveWriter(job, track);
    await writer.write(bytes);
    job.bytes[track] += bytes.length;
  });
  return job.writeChain[track]
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function closeLiveWriters(job) {
  for (const track of Object.keys(job.writers)) {
    await job.writeChain[track]?.catch(() => {});
    await job.writers[track].close().catch(() => {});
  }
  job.writers = {};
}

async function removeLiveFiles(job) {
  try {
    const dir = await liveDirectory();
    for (const track of Object.keys(job.files)) {
      await dir.removeEntry(`${job.id}-${track}.bin`).catch(() => {});
    }
  } catch (error) {}
}

async function abortLiveJob(message) {
  const job = liveJobs.get(message.jobId);
  if (!job) return { ok: true };
  liveJobs.delete(message.jobId);
  updateKeepAlive();
  await closeLiveWriters(job).catch(() => {});
  await removeLiveFiles(job);
  return { ok: true };
}

// The service worker owns chrome.downloads, so this is the one hop a finished
// file cannot avoid. It is also the hop that used to lose entire downloads to
// a worker restart, hence the retry budget.
async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let accepted = false;
  try {
    const response = await sendToWorker({ t: 'nova-save', url, filename },
      { retries: WORKER_RETRY_DELAYS.length });
    if (!response?.ok) throw new Error(response?.error || 'не удалось сохранить файл');
    accepted = true;
  } finally {
    if (accepted) setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
    else URL.revokeObjectURL(url);
  }
}

function liveContainerExtension(mime) {
  return /mp4/i.test(mime || '') ? 'mp4' : 'webm';
}

// Direct progress for live muxing: it does not use the shared ffmpeg activeJob
// slot, so it reports with its own tab/job ids.
function sendLiveProgress(job, value, status) {
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  notifyWorker({
    t: 'nova-progress',
    tabId: job.tabId,
    jobId: job.id,
    value: progress,
    percent: progress * 100,
    ...(status ? { status } : {}),
  }, 0);
}

// Primary live mux: Mediabunny stream-copies both OPFS track files into one
// container, writing the result straight back to OPFS. No wasm filesystem, no
// 1.4 GB ceiling, runs at disk speed — the recording ends up in the browser's
// downloads as a single ordinary file.
async function muxLiveWithMediabunny(job, tracks, baseName) {
  const {
    Input, Output, Conversion, ALL_FORMATS, BlobSource, StreamTarget,
    Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  } = await getMediabunny();
  const videoIsMp4 = /mp4/i.test(job.mimes.video || '');
  const audioIsMp4 = /mp4/i.test(job.mimes.audio || '');
  // Matching containers keep their native format; mixed pairs (e.g. VP9 WebM
  // video + AAC fMP4 audio, common on live) go into MKV, which stream-copies
  // both codecs instead of forcing a transcode or a discard.
  let format;
  let extension;
  if (videoIsMp4 && audioIsMp4) {
    format = new Mp4OutputFormat();
    extension = '.mp4';
  } else if (!videoIsMp4 && !audioIsMp4) {
    format = new WebMOutputFormat();
    extension = '.webm';
  } else {
    format = new MkvOutputFormat();
    extension = '.mkv';
  }
  const dir = await liveDirectory();
  const outHandle = await dir.getFileHandle(`${job.id}-out${extension}`, { create: true });
  const fsWritable = await outHandle.createWritable();
  let fsClosed = false;
  const target = new StreamTarget(new WritableStream({
    write: (chunk) => fsWritable.write({ type: 'write', position: chunk.position, data: chunk.data }),
    close: async () => {
      fsClosed = true;
      await fsWritable.close();
    },
  }), { chunked: true });
  const output = new Output({ format, target });
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(tracks.video) });
  const audioInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(tracks.audio) });
  // No codec forced: compatible tracks are stream-copied; a genuinely
  // incompatible one would transcode through WebCodecs instead of failing.
  const videoConversion = await Conversion.init({
    input: videoInput, output, composable: true, audio: { discard: true },
  });
  const audioConversion = await Conversion.init({
    input: audioInput, output, composable: true, video: { discard: true },
  });
  const discarded = [...videoConversion.discardedTracks, ...audioConversion.discardedTracks];
  if (discarded.length) {
    throw new Error(`дорожка не поддерживается: ${discarded.map((entry) => entry.reason).join(', ')}`);
  }
  let lastTick = Date.now();
  videoConversion.onProgress = (progress) => {
    lastTick = Date.now();
    sendLiveProgress(job, 0.1 + Math.max(0, Math.min(1, progress)) * 0.85, 'Склейка записи эфира…');
  };
  audioConversion.onProgress = () => { lastTick = Date.now(); };
  let stallTimer;
  const stallGuard = new Promise((_, reject) => {
    const check = () => {
      if (Date.now() - lastTick > 180_000) {
        reject(new Error('склейка записи не показывает прогресс более 180 секунд'));
        return;
      }
      stallTimer = setTimeout(check, 5_000);
    };
    stallTimer = setTimeout(check, 5_000);
  });
  try {
    await output.start();
    await Promise.race([
      Promise.all([videoConversion.execute(), audioConversion.execute()]),
      stallGuard,
    ]);
    await output.finalize();
    if (!fsClosed) await fsWritable.close().catch(() => {});
  } catch (error) {
    await videoConversion.cancel?.().catch(() => {});
    await audioConversion.cancel?.().catch(() => {});
    try {
      if (output.state === 'started' || output.state === 'pending') await output.cancel();
    } catch (cancelError) {}
    if (!fsClosed) await fsWritable.abort?.().catch(() => {});
    await dir.removeEntry(`${job.id}-out${extension}`).catch(() => {});
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
  const outFile = await outHandle.getFile();
  const inputBytes = tracks.video.size + tracks.audio.size;
  // A structurally "successful" mux that copied almost no packets (unreadable
  // input) must not swallow the recording: fall back to ffmpeg/split files.
  if (!outFile.size || outFile.size < inputBytes * 0.05) {
    await dir.removeEntry(`${job.id}-out${extension}`).catch(() => {});
    throw new Error(`склейка записала подозрительно мало данных (${outFile.size} из ${inputBytes} байт)`);
  }
  logToWorker('live', `mediabunny mux ok; out=${extension} bytes=${outFile.size}`
    + ` video=${tracks.video.size} audio=${tracks.audio.size}`);
  const filename = `${baseName}${extension}`;
  sendLiveProgress(job, 0.97, 'Подготовка файла к сохранению…');
  await deliverOutput(outFile, filename);
  sendLiveProgress(job, 1, 'Файл передан браузеру…');
  return filename;
}

async function finalizeLiveJob(message) {
  const job = liveJobs.get(message.jobId);
  if (!job) throw new Error('запись эфира не найдена');
  liveJobs.delete(message.jobId);
  // The job left the registry, but muxing an hours-long recording still needs
  // the service worker awake to accept the finished file.
  busyFinalizers++;
  updateKeepAlive();
  const baseName = String(message.filename || 'live.mp4').replace(/\.(mp4|webm|mp3|m4a|mkv)$/i, '');
  try {
    await closeLiveWriters(job);
    const tracks = {};
    for (const track of Object.keys(job.files)) {
      const file = await job.files[track].getFile();
      if (file.size > 0) tracks[track] = file;
    }
    if (!tracks.video && !tracks.audio) throw new Error('запись не содержит медиаданных');

    // Single-track broadcast (or one track never arrived): save it as-is,
    // with an explicit suffix so an audio-only file is never mistaken for a
    // broken video.
    if (!tracks.video || !tracks.audio) {
      const track = tracks.video ? 'video' : 'audio';
      const extension = liveContainerExtension(job.mimes[track]);
      const filename = `${baseName}.${track === 'audio' ? 'audio' : 'video'}.${extension}`;
      await deliverOutput(tracks[track], filename);
      return { ok: true, filename, singleTrack: track };
    }

    try {
      const filename = await muxLiveWithMediabunny(job, tracks, baseName);
      // The saved download streams from the OPFS output file; the source track
      // files are no longer needed. The output itself is cleaned next session.
      await removeLiveFiles(job);
      return { ok: true, filename };
    } catch (error) {
      // A refused handover is not a mux failure: the file is already parked
      // for recovery and re-muxing it would only duplicate the work.
      if (error?.recovered) throw error;
      await logToWorker('live', `mediabunny mux failed, trying ffmpeg: ${String(error?.message || error)}`);
    }

    const totalBytes = tracks.video.size + tracks.audio.size;
    if (totalBytes <= LIVE_MUX_LIMIT && !activeJob) {
      // Claim the shared processing slot synchronously: getFFmpeg() inside
      // muxLiveTracks can await for seconds and a VOD nova-begin arriving in
      // that window must not clobber this job (or vice versa).
      activeJob = {
        id: job.id,
        tabId: job.tabId,
        phase: 'processing',
        format: 'live',
        transcode: false,
        scaleHeight: 0,
        duration: Number(message.duration) > 0 ? Number(message.duration) : 0,
        lastProgress: 0,
        lastProgressAt: Date.now(),
      };
      try {
        const filename = await muxLiveTracks(job, tracks, baseName);
        await removeLiveFiles(job);
        return { ok: true, filename };
      } catch (error) {
        if (error?.recovered) throw error;
        // Fall through to the split-file path: the recording itself is intact.
        await logToWorker('live', `mux failed, saving split files: ${String(error?.message || error)}`);
      }
    }

    const videoName = `${baseName}.video.${liveContainerExtension(job.mimes.video)}`;
    const audioName = `${baseName}.audio.${liveContainerExtension(job.mimes.audio)}`;
    await deliverOutput(tracks.video, videoName);
    await deliverOutput(tracks.audio, audioName);
    // The object URLs above read straight from OPFS-backed files; deleting the
    // files immediately could break the pending downloads, so cleanup happens
    // on the next live recording / offscreen start instead.
    return { ok: true, split: true, filename: videoName };
  } catch (error) {
    // A parked recording still lives in OPFS; wiping the source files here
    // would be harmless, but the user is told the file survived, so keep the
    // storage footprint honest and only clear what is no longer referenced.
    if (!error?.recovered) await removeLiveFiles(job).catch(() => {});
    error.details = {
      live: true,
      bytes: job.bytes,
      mimes: job.mimes,
      ffmpegLogs: ffmpegLogs.slice(-10),
      ...(error?.recovered ? { recovered: true } : {}),
    };
    throw error;
  } finally {
    busyFinalizers = Math.max(0, busyFinalizers - 1);
    updateKeepAlive();
  }
}

async function muxLiveTracks(job, tracks, baseName) {
  // activeJob is already claimed (synchronously) by finalizeLiveJob.
  const instance = await getFFmpeg();
  activeJob.lastProgressAt = Date.now();
  const files = new Set();
  let mounted = false;
  const mountPoint = '/nvs-live-in';
  try {
    sendProgress(0.05, 'Подготовка записи эфира…');
    let videoName;
    let audioName;
    try {
      await instance.createDir(mountPoint);
      await instance.mount('WORKERFS', { files: [tracks.video, tracks.audio] }, mountPoint);
      mounted = true;
      videoName = `${mountPoint}/${tracks.video.name}`;
      audioName = `${mountPoint}/${tracks.audio.name}`;
    } catch (mountError) {
      // WORKERFS unavailable: fall back to MEMFS for recordings that fit.
      if (tracks.video.size + tracks.audio.size > LIVE_MEMFS_FALLBACK_LIMIT) throw mountError;
      videoName = 'live-video.bin';
      audioName = 'live-audio.bin';
      await instance.writeFile(videoName, new Uint8Array(await tracks.video.arrayBuffer()));
      await instance.writeFile(audioName, new Uint8Array(await tracks.audio.arrayBuffer()));
      files.add(videoName);
      files.add(audioName);
    }
    const progressOutput = ['-progress', 'pipe:1', '-nostats'];
    const runs = [
      {
        out: 'live-out.mp4', type: 'video/mp4', extension: '.mp4',
        args: [...progressOutput, '-i', videoName, '-i', audioName, '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', 'live-out.mp4'],
      },
      {
        out: 'live-out.webm', type: 'video/webm', extension: '.webm',
        args: [...progressOutput, '-i', videoName, '-i', audioName, '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy', 'live-out.webm'],
      },
      {
        out: 'live-out.mkv', type: 'video/x-matroska', extension: '.mkv',
        args: [...progressOutput, '-i', videoName, '-i', audioName, '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy', 'live-out.mkv'],
      },
    ];
    let output;
    let selectedRun;
    let lastError = '';
    for (const run of runs) {
      ffmpegLogs.length = 0;
      activeJob.lastProgress = 0;
      activeJob.lastProgressAt = Date.now();
      sendProgress(0.1, 'Склейка записи эфира…');
      files.add(run.out);
      const exitCode = await execWithProgressWatchdog(instance, run.args, activeJob, SINGLE_THREAD_STALL_MS);
      if (exitCode === 0) {
        const candidate = await instance.readFile(run.out).catch(() => null);
        if (candidate?.length) {
          output = candidate;
          selectedRun = run;
          break;
        }
      }
      lastError = `ffmpeg код ${exitCode}: ${ffmpegLogs.slice(-6).join(' | ')}`;
    }
    if (!selectedRun) throw new Error(lastError || 'ffmpeg не собрал запись эфира');
    sendProgress(0.97, 'Подготовка файла к сохранению…', 97);
    const filename = `${baseName}${selectedRun.extension}`;
    await deliverOutput(new Blob([output], { type: selectedRun.type }), filename);
    sendProgress(1, 'Файл передан браузеру…', 100);
    return filename;
  } finally {
    for (const name of files) {
      try { await instance.deleteFile(name); } catch (error) {}
    }
    if (mounted) {
      try { await instance.unmount(mountPoint); } catch (error) {}
      try { await instance.deleteDir(mountPoint); } catch (error) {}
    }
    activeJob = undefined;
  }
}

async function reportError(error) {
  // A recovered job already carries a human-readable explanation; the raw
  // stack would only bury it in the toast.
  const detail = error?.recovered
    ? String(error.message)
    : String(error?.stack || error?.message || error);
  await sendToWorker({
    t: 'nova-error',
    context: 'offscreen/finalize',
    error: detail,
    details: error?.details,
  }, { retries: 4 }).catch(() => {});
  return { ok: false, error: detail, logged: true, ...(error?.recovered ? { recovered: true } : {}) };
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
  if (message.t === 'nova-stage-open') {
    sendResponse(openStaging(message));
    return false;
  }
  if (message.t === 'nova-stage') {
    try { sendResponse(stageChunk(message)); }
    catch (error) { sendResponse({ ok: false, error: String(error) }); }
    return false;
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
  if (message.t === 'nova-live-begin') {
    evictStaleLiveJobs().catch(() => {}).then(() => sendResponse(beginLiveJob(message)));
    return true;
  }
  if (message.t === 'nova-live-chunk') {
    appendLiveChunk(message).then(sendResponse);
    return true;
  }
  if (message.t === 'nova-live-abort') {
    abortLiveJob(message).then(sendResponse).catch(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.t === 'nova-live-finalize') {
    finalizeLiveJob(message).then(sendResponse).catch(async (error) => sendResponse(await reportError(error)));
    return true;
  }
  if (message.t === 'nova-flush') {
    flushRecoveredFiles()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  return false;
});

// Files parked by an earlier session are handed over as soon as this document
// exists again — the service worker that created it is alive by definition.
flushRecoveredFiles().catch(() => {});
