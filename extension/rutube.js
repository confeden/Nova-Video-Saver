// Rutube adapter. Deliberately independent of content_hook.js: Rutube publishes
// a plain HLS playlist, so nothing here intercepts MSE or drives the player.
// Segments are ordinary GETs, and the assembled MPEG-TS goes to the shared
// offscreen muxer as a single already-muxed input.
(() => {
  const BUTTON_ID = 'nova-rutube-btn';
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
  const SEGMENT_CONCURRENCY = 6;
  const ID_PATTERN = /[0-9a-f]{32}/i;

  let downloadInProgress = false;
  let menu;
  let toast;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `rutube/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[Nova Video Saver]', error);
    return chrome.runtime.sendMessage({
      t: 'nova-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  // ---- page facts ---------------------------------------------------------

  // Slug URLs (rutube.sport) carry no id, but every page advertises its player
  // embed, and that URL always ends with the canonical 32-hex id.
  function videoIdFromPage() {
    const fromPath = ID_PATTERN.exec(location.pathname);
    if (fromPath) return fromPath[0].toLowerCase();
    const embed = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
    const fromEmbed = embed?.content ? ID_PATTERN.exec(embed.content) : null;
    return fromEmbed ? fromEmbed[0].toLowerCase() : '';
  }

  const isShorts = () => location.pathname.startsWith('/shorts/');

  function safeFilename(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  // ---- playback options and playlists -------------------------------------

  async function fetchPlayOptions(videoId) {
    const url = `${location.origin}/api/play/options/${videoId}/`
      + `?no_404=true&referer=${encodeURIComponent(location.href)}`;
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Rutube API ответил ${response.status}`);
    const payload = await response.json();
    const master = payload?.video_balancer?.m3u8 || payload?.video_balancer?.default;
    if (!master) throw new Error('Rutube не отдал плейлист видео');
    return {
      master,
      title: payload.title || document.title,
      durationSeconds: (Number(payload.duration) || 0) / 1000,
      isLive: Boolean(payload.is_livestream || payload.live_streams?.is_active),
    };
  }

  function parseAttributes(line) {
    const attributes = {};
    // Values may be quoted and contain commas (CODECS="avc1.42c01f, mp4a.40.2").
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(line);
    while (match) {
      attributes[match[1]] = match[2].replace(/^"|"$/g, '');
      match = pattern.exec(line);
    }
    return attributes;
  }

  // One rendition can appear several times, once per CDN mirror. Keep every
  // mirror: a segment that fails on one host is retried on the next.
  function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split('\n').map((line) => line.trim());
    const byHeight = new Map();
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
      const target = lines[index + 1];
      if (!target || target.startsWith('#')) continue;
      const attributes = parseAttributes(lines[index]);
      const resolution = /(\d+)x(\d+)/.exec(attributes.RESOLUTION || '');
      if (!resolution) continue;
      // Vertical shorts must be named by their short edge, exactly as the
      // YouTube side learned to do: 608x1080 is a 608p rendition, not 1080p.
      const height = Math.min(Number(resolution[1]), Number(resolution[2]));
      const entry = byHeight.get(height) || {
        height,
        bandwidth: Number(attributes.BANDWIDTH) || 0,
        codecs: attributes.CODECS || '',
        mirrors: [],
      };
      entry.mirrors.push(new URL(target, baseUrl).href);
      byHeight.set(height, entry);
    }
    return [...byHeight.values()].sort((left, right) => right.height - left.height);
  }

  function parseMediaPlaylist(text, baseUrl) {
    const segments = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      segments.push(new URL(line, baseUrl).href);
    }
    return segments;
  }

  async function fetchText(url) {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`плейлист ответил ${response.status}`);
    return response.text();
  }

  // ---- segment download ---------------------------------------------------

  async function fetchSegment(url, attempt = 0) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
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

  // Ordered result, bounded concurrency: the pieces must be concatenated in
  // playlist order, but waiting for each one in turn would be needlessly slow.
  async function downloadSegments(urls, onProgress) {
    const parts = new Array(urls.length);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const index = next++;
        parts[index] = await fetchSegment(urls[index]);
        done += 1;
        onProgress(done / urls.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, worker));
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  // ---- handing the stream to the shared muxer ------------------------------

  // See content_ui.js: the argument spread costs ~155 ms per 4 MiB chunk in
  // Chrome 151 against 1.2 ms for the native encoder, and it is the transfer's
  // whole bottleneck. Byte-identical output.
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

  async function muxViaOffscreen(job, bytes, onProgress) {
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
    });
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');

    try {
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
        const response = await chrome.runtime.sendMessage({
          t: 'nova-chunk', jobId: job.jobId, track: 'video', b64: encodeBase64(chunk),
        });
        if (!response?.ok) throw new Error(response?.error || 'передача данных прервалась');
        onProgress(Math.min(offset + chunk.length, bytes.length) / bytes.length);
      }
      return await chrome.runtime.sendMessage({ t: 'nova-finalize', jobId: job.jobId });
    } catch (error) {
      await chrome.runtime.sendMessage({ t: 'nova-abort', jobId: job.jobId }).catch(() => {});
      throw error;
    }
  }

  // ---- UI ------------------------------------------------------------------

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
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nova-rt-toast';
      document.body.appendChild(toast);
    }
    toast.hidden = false;
    return {
      set(text, progress) {
        toast.textContent = text;
        toast.style.setProperty('--nova-rt-progress', `${Math.round((progress || 0) * 100)}%`);
      },
      hide(delay) { setTimeout(() => { if (toast) toast.hidden = true; }, delay || 0); },
    };
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`#${BUTTON_ID}`)) closeMenu();
  }

  async function openMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.className = 'nova-rt-menu';
    const heading = document.createElement('div');
    heading.className = 'nova-rt-head';
    heading.textContent = `Nova Video Saver v${chrome.runtime.getManifest().version}`;
    menu.append(heading);
    const loading = document.createElement('div');
    loading.className = 'nova-rt-item nova-rt-muted';
    loading.textContent = 'Читаю список качеств…';
    menu.append(loading);
    document.body.appendChild(menu);
    positionMenu();
    document.addEventListener('click', onOutsideClick, true);

    try {
      const videoId = videoIdFromPage();
      if (!videoId) throw new Error('не удалось определить идентификатор видео');
      const options = await fetchPlayOptions(videoId);
      const master = await fetchText(options.master);
      const variants = parseMasterPlaylist(master, options.master);
      loading.remove();
      if (options.isLive) {
        const live = document.createElement('div');
        live.className = 'nova-rt-item nova-rt-muted';
        live.textContent = 'Идёт трансляция — запись эфира пока не поддержана';
        menu.append(live);
        return;
      }
      if (!variants.length) throw new Error('Rutube не предложил ни одного качества');
      for (const variant of variants) {
        const item = document.createElement('div');
        item.className = 'nova-rt-item';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        const size = variant.bandwidth && options.durationSeconds
          ? ` · ~${Math.round((variant.bandwidth / 8) * options.durationSeconds / 1e6)} МБ` : '';
        item.textContent = `${variant.height}p MP4${size}`;
        item.addEventListener('click', () => {
          closeMenu();
          void startDownload(variant, options);
        });
        menu.append(item);
      }
    } catch (error) {
      loading.remove();
      const failed = document.createElement('div');
      failed.className = 'nova-rt-item nova-rt-muted';
      failed.textContent = `Ошибка: ${String(error?.message || error).slice(0, 90)}`;
      menu.append(failed);
      log('menu', `quality list failed: ${String(error?.message || error)}`);
    }
  }

  function positionMenu() {
    const button = document.getElementById(BUTTON_ID);
    if (!button || !menu) return;
    const box = button.getBoundingClientRect();
    const width = 260;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2));
    menu.style.left = `${left}px`;
    // Open downwards when there is not enough room above the button.
    const menuHeight = menu.getBoundingClientRect().height || 280;
    menu.style.top = box.top > menuHeight + 16
      ? `${box.top - menuHeight - 8}px`
      : `${Math.min(window.innerHeight - menuHeight - 8, box.bottom + 8)}px`;
  }

  async function startDownload(variant, options) {
    if (downloadInProgress) return;
    downloadInProgress = true;
    const notification = getToast();
    try {
      notification.set(`Готовлю ${variant.height}p…`, 0.02);
      let segments = null;
      let lastError = null;
      for (const mirror of variant.mirrors) {
        try {
          segments = parseMediaPlaylist(await fetchText(mirror), mirror);
          if (segments.length) break;
        } catch (error) { lastError = error; }
      }
      if (!segments?.length) throw lastError || new Error('плейлист сегментов пуст');
      log('download', `start; height=${variant.height} segments=${segments.length}`
        + ` mirrors=${variant.mirrors.length}`);

      const bytes = await downloadSegments(segments, (fraction) => {
        notification.set(`Получение сегментов ${Math.round(fraction * 100)}%`, fraction * 0.8);
      });
      log('download', `segments fetched; bytes=${bytes.length}`);

      const filename = `${safeFilename(options.title)} [${variant.height}p].mp4`;
      const result = await muxViaOffscreen({
        jobId: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        filename,
        duration: options.durationSeconds,
      }, bytes, (fraction) => {
        notification.set(`Передача ${Math.round(fraction * 100)}%`, 0.8 + fraction * 0.15);
      });
      if (!result?.ok) throw new Error(result?.error || 'не удалось собрать файл');
      notification.set(`Готово: ${result.filename || filename}`, 1);
      notification.hide(5000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(9000);
      await reportError('rutube/download', error, { height: variant?.height, page: location.href });
    } finally {
      downloadInProgress = false;
    }
  }

  // ---- mounting -------------------------------------------------------------
  // Rutube ships hashed CSS-module class names, so anchors match on the stable
  // part before the hash and every lookup tolerates the element being absent.

  function shortsActionColumn() {
    const wrappers = [...document.querySelectorAll('[class*="controlsWrapper"]')]
      .filter((element) => element.getBoundingClientRect().width > 0);
    // The carousel keeps a wrapper per card; the visible one nearest the centre
    // of the viewport belongs to the reel actually being watched.
    const centre = window.innerHeight / 2;
    const active = wrappers.sort((left, right) => {
      const distance = (element) => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.top + box.height / 2 - centre);
      };
      return distance(left) - distance(right);
    })[0];
    if (!active) return null;
    // Middle child holds the like/comment counters; first child is the arrow.
    return [...active.children].find((child) => /\d/.test(child.textContent || '')) || null;
  }

  function playerRoot() {
    const media = document.querySelector('video');
    let node = media?.parentElement || null;
    while (node && node !== document.body) {
      const box = node.getBoundingClientRect();
      if (box.width > 320 && box.height > 180) return node;
      node = node.parentElement;
    }
    return document.querySelector('[class*="player"]') || null;
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) {
      if (isShorts()) {
        // The carousel swaps cards; keep the button on the active one.
        const column = shortsActionColumn();
        const button = document.getElementById(BUTTON_ID);
        if (column && button.parentElement !== column) column.prepend(button);
      }
      return;
    }
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'NVS (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', openMenu);

    if (isShorts()) {
      const column = shortsActionColumn();
      if (!column) return;
      button.className = 'nova-rt-btn nova-rt-shorts';
      const circle = document.createElement('span');
      circle.className = 'nova-rt-circle';
      circle.append(createIcon());
      const label = document.createElement('span');
      label.className = 'nova-rt-label';
      label.textContent = 'NVS';
      button.append(circle, label);
      column.prepend(button);
      return;
    }

    const root = playerRoot();
    if (!root) return;
    button.className = 'nova-rt-btn nova-rt-overlay';
    button.append(createIcon());
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.appendChild(button);
  }

  // requestAnimationFrame does not run in a hidden tab, which would leave the
  // button missing until the tab is first shown. A plain interval does.
  function schedule() {
    try { ensureButton(); } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  schedule();
})();
