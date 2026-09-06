// Zvuk (zvuk.com) — audio tracks.
//
// Zvuk is a Next.js SPA whose markup is CSS-modules hashed, so nothing in the
// DOM is a safe anchor except the links themselves: every track anywhere on the
// site — a track page, an album, a playlist, the /shorts feed — is reachable as
// `<a href="/track/<id>">`. That single fact is the whole adapter: the page is
// scanned for those ids and everything else comes from the site's own API.
//
// Two API calls, both same-origin POSTs to /api/v1/graphql with the site's own
// `x-auth-token` (localStorage.token):
//   * getStream  → `stream { expire high mid preview }`. `high` is the 320 kbps
//     MP3 and `mid` the 128 kbps one; both are ORDINARY URLs the CDN serves
//     with Range and audio/mpeg. Nothing here is DRM: the protected tier is a
//     separate `flacdrm` field (Widevine/FairPlay) that this adapter never asks
//     for and never touches.
//   * getTracks  → title, artists, duration, for the filename.
//
// Without a subscription the API answers with the same URL in `mid` and
// `preview` — a 30-second excerpt. That is the account's entitlement, not a
// failure, so the menu says so instead of pretending otherwise.
(() => {
  const BUTTON_CLASS = 'nova-zvuk-btn';
  const GQL_URL = '/api/v1/graphql';
  const TRACK_HREF = /^\/track\/(\d+)/;
  // CSS-modules class names: `ContentItem_wrapper__dQusH`. The hash changes per
  // build and must never be keyed on (I20), but the readable prefix is the
  // module and the local name and survives — the same substring match the VK
  // adapter uses. A track row is `ContentItem_wrapper` and its right-hand
  // `Controls_controls` block holds the like button and the duration.
  const ROW_SELECTOR = '[class*="ContentItem_wrapper"]';
  const CONTROLS_SELECTOR = '[class*="Controls_controls"]';
  const DURATION_TEXT = /^\s*\d{1,2}:\d{2}\s*$/;
  // Zvuk's own quality names. 'mid' is rejected by the gateway with
  // "invalid quality" — the valid set is sq / hq / hifi / auto, and hq is the
  // one that yields the MP3 pair.
  const STREAM_QUALITY = 'hq';
  const BATCH_LIMIT = 60;

  let menu;
  let busy = false;
  let toastBox;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `zvuk/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[Nova Video Saver]', error);
    return chrome.runtime.sendMessage({
      t: 'nova-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // Truncation is by CODE POINT: String.slice cuts a surrogate pair in half, and
  // the lone surrogate left behind makes the whole name unusable — Chrome then
  // names the file after the blob's UUID instead of failing. background.js
  // repairs whatever still slips through; this keeps it from arising here.
  function safeName(value) {
    const cleaned = String(value || '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return points.length > 110 ? points.slice(0, 110).join('').trim() : cleaned;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }

  // ---- API -------------------------------------------------------------------

  function authToken() {
    // The site keeps it as a JSON string; an anonymous visit has one too (it is
    // just not entitled to full streams).
    try { return JSON.parse(localStorage.getItem('token') || 'null') || ''; }
    catch (error) { return ''; }
  }

  async function gql(operationName, query, variables) {
    const response = await fetch(GQL_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-auth-token': authToken() },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!response.ok) throw new Error(`Звук не ответил (HTTP ${response.status})`);
    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(String(payload.errors[0]?.message || 'Звук вернул ошибку'));
    }
    if (!payload?.data) throw new Error('Звук вернул пустой ответ');
    return payload.data;
  }

  const TRACKS_QUERY = 'query nvsTracks($ids:[ID!]!){getTracks(ids:$ids){'
    + 'id title duration artistNames release{id title}}}';

  // Zvuk's own document also declares `$includeFlacDrm` and `$useHLSv2`, which
  // gate a `flacdrm` field and an HLS `streamV3` block. Neither is asked for
  // here — the DRM tier is out of scope (D9) — and the two variables are gone
  // with them: a declared-but-unused variable is a hard 400 from this gateway
  // (`Variable "$includeFlacDrm" is never used in operation "getStream"`).
  const STREAM_QUERY = 'query getStream($ids:[ID!]!,$quality:String,$encodeType:String){'
    + 'mediaContents(ids:$ids,quality:$quality,encodeType:$encodeType){'
    + '... on Track{stream{expire high mid preview}}}}';

  async function loadTracks(ids) {
    const data = await gql('nvsTracks', TRACKS_QUERY, { ids });
    const byId = new Map();
    for (const track of data.getTracks || []) {
      if (!track?.id) continue;
      byId.set(String(track.id), {
        id: String(track.id),
        title: track.title || `track-${track.id}`,
        artist: (track.artistNames || []).join(', '),
        duration: Number(track.duration) || 0,
        album: track.release?.title || '',
      });
    }
    return byId;
  }

  async function loadStream(id) {
    const data = await gql('getStream', STREAM_QUERY, {
      ids: [String(id)], quality: STREAM_QUALITY, encodeType: null,
    });
    const stream = (data.mediaContents || [])[0]?.stream;
    if (!stream) throw new Error('Звук не отдал ссылку на этот трек');
    const url = stream.high || stream.mid;
    if (!url) throw new Error('для этого трека нет доступного файла');
    // Without a subscription the gateway substitutes the excerpt into `mid`;
    // `high` stays null. Saying "готово" over a 30-second file would be a lie.
    const isPreview = !stream.high && Boolean(stream.preview) && stream.mid === stream.preview;
    return { url, isPreview, bitrate: stream.high ? 320 : 128 };
  }

  // ---- page scan -------------------------------------------------------------

  function trackIdFrom(href) {
    const match = TRACK_HREF.exec(String(href || ''));
    return match ? match[1] : null;
  }

  // Every /track/<id> link on the page, in document order and deduplicated. A
  // track page lists its own id first; an album, a playlist and the /shorts
  // feed all list theirs the same way, so one scan covers every page kind.
  function trackIdsOnPage() {
    const ids = [];
    const seen = new Set();
    const own = trackIdFrom(location.pathname);
    if (own) { ids.push(own); seen.add(own); }
    for (const anchor of document.querySelectorAll('a[href^="/track/"]')) {
      const id = trackIdFrom(anchor.getAttribute('href'));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= BATCH_LIMIT) break;
    }
    return ids;
  }

  function pageLabel() {
    if (/^\/release\//.test(location.pathname)) return 'этого альбома';
    if (/^\/playlist\//.test(location.pathname)) return 'этого плейлиста';
    if (/^\/artist\//.test(location.pathname)) return 'этого артиста';
    if (/^\/shorts/.test(location.pathname)) return 'этой ленты';
    return 'этой страницы';
  }

  // ---- downloads -------------------------------------------------------------

  function fileNameFor(track) {
    const artist = safeName(track.artist);
    const title = safeName(track.title);
    return `${artist ? `${artist} - ` : ''}${title || track.id}.mp3`;
  }

  async function saveDirect(url, filename) {
    const saved = await chrome.runtime.sendMessage({ t: 'nova-save', url, filename });
    if (!saved?.ok) throw new Error(saved?.error || 'браузер не принял файл на сохранение');
    return saved.id;
  }

  // The browser pulls the file itself, so its progress has to be polled:
  // downloads.onChanged fires on state changes, not on bytes.
  async function followBrowserDownload(id, notification, stage) {
    let misses = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await chrome.runtime.sendMessage({ t: 'nova-download-state', id }).catch(() => null);
      if (!state?.ok) {
        if (++misses > 8) throw new Error(state?.error || 'браузер потерял загрузку');
        continue;
      }
      misses = 0;
      if (state.state === 'interrupted') {
        throw new Error(`браузер прервал загрузку (${state.error || 'причина не указана'})`);
      }
      if (state.state === 'complete') return;
      const total = Number(state.totalBytes) || 0;
      const received = Number(state.bytesReceived) || 0;
      notification.stage(stage, total ? received / total : null, 'active',
        state.paused ? 'Пауза в браузере' : 'Скачивание файла');
    }
  }

  async function downloadOne(track, notification, stage) {
    const stream = await loadStream(track.id);
    const filename = fileNameFor(track);
    const id = await saveDirect(stream.url, filename);
    await followBrowserDownload(id, notification, stage);
    log('track', `saved ${track.id}; bitrate=${stream.bitrate} preview=${stream.isPreview}`);
    return { filename, isPreview: stream.isPreview };
  }

  async function runOne(track) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    try {
      notification.begin(`Скачиваю: ${track.title}`, [{ id: 'file', label: 'Скачивание файла' }]);
      notification.stage('file', null, 'active', 'Запрашиваю ссылку');
      const result = await downloadOne(track, notification, 'file');
      notification.stage('file', 1, 'done', 'Скачивание файла');
      notification.set(result.isPreview
        ? `Готово (фрагмент 30 с — нет подписки): ${result.filename}`
        : `Готово: ${result.filename}`, 1);
      notification.hide(result.isPreview ? 8000 : 4000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(8000);
      void reportError('zvuk-download', error, { id: track.id });
    } finally {
      busy = false;
    }
  }

  // Sequential on purpose: chrome.downloads accepts everything handed to it at
  // once and then runs dozens of transfers in parallel, which on a slow line
  // makes every one of them time out instead of finishing one by one.
  async function runAll(tracks) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    let done = 0;
    let failed = 0;
    let previews = 0;
    try {
      notification.begin(`Скачиваю ${tracks.length} треков…`, [
        { id: 'list', label: 'Треки' },
        { id: 'file', label: 'Текущий файл' },
      ]);
      for (const track of tracks) {
        notification.stage('list', done / tracks.length, 'active',
          `Трек ${done + 1} из ${tracks.length}: ${track.title}`);
        try {
          const result = await downloadOne(track, notification, 'file');
          if (result.isPreview) previews += 1;
        } catch (error) {
          failed += 1;
          log('batch', `track ${track.id} failed: ${String(error?.message || error)}`);
        }
        done += 1;
      }
      notification.stage('list', 1, 'done', 'Треки');
      notification.stage('file', 1, 'done', 'Текущий файл');
      const parts = [`Готово: ${done - failed} из ${tracks.length}`];
      if (previews) parts.push(`фрагментов 30 с: ${previews}`);
      if (failed) parts.push(`не удалось: ${failed}`);
      notification.set(parts.join(' · '), 1);
      notification.hide(9000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(8000);
      void reportError('zvuk-batch', error, { count: tracks.length });
    } finally {
      busy = false;
    }
  }

  // ---- toast -----------------------------------------------------------------

  let toastTimer;

  function getToast() {
    if (!toastBox) {
      toastBox = createElement('div', 'nova-zvuk-toast');
      const text = createElement('div', 'nova-zvuk-toast-text');
      const bar = createElement('div', 'nova-zvuk-toast-bar');
      bar.append(createElement('i'));
      const stages = createElement('div', 'nova-zvuk-stages');
      toastBox.append(text, bar, stages);
      document.body.appendChild(toastBox);
      toastBox._text = text;
      toastBox._bar = bar;
      toastBox._stages = stages;
    }
    const show = () => {
      clearTimeout(toastTimer);
      toastBox.classList.add('show');
    };
    return {
      set(message, fraction) {
        show();
        toastBox._text.textContent = message;
        toastBox._stages.replaceChildren();
        toastBox._stages.classList.remove('show');
        toastBox._bar.hidden = false;
        toastBox._bar.querySelector('i').style.width = `${Math.max(0, Math.min(1, Number(fraction) || 0)) * 100}%`;
      },
      begin(message, definitions) {
        show();
        toastBox._text.textContent = message;
        toastBox._bar.hidden = true;
        toastBox._stages.replaceChildren();
        for (const definition of definitions) {
          const row = createElement('div', 'nova-zvuk-stage queued');
          row.dataset.stage = definition.id;
          const head = createElement('div', 'nova-zvuk-stage-head');
          head.append(createElement('span', 'nova-zvuk-stage-label', definition.label),
            createElement('span', 'nova-zvuk-stage-value', 'ожидание'));
          const bar = createElement('div', 'nova-zvuk-stage-bar');
          bar.append(createElement('i'));
          row.append(head, bar);
          toastBox._stages.append(row);
        }
        toastBox._stages.classList.add('show');
      },
      stage(id, fraction, state = 'active', label) {
        const row = toastBox?._stages.querySelector(`[data-stage="${id}"]`);
        if (!row) return;
        row.className = `nova-zvuk-stage ${state}`;
        if (label) row.querySelector('.nova-zvuk-stage-label').textContent = label;
        const value = row.querySelector('.nova-zvuk-stage-value');
        const fill = row.querySelector('.nova-zvuk-stage-bar i');
        if (Number.isFinite(fraction)) {
          const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
          value.textContent = state === 'done' ? 'готово' : `${percent}%`;
          fill.style.width = `${percent}%`;
          row.classList.remove('busy');
        } else {
          value.textContent = state === 'active' ? 'идёт…' : (state === 'error' ? 'ошибка' : 'ожидание');
          fill.style.width = state === 'done' ? '100%' : '0%';
          row.classList.toggle('busy', state === 'active');
        }
      },
      hide(delay) {
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastBox?.classList.remove('show'), delay || 0);
      },
    };
  }

  // ---- menu ------------------------------------------------------------------

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (!menu) return;
    const path = event.composedPath ? event.composedPath() : [event.target];
    if (path.some((node) => node === menu || node?.classList?.contains?.(BUTTON_CLASS))) return;
    closeMenu();
  }

  function addItem(text, hint, onClick) {
    const item = createElement('div', 'nova-zvuk-item');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.append(createElement('span', 'nova-zvuk-text', text));
    if (hint) item.append(createElement('span', 'nova-zvuk-hint', hint));
    item.addEventListener('click', () => { closeMenu(); onClick(); });
    menu.append(item);
    return item;
  }

  // The button belongs to one track, so its menu leads with that track and
  // keeps the whole-page download as the second entry — the batch is worth
  // having and there is no longer a separate button to hang it on.
  async function openMenu(button, trackId, event) {
    event.preventDefault();
    event.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = createElement('div', 'nova-zvuk-menu');
    menu.append(createElement('div', 'nova-zvuk-head',
      `Nova Video Saver v${chrome.runtime.getManifest().version}`));
    const loading = createElement('div', 'nova-zvuk-item nova-zvuk-muted', 'Читаю данные трека…');
    menu.append(loading);
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('click', onOutsideClick, true);

    try {
      const ids = trackIdsOnPage();
      const wanted = [trackId, ...ids.filter((id) => id !== trackId)];
      const byId = await loadTracks(wanted);
      if (!menu) return;
      loading.remove();
      const own = byId.get(trackId);
      if (!own) throw new Error('Звук не отдал данные этого трека');
      const rest = wanted.map((id) => byId.get(id)).filter(Boolean);

      addItem(
        `${own.artist ? `${own.artist} — ` : ''}${own.title}`,
        `MP3 · ${formatClock(own.duration)}`,
        () => void runOne(own),
      );
      if (rest.length > 1) {
        addItem(`Скачать все треки ${pageLabel()}`, `${rest.length} шт.`, () => void runAll(rest));
      }
      menu.append(createElement('div', 'nova-zvuk-menu-note',
        'MP3 320 кбит/с при активной подписке. Без неё Звук отдаёт фрагмент 30 секунд.'));
      positionMenu(button);
    } catch (error) {
      if (!menu) return;
      loading.remove();
      menu.append(createElement('div', 'nova-zvuk-item nova-zvuk-muted',
        `Ошибка: ${String(error?.message || error).slice(0, 120)}`));
      log('menu', `list failed: ${String(error?.message || error)}`);
    }
  }

  function positionMenu(button) {
    if (!menu || !button) return;
    const box = button.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width || 320;
    const height = menu.getBoundingClientRect().height || 200;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width))}px`;
    menu.style.top = box.top > height + 16
      ? `${box.top - height - 8}px`
      : `${Math.min(window.innerHeight - height - 8, box.bottom + 8)}px`;
  }

  // ---- mounting ----------------------------------------------------------------

  // The same ring-and-arrows mark the YouTube button uses, so one extension does
  // not look like two.
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

  function makeButton(trackId) {
    const button = document.createElement('button');
    button.className = `${BUTTON_CLASS} nova-zvuk-row-btn`;
    button.type = 'button';
    button.dataset.novaTrack = trackId;
    button.title = 'Скачать трек (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    button.addEventListener('click', (event) => { void openMenu(button, trackId, event); });
    return button;
  }

  // One button per row, immediately to the LEFT of the duration inside the
  // row's own controls block — that is where Zvuk already keeps its per-track
  // actions, so nothing has to be positioned by hand and the button scrolls
  // with the row it belongs to.
  function mountInRow(row) {
    const anchor = row.querySelector('a[href^="/track/"]');
    const trackId = trackIdFrom(anchor?.getAttribute('href'));
    if (!trackId) return;
    const controls = row.querySelector(CONTROLS_SELECTOR);
    if (!controls) return;
    const existing = controls.querySelector(`.${BUTTON_CLASS}`);
    // A virtualised list reuses a row for a different track, so a button left
    // over from the previous one would download the wrong file.
    if (existing) {
      if (existing.dataset.novaTrack === trackId) return;
      existing.remove();
    }
    const duration = [...controls.children]
      .find((child) => DURATION_TEXT.test(child.textContent || ''));
    const button = makeButton(trackId);
    if (duration) controls.insertBefore(button, duration);
    else controls.append(button);
  }

  function ensureButtons() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) mountInRow(row);
  }

  // An interval, not requestAnimationFrame: rAF never runs in a hidden tab
  // (N29), and this SPA rewrites its route without a page load.
  setInterval(() => { try { ensureButtons(); } catch (error) {} }, 1500);
  document.addEventListener('visibilitychange', () => { try { ensureButtons(); } catch (error) {} });
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  try { ensureButtons(); } catch (error) {}
})();
