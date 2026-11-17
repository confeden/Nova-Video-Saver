// Wildberries (wildberries.ru) — video in reviews and product galleries.
//
// The player is video.js (stable `vjs-*` class names, unlike the hashed CSS
// modules around it — I20) and feeds the `<video>` through MSE, so `src` is a
// `blob:` and tells nothing. What the page does fetch is an ordinary HLS
// playlist: measured on a review, `<host>/<uuid>/index.m3u8`, one rendition,
// MPEG-TS segments `1.ts … N.ts` that carry audio and video together, all
// readable cross-origin. That is exactly the Rutube shape, so the segments go
// to the shared offscreen muxer as one already-muxed input.
//
// Finding WHICH playlist belongs to the player: a PerformanceObserver collects
// every `.m3u8` the page requests (the resource-timing buffer itself fills up
// at 250 entries and then drops new ones, the observer does not). On click the
// last few candidates are read and the one whose summed EXTINF matches the
// element's own `duration` wins; the most recent one is the tie-break.
(() => {
  const BUTTON_CLASS = 'nova-wb-btn';
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  const SEGMENT_CONCURRENCY = 6;
  const MAX_CANDIDATES = 5;
  const DURATION_TOLERANCE = 0.6;

  const playlists = [];
  let downloadInProgress = false;
  let toast;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `wb/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[Nova Video Saver]', error);
    return chrome.runtime.sendMessage({
      t: 'nova-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  function safeFilename(name) {
    const cleaned = String(name || 'video')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return (points.length > 80 ? points.slice(0, 80).join('').trim() : cleaned) || 'video';
  }

  // ---- playlist discovery -----------------------------------------------------

  function remember(url) {
    if (!/\.m3u8(\?|$)/i.test(url)) return;
    const at = playlists.indexOf(url);
    if (at >= 0) playlists.splice(at, 1);
    playlists.push(url);
    if (playlists.length > 20) playlists.shift();
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) remember(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch (error) {}

  async function fetchText(url) {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`плейлист ответил ${response.status}`);
    return response.text();
  }

  function parseAttributes(line) {
    const attributes = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(line);
    while (match) {
      attributes[match[1]] = match[2].replace(/^"|"$/g, '');
      match = pattern.exec(line);
    }
    return attributes;
  }

  // A media playlist lists segments; a master one lists renditions, and the
  // best of them is followed.
  async function resolvePlaylist(url, depth = 0) {
    const text = await fetchText(url);
    const lines = text.split('\n').map((line) => line.trim());
    if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
      if (depth > 1) throw new Error('вложенный плейлист');
      let best = null;
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
        const target = lines[index + 1];
        if (!target || target.startsWith('#')) continue;
        const attributes = parseAttributes(lines[index]);
        const bandwidth = Number(attributes.BANDWIDTH) || 0;
        const size = /(\d+)x(\d+)/.exec(attributes.RESOLUTION || '');
        const height = size ? Math.min(Number(size[1]), Number(size[2])) : 0;
        if (!best || bandwidth > best.bandwidth) {
          best = { url: new URL(target, url).href, bandwidth, height };
        }
      }
      if (!best) throw new Error('в плейлисте нет ни одного качества');
      const inner = await resolvePlaylist(best.url, depth + 1);
      return { ...inner, height: inner.height || best.height, bandwidth: inner.bandwidth || best.bandwidth };
    }
    const segments = [];
    let duration = 0;
    let live = true;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) duration += Number.parseFloat(line.slice(8)) || 0;
      else if (line.startsWith('#EXT-X-ENDLIST')) live = false;
      else if (line && !line.startsWith('#')) segments.push(new URL(line, url).href);
    }
    if (!segments.length) throw new Error('плейлист сегментов пуст');
    if (live) throw new Error('это прямой эфир — запись эфира не поддержана');
    return { url, segments, duration, height: 0, bandwidth: 0 };
  }

  async function chooseSource(video) {
    const candidates = playlists.slice(-MAX_CANDIDATES).reverse();
    if (!candidates.length) {
      throw new Error('адрес видео не найден — запустите воспроизведение и повторите');
    }
    const target = Number(video.duration) || 0;
    let best = null;
    let lastError = null;
    for (const url of candidates) {
      try {
        const source = await resolvePlaylist(url);
        const miss = target ? Math.abs(source.duration - target) : 0;
        if (!best || miss < best.miss - 1e-6) best = { source, miss };
        if (miss <= DURATION_TOLERANCE) break;
      } catch (error) { lastError = error; }
    }
    if (!best) throw lastError || new Error('не удалось прочитать плейлист');
    if (target && best.miss > DURATION_TOLERANCE) {
      log('source', `no playlist matches duration; wanted=${target} best=${best.source.duration}`);
    }
    return best.source;
  }

  // ---- segment download (as in rutube.js) -----------------------------------

  async function fetchSegment(url, attempt = 0) {
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error('пустой сегмент');
      return bytes;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 300 * (attempt + 1)); });
      return fetchSegment(url, attempt + 1);
    }
  }

  // Fetches run ahead, the handover stays in playlist order (I4: the loop awaits
  // the promise of the segment actually needed, never polls a condition).
  async function streamSegments(urls, send, onProgress) {
    const LOOKAHEAD = SEGMENT_CONCURRENCY * 2;
    const inFlight = new Map();
    let nextToFetch = 0;
    for (let index = 0; index < urls.length; index++) {
      while (nextToFetch < urls.length && inFlight.size < LOOKAHEAD) {
        const at = nextToFetch++;
        const request = fetchSegment(urls[at]);
        request.catch(() => {});
        inFlight.set(at, request);
      }
      const request = inFlight.get(index);
      inFlight.delete(index);
      await send(await request);
      onProgress((index + 1) / urls.length);
    }
  }

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

  async function beginJob(job, expectedBytes) {
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
      muxed: true,
      videoMime: 'video/mp2t',
      audioMime: '',
      duration: job.duration,
      expectedBytes: Math.max(0, Math.round(expectedBytes) || 0),
    });
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');
  }

  async function sendBytes(jobId, bytes) {
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
      const response = await chrome.runtime.sendMessage({
        t: 'nova-chunk', jobId, track: 'video', b64: encodeBase64(chunk),
      });
      if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
    }
  }

  // ---- UI ---------------------------------------------------------------------

  function getToast() {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nova-wb-toast';
      document.body.appendChild(toast);
    }
    toast.hidden = false;
    return {
      set(text, progress) {
        toast.textContent = text;
        toast.style.setProperty('--nova-wb-progress', `${Math.round((progress || 0) * 100)}%`);
      },
      hide(delay) { setTimeout(() => { if (toast) toast.hidden = true; }, delay || 0); },
    };
  }

  function filenameFor(source) {
    const article = /\/catalog\/(\d+)/.exec(location.pathname)?.[1] || '';
    const id = /\/([0-9a-f-]{8,})\/[^/]*$/i.exec(source.url.split('?')[0])?.[1]?.slice(0, 8) || '';
    const title = document.title
      .replace(/^Отзывы на\s+/i, '')
      .replace(/\s+\d{5,}\s+в интернет.магазине.*$/i, '')
      .replace(/\s+(купить|—|\|).*$/i, '');
    const tag = [article && `WB ${article}`, id && `видео ${id}`].filter(Boolean).join(', ');
    const height = source.height ? ` ${source.height}p` : '';
    return `${safeFilename(title)} [${tag || 'WB'}${height}].mp4`;
  }

  async function startDownload(video) {
    if (downloadInProgress) return;
    downloadInProgress = true;
    const notification = getToast();
    try {
      notification.set('Ищу видео…', 0.02);
      const source = await chooseSource(video);
      const estimate = source.bandwidth && source.duration ? source.bandwidth / 8 * source.duration : 0;
      log('download', `start; segments=${source.segments.length} duration=${source.duration}`
        + ` videoDuration=${video.duration} height=${source.height}`);
      const job = {
        jobId: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        filename: filenameFor(source),
        duration: source.duration,
      };
      await beginJob(job, estimate);
      let sentBytes = 0;
      try {
        await streamSegments(source.segments, async (bytes) => {
          await sendBytes(job.jobId, bytes);
          sentBytes += bytes.length;
        }, (fraction) => {
          notification.set(`Скачивание ${Math.round(fraction * 100)}%`, fraction * 0.92);
        });
      } catch (error) {
        await chrome.runtime.sendMessage({ t: 'nova-abort', jobId: job.jobId }).catch(() => {});
        throw error;
      }
      log('download', `segments streamed; bytes=${sentBytes}`);
      notification.set('Сборка файла…', 0.94);
      const result = await chrome.runtime.sendMessage({ t: 'nova-finalize', jobId: job.jobId });
      if (!result?.ok) throw new Error(result?.error || 'не удалось собрать файл');
      notification.set(`Готово: ${result.filename || job.filename}`, 1);
      notification.hide(5000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(9000);
      await reportError('wb/download', error, { page: location.href });
    } finally {
      downloadInProgress = false;
    }
  }

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

  // ---- mounting ---------------------------------------------------------------
  // One button per video.js player, in the player's own box, right-aligned and
  // sitting just above the control bar — i.e. directly over the fullscreen
  // button. It fades with the control bar (`vjs-user-inactive`).

  function mount(player) {
    if (player.querySelector(`:scope > .${BUTTON_CLASS}`)) return;
    const video = player.querySelector('video');
    if (!video) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'NVS (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    const swallow = (event) => { event.stopPropagation(); };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick']) {
      button.addEventListener(type, swallow);
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void startDownload(video);
    });
    player.append(button);
  }

  function schedule() {
    try {
      for (const player of document.querySelectorAll('.video-js')) mount(player);
    } catch (error) {}
  }
  // requestAnimationFrame does not run in a hidden tab (I14); an interval does.
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  schedule();
})();
