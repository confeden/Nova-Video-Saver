// Coub adapter.
//
// A coub is not one file. Coub stores the raw upload as a MUTED fragmented MP4
// and the soundtrack as a separate MP3 that is usually many times longer than
// the video; the site's player simply loops the video under the sound. Both are
// published in `file_versions.html5` and both are served with
// `Access-Control-Allow-Origin: *`, so the page can fetch them directly.
//
// `file_versions.share.default` is Coub's own rendered copy — a single loop, a
// lower bitrate, and Coub's branding. Nothing here touches it; that is what
// keeps the saved file clean. Video-only and audio-only saves never enter the
// extension at all: the URL goes straight to chrome.downloads.
(() => {
  const BUTTON_CLASS = 'nova-coub-btn';
  const MENU_ID = 'nova-coub-menu';
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  // ffmpeg.wasm assembles in memory. A long soundtrack over a short loop can
  // multiply the video by fifty; refuse honestly rather than die half way.
  const MUX_BYTE_LIMIT = 700_000_000;

  let menu;
  let busy = false;
  let toastBox;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `coub/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[Nova Video Saver]', error);
    return chrome.runtime.sendMessage({
      t: 'nova-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  function safeName(value) {
    return String(value || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ` : `${Math.round(value / 1e3)} КБ`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // ---- coub metadata --------------------------------------------------------

  // Feed cards and the single-coub page both carry the permalink on the block
  // element; the URL is only the fallback for layouts that do not.
  function permalinkFor(element) {
    const block = element?.closest?.('[data-permalink]');
    const fromBlock = block?.getAttribute('data-permalink');
    if (fromBlock) return fromBlock;
    return /^\/view\/([A-Za-z0-9]+)/.exec(location.pathname)?.[1] || '';
  }

  async function loadCoub(permalink) {
    // Same origin, and with the session: an age-restricted or private coub is
    // only described to a signed-in visitor.
    const response = await fetch(`${location.origin}/api/v2/coubs/${encodeURIComponent(permalink)}`,
      { credentials: 'include' });
    if (!response.ok) throw new Error(`Coub API ответил ${response.status}`);
    const payload = await response.json();
    // A recoub is a wrapper around someone else's coub and carries no media of
    // its own.
    const source = payload?.file_versions?.html5?.video ? payload : (payload?.recoub_to || payload);
    const html5 = source?.file_versions?.html5;
    if (!html5?.video) throw new Error('Coub не отдал ссылки на видео');

    const dimensions = source.dimensions || {};
    const sizeFor = (key) => {
      const pair = dimensions[key === 'high' ? 'big' : 'med'];
      return Array.isArray(pair) && pair.length === 2 ? { width: pair[0], height: pair[1] } : null;
    };
    const video = ['high', 'med']
      .filter((key) => html5.video[key]?.url)
      .map((key) => ({
        key,
        url: html5.video[key].url,
        bytes: Number(html5.video[key].size) || 0,
        ...(sizeFor(key) || {}),
      }));
    const audio = ['high', 'med']
      .filter((key) => html5.audio?.[key]?.url)
      .map((key) => ({ key, url: html5.audio[key].url, bytes: Number(html5.audio[key].size) || 0 }));

    return {
      permalink: source.permalink || permalink,
      title: source.title || payload?.title || permalink,
      channel: source.channel?.title || payload?.channel?.title || '',
      duration: Number(source.duration) || 0,
      hasSound: Boolean(source.has_sound) && audio.length > 0,
      video,
      audio,
    };
  }

  // ---- media ----------------------------------------------------------------

  // `cache: 'no-store'` is load-bearing, not hygiene.
  //
  // Coub's player has usually already pulled the very file we want, as a media
  // element: a no-cors, ranged request. That leaves an entry in the HTTP cache
  // which a CORS-mode `fetch()` may not read, and Chrome reports the refusal as a
  // bare `TypeError: Failed to fetch` — indistinguishable from the network being
  // down. Measured on the coub that failed in the field: the same URL threw with
  // the default cache mode and returned 200 with the exact declared byte count
  // under `no-store`, 53 ms apart. It bit hardest on feed pages, where the player
  // preloads the `med` rendition that the menu's smaller option also asks for.
  // Bypassing the cache costs a re-download of bytes the browser may hold, which
  // is the right trade for something whose whole job is to produce a file.
  //
  // Retries RESUME rather than start over: the CDN answers Range with 206, so a
  // connection that dies at 80 % costs the remaining 20 %.
  const MEDIA_ATTEMPTS = 4;

  async function fetchMedia(url, onProgress, declaredSize = 0) {
    const parts = [];
    let received = 0;
    let lastError = null;

    for (let attempt = 0; attempt < MEDIA_ATTEMPTS; attempt++) {
      if (attempt) await new Promise((resolve) => { setTimeout(resolve, 400 * attempt); });
      try {
        const response = await fetch(url, {
          credentials: 'omit',
          cache: 'no-store',
          ...(received ? { headers: { Range: `bytes=${received}-` } } : {}),
        });
        // A server that ignores the range answers 200 with the whole file. Splicing
        // that onto what we already hold would duplicate the head, so start clean.
        if (received && response.status !== 206) {
          parts.length = 0;
          received = 0;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const total = declaredSize
          || (received + (Number(response.headers.get('content-length')) || 0));
        if (!response.body) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          parts.push(bytes);
          received += bytes.length;
        } else {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.length;
            if (total) onProgress?.(Math.min(0.99, received / total));
          }
        }
        // A resumed transfer that came up short is a failure, not a result: without
        // this the muxer would happily assemble a truncated track.
        if (declaredSize && received < declaredSize) {
          throw new Error(`получено ${received} из ${declaredSize} байт`);
        }
        const merged = new Uint8Array(received);
        let offset = 0;
        for (const part of parts) {
          merged.set(part, offset);
          offset += part.length;
        }
        onProgress?.(1);
        return merged;
      } catch (error) {
        lastError = error;
        log('fetch', `attempt ${attempt + 1}/${MEDIA_ATTEMPTS} failed at ${received} bytes:`
          + ` ${String(error?.message || error)}`);
      }
    }
    // «Failed to fetch» on its own tells the user nothing, and the journal line
    // above already records how far each attempt got.
    const reason = String(lastError?.message || lastError);
    throw new Error(/failed to fetch|networkerror/i.test(reason)
      ? `не удалось получить файл с ${new URL(url).hostname}`
        + ` (${MEDIA_ATTEMPTS} попытки, получено ${received} байт)`
      : `файл недоступен: ${reason}`);
  }

  // Exact playing time of a bare MPEG audio file, summed frame by frame. The
  // API never states it, and it decides both the loop count and the length the
  // finished file is checked against — an estimate from the byte size would be
  // wrong for every VBR soundtrack, and Coub's are VBR.
  const MPEG_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const MPEG_RATES = [44100, 48000, 32000, 0];

  function mpegDurationSeconds(bytes) {
    let offset = 0;
    if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      // ID3v2 sizes are synchsafe: seven bits per byte.
      offset = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
    }
    let seconds = 0;
    let frames = 0;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xFF || (bytes[offset + 1] & 0xE0) !== 0xE0) {
        offset += 1;
        continue;
      }
      const bitrate = MPEG_BITRATES[(bytes[offset + 2] >> 4) & 0x0F];
      const rate = MPEG_RATES[(bytes[offset + 2] >> 2) & 0x03];
      if (!bitrate || !rate) {
        offset += 1;
        continue;
      }
      const padding = (bytes[offset + 2] >> 1) & 1;
      seconds += 1152 / rate;
      frames += 1;
      offset += Math.floor((144000 * bitrate) / rate) + padding;
    }
    return frames ? seconds : 0;
  }

  // ---- handing the tracks to the shared muxer --------------------------------

  const HAS_NATIVE_BASE64 = typeof Uint8Array.prototype.toBase64 === 'function';

  function encodeBase64(bytes) {
    if (!bytes.length) return '';
    if (HAS_NATIVE_BASE64) return bytes.toBase64();
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + step, bytes.length)));
    }
    return btoa(binary);
  }

  async function sendTrack(jobId, track, bytes, onProgress) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await chrome.runtime.sendMessage({
        t: 'nova-chunk', jobId, track, b64: encodeBase64(chunk),
      });
      if (!response?.ok) throw new Error(response?.error || `передача данных прервалась (${track})`);
      onProgress?.(Math.min(offset + chunk.length, bytes.length) / bytes.length);
    }
  }

  async function muxViaOffscreen(job, tracks, onStage) {
    const ensured = await chrome.runtime.sendMessage({ t: 'nova-ensure' });
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const registration = await chrome.runtime.sendMessage({ t: 'nova-register-job', jobId: job.jobId });
    if (!registration?.ok || !Number.isInteger(registration.tabId)) {
      throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
    }
    const started = await chrome.runtime.sendMessage({
      t: 'nova-begin',
      jobId: job.jobId,
      tabId: registration.tabId,
      filename: job.filename,
      format: 'mp4',
      // -1 repeats the video until the soundtrack ends, 0 keeps one pass and
      // cuts the sound to match.
      loopVideo: job.loopVideo,
      videoMime: 'video/mp4',
      audioMime: 'audio/mpeg',
      videoSize: tracks.video.length,
      audioSize: tracks.audio.length,
      duration: job.duration,
    });
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');

    try {
      const total = tracks.video.length + tracks.audio.length;
      let sent = 0;
      const report = () => onStage?.('transfer', total ? sent / total : 1);
      await sendTrack(job.jobId, 'video', tracks.video, (fraction) => {
        sent = fraction * tracks.video.length;
        report();
      });
      sent = tracks.video.length;
      await sendTrack(job.jobId, 'audio', tracks.audio, (fraction) => {
        sent = tracks.video.length + fraction * tracks.audio.length;
        report();
      });
      onStage?.('transfer', 1);
      return await chrome.runtime.sendMessage({ t: 'nova-finalize', jobId: job.jobId });
    } catch (error) {
      await chrome.runtime.sendMessage({ t: 'nova-abort', jobId: job.jobId }).catch(() => {});
      throw error;
    }
  }

  // ---- downloads -------------------------------------------------------------

  function baseName(info, suffix) {
    const channel = safeName(info.channel);
    const title = safeName(info.title) || info.permalink;
    return `Coub - ${channel ? `${channel} - ` : ''}${title}${suffix}`;
  }

  async function saveDirect(url, filename) {
    const saved = await chrome.runtime.sendMessage({ t: 'nova-save', url, filename });
    if (!saved?.ok) throw new Error(saved?.error || 'браузер не принял файл на сохранение');
    return filename;
  }

  async function downloadWithSound(info, choice, notification, jobId) {
    const video = choice.video;
    const audio = info.audio[0];
    const label = video.width ? `${video.width}×${video.height}` : video.key;

    // The API states both sizes, so a resumed or truncated transfer is caught
    // here rather than becoming a short file later.
    notification.set(`Скачиваю видео ${label}…`, 0.02);
    const videoBytes = await fetchMedia(video.url, (fraction) => {
      notification.set(`Скачиваю видео ${label} · ${Math.round(fraction * 100)}%`, fraction * 0.35);
    }, video.bytes);
    notification.set('Скачиваю звук…', 0.35);
    const audioBytes = await fetchMedia(audio.url, (fraction) => {
      notification.set(`Скачиваю звук · ${Math.round(fraction * 100)}%`, 0.35 + fraction * 0.2);
    }, audio.bytes);

    const audioSeconds = mpegDurationSeconds(audioBytes);
    if (!audioSeconds) throw new Error('не удалось прочитать длительность звуковой дорожки');
    const videoSeconds = info.duration > 0 ? info.duration : 0;
    const looping = choice.loop && videoSeconds > 0 && audioSeconds > videoSeconds;
    const loops = looping ? Math.ceil(audioSeconds / videoSeconds) : 1;
    const duration = looping ? audioSeconds : (videoSeconds || audioSeconds);
    const estimate = videoBytes.length * loops + audioBytes.length;
    if (estimate > MUX_BYTE_LIMIT) {
      throw new Error(`звук длиной ${formatClock(audioSeconds)} растянет видео до ~${Math.round(estimate / 1e6)} МБ`
        + ' — столько браузер не соберёт. Возьмите «один проход» или качество пониже.');
    }

    log('download', `with sound; ${label} loops=${loops} video=${videoBytes.length}`
      + ` audio=${audioBytes.length} audioSeconds=${audioSeconds.toFixed(1)}`
      + ` videoSeconds=${videoSeconds.toFixed(1)}`);

    const filename = baseName(info, ` [${label}${looping ? '' : ', 1 проход'}].mp4`);
    const result = await muxViaOffscreen({
      jobId,
      filename,
      loopVideo: looping ? -1 : 0,
      duration,
    }, { video: videoBytes, audio: audioBytes }, (stage, fraction) => {
      if (stage === 'transfer') {
        notification.set(`Передача ${Math.round(fraction * 100)}%`, 0.55 + fraction * 0.1);
      }
    });
    if (!result?.ok) throw new Error(result?.error || 'не удалось собрать файл');
    return result.filename || filename;
  }

  async function runChoice(info, choice) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    // The offscreen document reports the ffmpeg stage on its own channel, via
    // the service worker. Other tabs' jobs reach this listener too.
    const onProgress = (message) => {
      if (message?.t !== 'nova-progress' || message.jobId !== jobId) return;
      const value = Math.max(0, Math.min(1, message.value || 0));
      notification.set(message.status || 'Сборка…', 0.65 + value * 0.33);
    };
    chrome.runtime.onMessage.addListener(onProgress);
    try {
      let filename;
      if (choice.kind === 'sound') {
        filename = await downloadWithSound(info, choice, notification, jobId);
      } else if (choice.kind === 'video') {
        notification.set('Передаю видео браузеру…', 0.5);
        filename = await saveDirect(choice.video.url,
          baseName(info, ` [${choice.video.width ? `${choice.video.width}×${choice.video.height}` : choice.video.key}, без звука].mp4`));
      } else {
        notification.set('Передаю звук браузеру…', 0.5);
        filename = await saveDirect(info.audio[0].url, baseName(info, '.mp3'));
      }
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(5000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 160)}`, 1);
      notification.hide(11000);
      await reportError('coub/download', error, { permalink: info.permalink, choice: choice.kind });
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
      busy = false;
    }
  }

  // ---- UI ---------------------------------------------------------------------

  function createIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(namespace, 'circle');
    ring.setAttribute('cx', '18');
    ring.setAttribute('cy', '18');
    ring.setAttribute('r', '16.9');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', '#35d477');
    ring.setAttribute('stroke-width', '2.2');
    const arrows = document.createElementNS(namespace, 'path');
    arrows.setAttribute('fill', '#35d477');
    arrows.setAttribute('d', 'M10.8 5.53h14.4L18 18z M10.8 18h14.4L18 30.47z');
    svg.append(ring, arrows);
    return svg;
  }

  function getToast() {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'nova-coub-toast';
      document.body.appendChild(toastBox);
    }
    toastBox.hidden = false;
    return {
      set(text, progress) {
        toastBox.textContent = text;
        toastBox.style.setProperty('--nova-coub-progress', `${Math.round((progress || 0) * 100)}%`);
      },
      hide(delay) { setTimeout(() => { if (toastBox) toastBox.hidden = true; }, delay || 0); },
    };
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`.${BUTTON_CLASS}`)) closeMenu();
  }

  // Everything a coub can produce, in one list: the two "with sound" outputs
  // that need assembly, and the untouched source files that do not.
  function buildChoices(info) {
    const choices = [];
    const looped = info.hasSound && info.duration > 0;
    for (const video of info.video) {
      const label = video.width ? `${video.width}×${video.height}` : video.key;
      if (looped) {
        choices.push({
          kind: 'sound', loop: true, video,
          text: `Со звуком · ${label}`,
          hint: 'видео по кругу до конца звука',
        });
      }
    }
    if (looped) {
      choices.push({
        kind: 'sound', loop: false, video: info.video[0],
        text: `Со звуком · один проход`,
        hint: `${formatClock(info.duration)} · звук обрезан по видео`,
      });
    }
    for (const video of info.video) {
      const label = video.width ? `${video.width}×${video.height}` : video.key;
      choices.push({
        kind: 'video', video,
        text: `Видео без звука · ${label}`,
        hint: `исходный файл · ${formatBytes(video.bytes)}`,
      });
    }
    if (info.audio.length) {
      choices.push({
        kind: 'audio',
        text: 'Только звук · MP3',
        hint: `исходный файл · ${formatBytes(info.audio[0].bytes)}`,
      });
    }
    return choices;
  }

  async function openMenu(button, event) {
    event.preventDefault();
    event.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.className = 'nova-coub-menu';
    const heading = document.createElement('div');
    heading.className = 'nova-coub-head';
    heading.textContent = `Nova Video Saver v${chrome.runtime.getManifest().version}`;
    const loading = document.createElement('div');
    loading.className = 'nova-coub-item nova-coub-muted';
    loading.textContent = 'Читаю данные коуба…';
    menu.append(heading, loading);
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('click', onOutsideClick, true);

    try {
      const permalink = permalinkFor(button);
      if (!permalink) throw new Error('не удалось определить коуб');
      const info = await loadCoub(permalink);
      if (!menu) return;
      loading.remove();
      const choices = buildChoices(info);
      if (!choices.length) throw new Error('у этого коуба нет файлов для скачивания');
      for (const choice of choices) {
        const item = document.createElement('div');
        item.className = 'nova-coub-item';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.append(createElement('span', 'nova-coub-text', choice.text));
        if (choice.hint) item.append(createElement('span', 'nova-coub-hint', choice.hint));
        item.addEventListener('click', () => {
          closeMenu();
          void runChoice(info, choice);
        });
        menu.append(item);
      }
      positionMenu(button);
    } catch (error) {
      if (!menu) return;
      loading.remove();
      menu.append(createElement('div', 'nova-coub-item nova-coub-muted',
        `Ошибка: ${String(error?.message || error).slice(0, 120)}`));
      log('menu', `list failed: ${String(error?.message || error)}`);
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function positionMenu(button) {
    if (!menu || !button) return;
    const box = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width || 280;
    const height = menu.getBoundingClientRect().height || 200;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width))}px`;
    menu.style.top = box.top > height + 16
      ? `${box.top - height - 8}px`
      : `${Math.min(window.innerHeight - height - 8, box.bottom + 8)}px`;
  }

  // ---- mounting ----------------------------------------------------------------
  // One button per player: the feed keeps every card mounted, so a single global
  // button would have no way of saying which coub it belongs to. `.viewer` is
  // Coub's own class and is already `position: relative`.

  function ensureButtons() {
    for (const viewer of document.querySelectorAll('.viewer')) {
      if (viewer.querySelector(`.${BUTTON_CLASS}`)) continue;
      if (!permalinkFor(viewer)) continue;
      const button = document.createElement('button');
      button.className = BUTTON_CLASS;
      button.type = 'button';
      button.title = 'Скачать коуб (Nova Video Saver)';
      button.setAttribute('aria-label', button.title);
      button.append(createIcon());
      button.addEventListener('click', (event) => { void openMenu(button, event); });
      if (getComputedStyle(viewer).position === 'static') viewer.style.position = 'relative';
      viewer.appendChild(button);
    }
  }

  // requestAnimationFrame does not run in a hidden tab, which would leave the
  // button missing until the tab is first shown. A plain interval does.
  function schedule() {
    try { ensureButtons(); } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  schedule();
})();
