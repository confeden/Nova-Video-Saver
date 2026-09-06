// Musify (musify.club) — audio tracks. DISABLED, NOT REGISTERED.
//
// This file is not in manifest.json and neither is the musify.club host
// permission, so nothing here runs. It is kept rather than deleted because the
// site research in it is sound and expensive to redo — see `kb/sites.md`, which
// records what was measured and what is still unknown.
//
// Four routes were tried against a live site and all four failed in the field:
// the `dl` endpoint (account gate), a page fetch (the CDN sends no
// `Access-Control-Allow-Origin`), a worker-resolved CDN URL handed to
// chrome.downloads (SERVER_FORBIDDEN — issued to one requester, presented by
// another), and finally chrome.downloads on `/track/pl/…` with
// `Accept: */*`. That last one is the puzzle: the exact HTTP chain, replayed
// with curl using the browser's own headers, downloads the whole 8 751 147-byte
// MP3 — so the remaining suspect is whether Chrome honours the `headers` option
// on downloads at all. Confirming that is the first thing to do before
// re-enabling: put the entry back in manifest.json (content script + the two
// musify.club host permissions), restore the `headers` pass-through in
// `saveDownload`, and read the journal.
//
// Musify publishes the download itself: every track row carries
// `<a href="/track/dl/<id>/<slug>.mp3">` next to a `/track/pl/…` play link, and
// that endpoint 302s to the CDN. So there is nothing to parse, nothing to
// assemble and no API to call — the whole job is (1) collecting the rows a page
// shows, (2) giving each file the name the row already knows
// («Артист - Название.mp3» rather than a translit slug), and (3) running a list
// one file at a time instead of handing the browser forty parallel transfers.
//
// The rows are the one stable anchor here: `.playlist__item` with
// `data-artist` / `data-name` / `data-track-id` is Musify's own markup, used by
// its grid player, and it is the same on the charts, an album, an artist page
// and search results.
(() => {
  const BUTTON_CLASS = 'nova-musify-btn';
  const ROW_SELECTOR = '.playlist__item';
  const DOWNLOAD_SELECTOR = 'a[href*="/track/dl/"]';
  // Musify's own per-row action group: queue, playlist and its download link.
  // A real class, not a hashed one (I20), and a direct child of every row.
  const ACTIONS_SELECTOR = '.tracklist__actions';
  const BATCH_LIMIT = 100;

  let menu;
  let busy = false;
  let toastBox;

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'nova-log', tag: `musify/${tag}`, text }).catch(() => {});
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

  // ---- page scan -------------------------------------------------------------

  // The PLAY endpoint, not the download one. Measured with no cookies at all:
  //   /track/pl/<id>/<slug>.mp3 → 302 → https://<n>s.musify.club/get/…?expires=…&sig=…
  //                             → 206 audio/mpeg, Content-Range …/8641434 (the whole track)
  //   /track/dl/<id>/<slug>.mp3 → 302 → /login?ReturnUrl=…&src=download-gate
  // So `dl` is the site's download gate and `pl` is the file, and `pl` needs no
  // account — which is the whole reason this adapter uses it. The slug segment
  // is not checked (a wrong one still resolves, and the redirect carries the
  // real filename), it only has to be present: `/track/pl/<id>` alone is a 404.
  // The slug segment is not validated — `/track/pl/22265536/x.mp3` resolves the
  // same as the real one — but it has to be there: `/track/pl/<id>` is a 404.
  // The row's `dl` link is still what says a file EXISTS at all: the two rows
  // per chart page that carry no such link answer `pl` with 404 as well, so
  // they are listed as unavailable rather than offered and failed.
  function playUrl(id, link) {
    const slug = (link.getAttribute('href') || '').split('/').pop();
    return slug ? `${location.origin}/track/pl/${encodeURIComponent(id)}/${slug}` : '';
  }

  function readRow(row) {
    const link = row.querySelector(DOWNLOAD_SELECTOR);
    const id = row.getAttribute('data-track-id') || row.getAttribute('data-song-id') || '';
    return {
      id,
      artist: row.getAttribute('data-artist') || '',
      title: row.getAttribute('data-name') || '',
      url: id && link ? playUrl(id, link) : '',
      restricted: row.getAttribute('data-copyrighted') === 'true',
    };
  }

  function tracksOnPage() {
    const tracks = [];
    const seen = new Set();
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const track = readRow(row);
      if (!track.title || !track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
      if (tracks.length >= BATCH_LIMIT) break;
    }
    return tracks;
  }

  function pageLabel() {
    if (/^\/release\//.test(location.pathname)) return 'этого альбома';
    if (/^\/artist\//.test(location.pathname)) return 'этого исполнителя';
    if (/^\/charts/.test(location.pathname)) return 'этого чарта';
    if (/^\/playlist/.test(location.pathname)) return 'этого плейлиста';
    return 'этой страницы';
  }

  // ---- downloads -------------------------------------------------------------

  function fileNameFor(track) {
    const artist = safeName(track.artist);
    const title = safeName(track.title);
    return `${artist ? `${artist} - ` : ''}${title || track.id}.mp3`;
  }

  // Musify branches on the `Accept` header, and on nothing else. Measured on
  // one URL, changing one header at a time:
  //
  //   Accept: text/html,…   -> 200, a 1275-byte anti-leech page  (SERVER_FORBIDDEN)
  //   Accept: */*           -> 302 to the signed CDN URL
  //   Accept: audio/*,*/*   -> 302 to the signed CDN URL
  //
  // `Sec-Fetch-Dest: document` and the rest of the navigation shape make no
  // difference at all. chrome.downloads sends `Accept: text/html,…` by default,
  // which is why handing it `/track/pl/…` failed, and it takes a `headers`
  // option — so the fix is one header, and the browser does the transfer with
  // no bytes passing through the extension at all. The page could never do it:
  // the CDN sends no `Access-Control-Allow-Origin`.
  async function saveDirect(url, filename) {
    const saved = await chrome.runtime.sendMessage({
      t: 'nova-save', url, filename, headers: [{ name: 'Accept', value: '*/*' }],
    });
    if (!saved?.ok) throw new Error(saved?.error || 'браузер не принял файл на сохранение');
    return saved.id;
  }

  async function followBrowserDownload(id, notification, stage) {
    let misses = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const state = await chrome.runtime.sendMessage({ t: 'nova-download-state', id }).catch(() => null);
      if (!state?.ok) {
        // A download the browser has not registered yet is normal for a moment.
        if (++misses > 8) throw new Error(state?.error || 'браузер потерял загрузку');
        continue;
      }
      misses = 0;
      // Belt and braces for the day Musify changes its mind again: a page
      // saved under an .mp3 name is worse than an honest refusal, so it is
      // stopped as soon as the headers name it, before the file lands.
      if (/text\/html/i.test(state.mime || '')) {
        await chrome.runtime.sendMessage({ t: 'nova-cancel-download', id }).catch(() => {});
        throw new Error('Musify вернул страницу вместо файла — трек недоступен для скачивания');
      }
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
    if (!track.url) throw new Error('у этого трека нет ссылки на скачивание');
    const filename = fileNameFor(track);
    notification.stage(stage, null, 'active', 'Скачивание файла');
    const id = await saveDirect(track.url, filename);
    await followBrowserDownload(id, notification, stage);
    log('track', `saved ${track.id}`);
    return filename;
  }

  async function runOne(track) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    try {
      notification.begin(`Скачиваю: ${track.title}`, [{ id: 'file', label: 'Скачивание файла' }]);
      notification.stage('file', null, 'active', 'Скачивание файла');
      const filename = await downloadOne(track, notification, 'file');
      notification.stage('file', 1, 'done', 'Скачивание файла');
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(4000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(8000);
      void reportError('musify-download', error, { id: track.id });
    } finally {
      busy = false;
    }
  }

  // One at a time. Musify rate-limits an anonymous visitor, and forty parallel
  // transfers is exactly the shape that trips it — the whole list then fails
  // instead of the tail of it.
  async function runAll(tracks) {
    if (busy) return;
    busy = true;
    const notification = getToast();
    let done = 0;
    let failed = 0;
    try {
      notification.begin(`Скачиваю ${tracks.length} треков…`, [
        { id: 'list', label: 'Треки' },
        { id: 'file', label: 'Текущий файл' },
      ]);
      for (const track of tracks) {
        notification.stage('list', done / tracks.length, 'active',
          `Трек ${done + 1} из ${tracks.length}: ${track.title}`);
        try {
          await downloadOne(track, notification, 'file');
        } catch (error) {
          // A track Musify refuses is that track's problem, not the list's:
          // the rest of the page still downloads.
          failed += 1;
          log('batch', `track ${track.id} failed: ${String(error?.message || error)}`);
        }
        done += 1;
      }
      notification.stage('list', 1, 'done', 'Треки');
      notification.stage('file', 1, 'done', 'Текущий файл');
      notification.set(failed
        ? `Готово: ${done - failed} из ${tracks.length} · не удалось: ${failed}`
        : `Готово: ${done} треков`, 1);
      notification.hide(9000);
    } catch (error) {
      notification.set(`Ошибка: ${String(error?.message || error).slice(0, 140)}`, 1);
      notification.hide(8000);
      void reportError('musify-batch', error, { count: tracks.length });
    } finally {
      busy = false;
    }
  }

  // ---- toast -----------------------------------------------------------------

  let toastTimer;

  function getToast() {
    if (!toastBox) {
      toastBox = createElement('div', 'nova-musify-toast');
      const text = createElement('div', 'nova-musify-toast-text');
      const bar = createElement('div', 'nova-musify-toast-bar');
      bar.append(createElement('i'));
      const stages = createElement('div', 'nova-musify-stages');
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
          const row = createElement('div', 'nova-musify-stage queued');
          row.dataset.stage = definition.id;
          const head = createElement('div', 'nova-musify-stage-head');
          head.append(createElement('span', 'nova-musify-stage-label', definition.label),
            createElement('span', 'nova-musify-stage-value', 'ожидание'));
          const bar = createElement('div', 'nova-musify-stage-bar');
          bar.append(createElement('i'));
          row.append(head, bar);
          toastBox._stages.append(row);
        }
        toastBox._stages.classList.add('show');
      },
      stage(id, fraction, state = 'active', label) {
        const row = toastBox?._stages.querySelector(`[data-stage="${id}"]`);
        if (!row) return;
        row.className = `nova-musify-stage ${state}`;
        if (label) row.querySelector('.nova-musify-stage-label').textContent = label;
        const value = row.querySelector('.nova-musify-stage-value');
        const fill = row.querySelector('.nova-musify-stage-bar i');
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
    const item = createElement('div', `nova-musify-item${onClick ? '' : ' nova-musify-muted'}`);
    if (onClick) {
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.addEventListener('click', () => { closeMenu(); onClick(); });
    }
    item.append(createElement('span', 'nova-musify-text', text));
    if (hint) item.append(createElement('span', 'nova-musify-hint', hint));
    menu.append(item);
    return item;
  }

  // The button belongs to one row, so its menu leads with that row's track and
  // keeps the whole-page download as the second entry — the batch is worth
  // having and there is no longer a separate button to hang it on.
  function openMenu(button, row, event) {
    event.preventDefault();
    event.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = createElement('div', 'nova-musify-menu');
    menu.append(createElement('div', 'nova-musify-head',
      `Nova Video Saver v${chrome.runtime.getManifest().version}`));
    document.body.appendChild(menu);
    document.addEventListener('click', onOutsideClick, true);

    const own = readRow(row);
    const available = tracksOnPage().filter((track) => track.url);
    addItem(
      `${own.artist ? `${own.artist} — ` : ''}${own.title}`,
      own.url ? 'MP3' : (own.restricted ? 'закрыт правообладателем' : 'нет файла на сайте'),
      own.url ? () => void runOne(own) : null,
    );
    if (available.length > 1) {
      addItem(`Скачать все треки ${pageLabel()}`, `${available.length} шт.`,
        () => void runAll(available));
    }
    positionMenu(button);
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

  // One button per row, in the row's own action group next to Musify's queue and
  // playlist buttons — a real, unhashed class (`tracklist__actions`), present on
  // every row of every list page (checked: 40 of 40 on /charts).
  function mountInRow(row) {
    const actions = row.querySelector(ACTIONS_SELECTOR);
    if (!actions) return;
    const id = row.getAttribute('data-track-id') || row.getAttribute('data-song-id') || '';
    if (!id) return;
    const existing = actions.querySelector(`.${BUTTON_CLASS}`);
    // Musify swaps list contents in over ajax and reuses the markup, so a
    // button left over from another track would download the wrong file.
    if (existing) {
      if (existing.dataset.novaTrack === id) return;
      existing.remove();
    }
    const button = document.createElement('button');
    button.className = `${BUTTON_CLASS} nova-musify-row-btn`;
    button.type = 'button';
    button.dataset.novaTrack = id;
    button.title = 'Скачать трек (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    button.append(createIcon());
    button.addEventListener('click', (event) => { openMenu(button, row, event); });
    actions.prepend(button);
  }

  function ensureButtons() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) mountInRow(row);
  }

  // An interval, not requestAnimationFrame: rAF never runs in a hidden tab
  // (N29), and Musify swaps its lists in over ajax without a page load.
  setInterval(() => { try { ensureButtons(); } catch (error) {} }, 1500);
  document.addEventListener('visibilitychange', () => { try { ensureButtons(); } catch (error) {} });
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  try { ensureButtons(); } catch (error) {}
})();
