// Ozon (ozon.ru) — video in reviews and product galleries.
//
// The player is a custom element, `<video-player>`, whose whole UI lives in a
// shadow root (so no page selector, and no stylesheet of ours, reaches it). The
// `<video>` inside carries a plain progressive MP4 — measured on a review:
// `https://v-1.ozone.ru/sashimi/video-71/<id>/asset_1_h264.mp4`, answers Range
// with 206 and is readable cross-origin from the page. Nothing needs
// assembling, so the bytes go straight to a blob + anchor, the same route the
// TikTok adapter uses for a finished MP4.
//
// The button is mounted INSIDE the shadow root, as the first child of the
// right-hand control block, which puts it immediately left of the fullscreen
// button. The player's class names are Svelte-hashed (I20), so the lookup
// matches on the readable prefix (`rightControlsBlock`) only, and falls back to
// nothing at all until the block exists (no corner fallback — it visibly jumped).
(() => {
  const BUTTON_CLASS = 'nova-oz-btn';
  const STYLE_ID = 'nova-oz-style';
  // The CDN path is not fixed: `v-1.ozone.ru/sashimi/video-71/<id>/…` and
  // `vr-1.ozone.ru/vod/video-71/<id>/…` both serve the same player. The 26-char
  // id folder directly above the file is the stable part.
  const MP4_PATH = /\/([0-9A-Z]{20,})\/[^/]*\.mp4$/i;

  let busy = false;
  let toast;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `ozon/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[Nova Video Saver]', error);
    return chrome.runtime.sendMessage({
      t: 'nova-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  // Truncation is by code point and lone surrogates are dropped: a half pair
  // makes the name unusable and Chrome then names the file after the blob UUID
  // (G28, same as the TikTok adapter).
  function safeName(value) {
    const cleaned = String(value || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return points.length > 80 ? points.slice(0, 80).join('').trim() : cleaned;
  }

  function productTitle() {
    const heading = document.querySelector('h1')?.textContent || '';
    const fromTitle = document.title.replace(/\s+купить на OZON.*$/i, '');
    return safeName(heading || fromTitle) || 'Ozon';
  }

  // ---- toast ----------------------------------------------------------------

  function getToast() {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nova-oz-toast';
      document.body.appendChild(toast);
    }
    toast.hidden = false;
    return {
      set(text, progress) {
        toast.textContent = text;
        toast.style.setProperty('--nova-oz-progress', `${Math.round((progress || 0) * 100)}%`);
      },
      hide(delay) { setTimeout(() => { if (toast) toast.hidden = true; }, delay || 0); },
    };
  }

  // ---- download -------------------------------------------------------------

  // `no-store` (I3): the player has already pulled this URL, and a cache entry
  // made by a no-cors request is invisible to a CORS fetch.
  async function fetchWhole(url, onProgress) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`сервер отказал (HTTP ${response.status})`);
    const declared = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (declared) onProgress(received / declared);
    }
    // I9: a short transfer never becomes a finished file.
    if (declared && received !== declared) {
      throw new Error(`сервер отдал ${received} байт из ${declared}`);
    }
    if (!received) throw new Error('сервер вернул пустой файл');
    return { chunks, bytes: received };
  }

  function saveBlob(chunks, filename) {
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }

  // ---- finding the file -------------------------------------------------------
  // Some players (measured on a product-page review, `rg_type=pdp`) fetch the MP4
  // themselves and play it through a `blob:` URL, so `currentSrc` says nothing.
  // The fetch is still visible in resource timing, but that buffer is full at 250
  // entries on Ozon and then drops new ones, so a PerformanceObserver collects
  // the MP4 requests instead. With several candidates (neighbouring reviews are
  // prefetched) the one whose metadata duration equals the player's wins.
  const mp4Requests = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!/^https?:\/\/[^/]*ozone\.ru\/.*\.mp4(\?|$)/i.test(entry.name)) continue;
        const at = mp4Requests.indexOf(entry.name);
        if (at >= 0) mp4Requests.splice(at, 1);
        mp4Requests.push(entry.name);
        if (mp4Requests.length > 20) mp4Requests.shift();
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (error) {}

  // Metadata only (the browser reads the moov, not the whole file). 0 = unknown.
  function probeDuration(url) {
    return new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.muted = true;
      probe.preload = 'metadata';
      const done = (value) => {
        clearTimeout(timer);
        probe.removeAttribute('src');
        probe.load();
        resolve(value);
      };
      const timer = setTimeout(() => done(0), 8000);
      probe.addEventListener('loadedmetadata', () => done(Number(probe.duration) || 0), { once: true });
      probe.addEventListener('error', () => done(0), { once: true });
      probe.src = url;
    });
  }

  async function findSource(video) {
    const direct = video.currentSrc || video.src || '';
    if (/^https?:/.test(direct)) return direct;
    const candidates = mp4Requests.slice(-6).reverse();
    if (!candidates.length) {
      throw new Error('адрес видео не найден — запустите воспроизведение и повторите');
    }
    const target = Number(video.duration) || 0;
    if (!target || candidates.length === 1) return candidates[0];
    let probed = 0;
    for (const url of candidates) {
      const duration = await probeDuration(url);
      if (!duration) continue;
      probed++;
      if (Math.abs(duration - target) <= 0.5) return url;
    }
    // Candidates were readable and none is this video: refuse rather than hand
    // over a neighbour's file. Nothing readable at all: the newest is the guess.
    if (probed) throw new Error('не удалось определить файл этого видео');
    log('source', `no duration probe succeeded; using the newest of ${candidates.length}`);
    return candidates[0];
  }

  async function download(video) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    try {
      notification.set('Ищу видео…', 0.02);
      const src = await findSource(video);
      const match = MP4_PATH.exec(src.split('?')[0]);
      if (!match) {
        throw new Error('адрес видео не найден — запустите воспроизведение и повторите');
      }
      notification.set('Скачивание видео…', 0.02);
      const file = await fetchWhole(src, (fraction) => {
        notification.set(`Скачивание ${Math.round(fraction * 100)}%`, fraction);
      });
      const filename = `${productTitle()} [видео ${match[1].slice(-8)}].mp4`;
      saveBlob(file.chunks, filename);
      log('video', `saved; bytes=${file.bytes} id=${match[1]}`);
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(5000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(9000);
      await reportError('ozon/download', error, { page: location.href });
    } finally {
      busy = false;
    }
  }

  // ---- mounting -------------------------------------------------------------

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

  // The page stylesheet cannot reach into a shadow root, so the rules travel
  // with the button.
  function ensureStyle(root) {
    if (root.getElementById?.(STYLE_ID) || root.querySelector(`#${STYLE_ID}`)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        display: flex; align-items: center; justify-content: center;
        flex: none; width: 24px; height: 24px; margin: 0 8px 0 0; padding: 0;
        border: 0; background: transparent; cursor: pointer;
        filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
        opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
      }
      /* Hidden until the pointer is over the player, so it never crowds the
         page's own corner buttons (report / share) on an idle video. */
      :host(:hover) .${BUTTON_CLASS} { opacity: 0.92; pointer-events: auto; }
      :host(:hover) .${BUTTON_CLASS}:hover { opacity: 1; }
      .${BUTTON_CLASS} svg { width: 22px; height: 22px; display: block; }
    `;
    root.append(style);
  }

  function makeButton(video) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'NVS (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    // The click would otherwise reach the player's surface handler and toggle
    // playback.
    const swallow = (event) => { event.stopPropagation(); };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick']) {
      button.addEventListener(type, swallow);
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void download(video);
    });
    return button;
  }

  function mount(host) {
    const root = host.shadowRoot;
    const video = root?.querySelector('video');
    if (!video) return;
    ensureStyle(root);
    let button = root.querySelector(`.${BUTTON_CLASS}`);
    const block = root.querySelector('[class*="rightControlsBlock"]');
    if (block) {
      if (!button) button = makeButton(video);
      // Left of the fullscreen control, which is the block's own first child.
      if (button.parentElement !== block || block.firstElementChild !== button) {
        block.prepend(button);
      }
      return;
    }
    // No corner fallback on purpose: the controls render lazily (an untouched
    // player has an empty bottom panel), and a button parked in the corner until
    // they appear was visible jumping to its real place on the first hover. The
    // button now simply does not exist until the block does; `hurry` below makes
    // that a matter of milliseconds after the pointer arrives.
  }

  // requestAnimationFrame does not run in a hidden tab (I14); an interval does.
  function schedule() {
    try {
      for (const host of document.querySelectorAll('video-player')) mount(host);
    } catch (error) {}
  }
  setInterval(schedule, 1000);
  document.addEventListener('visibilitychange', schedule);
  // The player builds its controls on the first pointer contact, a few frames
  // after the event. Polling briefly (a timer, I14) puts the button in place
  // before the fade-in finishes instead of waiting for the one-second tick.
  let hurrying = false;
  function hurry() {
    if (hurrying) return;
    hurrying = true;
    let ticks = 0;
    const timer = setInterval(() => {
      schedule();
      if (++ticks >= 20) { clearInterval(timer); hurrying = false; }
    }, 50);
  }
  document.addEventListener('pointerover', (event) => {
    if (event.target?.localName === 'video-player') { schedule(); hurry(); }
  }, true);
  schedule();
})();
