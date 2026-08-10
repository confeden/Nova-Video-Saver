// Isolated-world UI and the only bridge between the page hook and extension APIs.
(() => {
  const BUTTON_ID = 'nova-download-btn';
  const IS_MUSIC = location.hostname === 'music.youtube.com';
  // Evaluated per call: YouTube moves between /watch and /shorts without a
  // page load, and the reel feed rewrites the URL on every swipe.
  const SHORTS_PATH = /^\/shorts\/[A-Za-z0-9_-]{6,}/;
  const IS_SHORTS = () => !IS_MUSIC && SHORTS_PATH.test(location.pathname);
  const IS_DOWNLOADABLE_PAGE = () => location.pathname === '/watch' || IS_SHORTS();
  const TO_HOOK = '__nova_to_hook';
  const FROM_HOOK = '__nova_from_hook';
  const TO_UI = '__nova_to_ui';
  const FROM_UI = '__nova_from_ui';
  const RELAYED_MESSAGES = new Set(['nova-log', 'nova-fetch-caption']);
  const TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;

  let requestSequence = 1;
  let menu;
  let menuOpening = false;
  let downloadInProgress = false;
  let toastHideTimer;
  let buttonFrame;
  const pendingRequests = new Map();

  function postToPage(payload) {
    window.postMessage(payload, location.origin);
  }

  // Mirrors the page hook's element resolution. A Shorts page holds both an
  // empty leftover #movie_player and the reel's real #shorts-player, and the
  // feed keeps neighbouring reels mounted, so the first <video> in document
  // order is not reliably the one being watched.
  function activeMediaElement() {
    const reel = document.getElementById('shorts-player');
    const watch = document.getElementById('movie_player');
    const host = IS_SHORTS() ? (reel || watch) : (watch || reel);
    return host?.querySelector('video') || document.querySelector('video');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || !event.data) return;
    const data = event.data;

    if (data[TO_UI] === true) {
      const { reqId, msg } = data;
      if (!msg || !RELAYED_MESSAGES.has(msg.t)) return;
      chrome.runtime.sendMessage(msg)
        .then((response) => {
          if (Number.isSafeInteger(reqId)) postToPage({ [FROM_UI]: true, reqId, ok: true, resp: response });
        })
        .catch((error) => {
          if (Number.isSafeInteger(reqId)) {
            postToPage({ [FROM_UI]: true, reqId, ok: false, error: String(error?.message || error) });
          }
        });
      return;
    }

    if (data[FROM_HOOK] !== true) return;
    const pending = pendingRequests.get(data.reqId);
    if (!pending) return;
    if (data.progress != null && !data.done) {
      pending.touch?.();
      pending.onProgress?.(data);
      return;
    }
    pendingRequests.delete(data.reqId);
    clearTimeout(pending.timeout);
    if (data.ok === false) {
      const error = new Error(data.error || 'page hook failed');
      error.details = data.details;
      pending.reject(error);
    } else pending.resolve(data);
  });

  function callHook(cmd, payload = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const reqId = requestSequence++;
      const timeoutMs = cmd === 'download' ? 70_000
        : (cmd === 'live-start' ? 180_000 : (cmd === 'subtitles' ? 120_000 : 15_000));
      let timeout;
      const touch = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          pendingRequests.delete(reqId);
          reject(new Error(cmd === 'download'
            ? 'захват медиаданных не отвечает более 70 секунд'
            : `page hook timed out (${cmd})`));
        }, timeoutMs);
        const pending = pendingRequests.get(reqId);
        if (pending) pending.timeout = timeout;
      };
      pendingRequests.set(reqId, { resolve, reject, onProgress, timeout, touch });
      touch();
      postToPage({ [TO_HOOK]: true, cmd, reqId, ...payload });
    });
  }

  async function reportError(context, error, details) {
    const text = String(error?.stack || error?.message || error);
    console.error('[Nova Video Saver]', error);
    return sendWorkerMessage({ t: 'nova-error', context, error: text, details }, 30_000).catch(() => null);
  }

  function sendRuntimeMessage(message, timeoutMs) {
    if (!timeoutMs) return chrome.runtime.sendMessage(message);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`extension message timed out (${message.t})`)), timeoutMs);
    });
    return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => clearTimeout(timer));
  }

  // The MV3 service worker can be mid-shutdown when a message arrives; the
  // send then fails even though the worker is back a moment later. Only
  // idempotent worker-side requests may be retried — a repeated nova-chunk
  // would duplicate track data.
  const WORKER_RETRY_DELAYS = [150, 400, 1_000, 2_500];

  function isWorkerAsleep(error) {
    return /could not establish connection|receiving end does not exist|message port closed/i
      .test(String(error?.message || error));
  }

  async function sendWorkerMessage(message, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendRuntimeMessage(message, timeoutMs);
      } catch (error) {
        if (attempt >= WORKER_RETRY_DELAYS.length || !isWorkerAsleep(error)) throw error;
        await new Promise((resolve) => { setTimeout(resolve, WORKER_RETRY_DELAYS[attempt]); });
      }
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }


  // The brand icon everywhere: a perfectly round ring with two equilateral
  // down-arrows that touch (the upper apex meets the lower triangle's edge).
  function createCircleIcon() {
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

  // The Shorts variant deliberately does not share .nova-download-btn: that
  // class absolutely-centres the icon on the whole button, which for a button
  // with a caption underneath pushes the icon below the middle of its circle.
  const VARIANT_CLASS = {
    player: 'ytp-button nova-download-btn',
    music: 'nova-download-btn nova-music-btn',
    shorts: 'nova-shorts-btn',
  };

  function createButton(variant) {
    const button = createElement('button', VARIANT_CLASS[variant] || VARIANT_CLASS.player);
    button.id = BUTTON_ID;
    button.type = 'button';
    button.dataset.novaVariant = variant;
    button.title = 'NVS (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    if (variant === 'shorts') {
      // Matches the shape of its neighbours in the reel action column: a round
      // tonal button with a caption underneath.
      const circle = createElement('span', 'nova-shorts-circle');
      circle.append(createCircleIcon());
      button.append(circle, createElement('span', 'nova-shorts-label', 'NVS'));
    } else {
      button.append(createCircleIcon());
    }
    button.addEventListener('click', openMenu);
    return button;
  }

  // Where the button belongs on the current page. One entry per surface: adding
  // another site later means adding a case here and the matching element lookup
  // in the page hook — nothing else in the UI is site-aware.
  function mountTarget() {
    if (IS_MUSIC) {
      // The Music player bar keeps its right-hand controls (volume, repeat…)
      // in ytmusic-player-bar; the button sits immediately left of the volume.
      const bar = document.querySelector('ytmusic-player-bar');
      const volume = bar?.querySelector('tp-yt-paper-icon-button.volume, #volume-slider ~ tp-yt-paper-icon-button, .volume');
      if (volume?.parentElement) return { parent: volume.parentElement, anchor: volume, variant: 'music' };
      const rightControls = bar?.querySelector('.right-controls-buttons');
      return rightControls ? { parent: rightControls, anchor: null, variant: 'music' } : null;
    }
    if (IS_SHORTS()) {
      // Right-hand action column of the reel that currently owns the player —
      // the feed keeps neighbouring reels mounted, and only the watched one
      // holds #shorts-player. The button goes above «Нравится».
      const reel = document.getElementById('shorts-player')?.closest('ytd-reel-video-renderer');
      const actions = reel?.querySelector('reel-action-bar-view-model')
        || document.querySelector('reel-action-bar-view-model');
      return actions ? { parent: actions, anchor: null, variant: 'shorts' } : null;
    }
    const controls = document.querySelector('.ytp-right-controls');
    return controls ? { parent: controls, anchor: null, variant: 'player' } : null;
  }

  let mountedVideoId = null;

  function ensureButton() {
    // Swiping the Shorts feed replaces the video without a navigation event; an
    // open menu would keep offering the previous reel's qualities.
    const currentVideoId = videoIdFromLocation();
    if (currentVideoId !== mountedVideoId) {
      mountedVideoId = currentVideoId;
      if (menu) closeMenu();
    }
    let button = document.getElementById(BUTTON_ID);
    if (!IS_DOWNLOADABLE_PAGE()) {
      button?.remove();
      return;
    }
    const target = mountTarget();
    if (!target) return;
    // anchor null means "first in the container"; already-correct placement
    // must not re-insert on every mutation tick.
    const placed = button
      && button.dataset.novaVariant === target.variant
      && button.parentElement === target.parent
      && (target.anchor ? button.nextElementSibling === target.anchor
        : target.parent.firstElementChild === button);
    if (placed) return;
    if (button && button.dataset.novaVariant !== target.variant) {
      button.remove();
      button = null;
    }
    if (!button) button = createButton(target.variant);
    if (target.anchor) target.parent.insertBefore(button, target.anchor);
    else target.parent.prepend(button);
  }

  function scheduleButton() {
    if (buttonFrame) return;
    buttonFrame = requestAnimationFrame(() => {
      buttonFrame = undefined;
      ensureButton();
    });
  }

  function closeMenu() {
    menu?.remove();
    menu = undefined;
    document.removeEventListener('click', closeMenuOnOutsideClick, true);
  }

  function closeMenuOnOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`#${BUTTON_ID}`)) closeMenu();
  }

  function createHeading(text) {
    return createElement('div', 'nova-menu-head', text);
  }

  function createBrandHeading(updateState) {
    const heading = createElement('div', 'nova-menu-head nova-brand-head');
    const label = createElement('span');
    const version = chrome.runtime.getManifest().version;
    const link = createElement('a', null, 't.me/nova_txt');
    link.href = 'https://t.me/nova_txt';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', () => closeMenu());
    label.append(`Nova Video Saver v${version} | `, link);
    heading.append(label);
    if (updateState?.available) {
      const updateLink = createElement('a', 'nova-update-link', 'Доступно обновление');
      updateLink.href = updateState.releaseUrl || 'https://github.com/confeden/Nova-Video-Saver/releases';
      updateLink.target = '_blank';
      updateLink.rel = 'noopener noreferrer';
      updateLink.title = `Вышла версия ${updateState.latest || ''} — открыть страницу релиза`.trim();
      updateLink.addEventListener('click', () => closeMenu());
      heading.append(updateLink);
    }
    return heading;
  }

  function setItemLabel(item, title, description) {
    item.append(createElement('b', null, title));
    if (description) item.append(' ', createElement('span', 'nova-ext', description));
  }

  // Every audio download is format 'mp3' for the page hook (identical capture
  // path); audioFormat only changes how the offscreen encoder packages it.
  // The list is built per-video: passthrough of the real source codec first,
  // then re-encodes ordered by descending quality. YouTube sources are always
  // lossy (Opus/AAC), so lossless containers (FLAC/WAV) are never offered.
  function audioFormatsFor(info) {
    const codec = info?.audioSource?.codec || '';
    const bitrate = Number(info?.audioSource?.bitrateKbps) || 0;
    const codecLabel = codec === 'aac' ? 'AAC' : (codec === 'vorbis' ? 'Vorbis' : 'Opus');
    const originalExtension = codec === 'aac' ? '.m4a' : (codec === 'vorbis' ? '.ogg' : '.opus');
    const formats = [{
      id: 'original',
      title: `Оригинал (${codecLabel})`,
      note: `как в источнике${bitrate ? `, ~${bitrate} кбит/с` : ''} · без перекодирования`,
      extension: originalExtension,
    }];
    // Re-encoding AAC back into AAC would only lose quality: when the source
    // is AAC the passthrough above already produces the best possible .m4a.
    if (codec !== 'aac') {
      formats.push({ id: 'm4a', title: 'M4A (AAC)', note: '256 кбит/с · с обложкой', extension: '.m4a' });
    }
    formats.push({ id: 'mp3', title: 'MP3', note: 'VBR V0, ~245 кбит/с · с обложкой', extension: '.mp3' });
    return formats;
  }

  function audioFormatMeta(audioFormat, info) {
    return audioFormatsFor(info).find((entry) => entry.id === audioFormat)
      || { id: audioFormat, title: String(audioFormat || 'mp3').toUpperCase(), extension: '.mp3' };
  }

  function addDownloadItems(info, { videoAllowed = true } = {}) {
    if (videoAllowed) {
      menu.append(createHeading('Видео'));
      const heights = [...new Set(info.heights || [])].sort((a, b) => b - a);
      for (const height of heights) {
        const item = createElement('div', 'nova-menu-item');
        setItemLabel(item, `${height}p`, 'MP4 video');
        item.addEventListener('click', () => {
          closeMenu();
          startDownload({ format: 'mp4', height }, info);
        });
        menu.append(item);
      }
    }

    menu.append(createHeading('Аудио'));
    for (const audio of audioFormatsFor(info)) {
      const item = createElement('div', 'nova-menu-item');
      setItemLabel(item, audio.title, audio.note);
      item.addEventListener('click', () => {
        closeMenu();
        startDownload({ format: 'mp3', height: null, audioFormat: audio.id }, info);
      });
      menu.append(item);
    }
  }

  function addLiveSection(info) {
    menu.append(createHeading('Прямая трансляция'));
    const options = [
      { from: 'start', title: 'Записать эфир с начала', note: 'докачает DVR-буфер быстрее реального времени и продолжит запись' },
      { from: 'now', title: 'Записать с текущего момента', note: 'запись до конца эфира или до остановки' },
    ];
    for (const option of options) {
      const item = createElement('div', 'nova-menu-item');
      setItemLabel(item, option.title, option.note);
      item.addEventListener('click', () => {
        closeMenu();
        void startLiveRecording(info, option.from);
      });
      menu.append(item);
    }
  }

  function addPlaylistSection(info, items) {
    menu.append(createHeading('Плейлист'));
    const item = createElement('div', 'nova-menu-item');
    setItemLabel(item, 'Скачать плейлист…', `${items.length} видео, выбор в списке`);
    item.addEventListener('click', () => {
      closeMenu();
      openPlaylistPicker(info, items);
    });
    menu.append(item);
  }

  function addSubtitleItems(info, availability) {
    menu.append(createHeading('Субтитры'));
    if (!availability?.available) {
      const item = createElement('div', 'nova-menu-item disabled');
      setItemLabel(item, '.srt', 'недоступны');
      item.title = 'Субтитры недоступны для этого видео';
      menu.append(item);
      return;
    }

    const language = availability.lang || 'доступный';
    const formats = [
      ['.srt', 'srt', 'SRT (с тайм-кодами)'],
      ['.txt', 'txt', 'простой текст (без тайм-кодов)'],
    ];
    for (const [extension, format, description] of formats) {
      const item = createElement('div', 'nova-menu-item');
      setItemLabel(item, extension, `${language} · ${description}`);
      item.addEventListener('click', () => {
        closeMenu();
        downloadSubtitles(info, format);
      });
      menu.append(item);
    }
  }

  function addRadioSelector(heading, storageKey, options, current) {
    menu.append(createHeading(heading));
    let selected = current;
    const rows = options.map((option) => {
      const row = createElement('div', `nova-menu-radio${selected === option.value ? ' sel' : ''}`);
      const text = createElement('span', 'nova-radio-txt');
      text.append(createElement('b', null, option.title), createElement('i', null, option.note));
      row.append(createElement('span', 'nova-dot'), text);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        selected = option.value;
        chrome.storage.local.set({ [storageKey]: selected }).catch((error) => reportError('ui/settings', error));
        rows.forEach((item, index) => item.classList.toggle('sel', options[index].value === selected));
      });
      return row;
    });
    menu.append(...rows);
  }

  function addFormatSelector(transcode) {
    addRadioSelector('Кодек видео', 'transcode', [
      { value: false, title: 'Оригинал (без перекодирования)', note: 'исходное качество и минимальный размер — рекомендуется' },
      { value: true, title: 'Сжатый MP4 (H.264)', note: 'аппаратное перекодирование, почти без потерь; для старых плееров и ТВ' },
    ], Boolean(transcode));
  }

  async function openMenu(event) {
    event.stopPropagation();
    if (menu) {
      closeMenu();
      return;
    }
    if (menuOpening) return;
    menuOpening = true;

    try {
      const [info, availability, settings, updateStored] = await Promise.all([
        callHook('info'),
        callHook('subs-available'),
        chrome.storage.local.get(['transcode']),
        chrome.storage.local.get('nova_update').catch(() => ({})),
      ]);
      menu = createElement('div', 'nova-menu');
      menu.append(createBrandHeading(updateStored?.nova_update));
      if (info.isLive) {
        addLiveSection(info);
      } else {
        // Music "songs" (art tracks) have no real footage — the video stream is
        // a static cover rendered as video, so only audio options make sense.
        const artTrackOnly = IS_MUSIC && info.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV';
        addDownloadItems(info, { videoAllowed: !artTrackOnly });
        const playlistItems = playlistIdFromLocation() ? scrapePlaylistItems() : [];
        if (playlistItems.length > 1) addPlaylistSection(info, playlistItems);
        addSubtitleItems(info, availability);
        if (!artTrackOnly) addFormatSelector(settings.transcode);
      }
      document.body.append(menu);

      const buttonRect = document.getElementById(BUTTON_ID)?.getBoundingClientRect();
      if (buttonRect) {
        menu.style.right = `${Math.max(8, window.innerWidth - buttonRect.right)}px`;
        // Upward from the button is the default — that is where the anchor sits
        // in the player control bar. The Shorts action column is mid-screen, so
        // fall back to dropping the menu downward when there is no room above.
        const height = menu.getBoundingClientRect().height;
        if (buttonRect.top - height - 8 >= 8) {
          menu.style.bottom = `${window.innerHeight - buttonRect.top + 8}px`;
        } else {
          menu.style.top = `${Math.max(8, Math.min(buttonRect.bottom + 8, window.innerHeight - height - 8))}px`;
        }
      }
      setTimeout(() => document.addEventListener('click', closeMenuOnOutsideClick, true));
    } catch (error) {
      const notification = getToast();
      notification.set(`Ошибка: ${error.message || error}`, 1);
      notification.hide(6000);
      await reportError('ui/menu', error);
    } finally {
      menuOpening = false;
    }
  }

  function getToast() {
    let box = document.getElementById('nova-toast');
    if (!box) {
      box = createElement('div');
      box.id = 'nova-toast';
      const bar = createElement('div', 'nova-toast-bar');
      bar.append(createElement('i'));
      const cancelButton = createElement('button', 'nova-toast-cancel', 'Отменить загрузку');
      cancelButton.type = 'button';
      cancelButton.hidden = true;
      cancelButton.addEventListener('click', () => box.__novaCancel?.());
      box.append(createElement('span', 'nova-toast-txt'), bar, createElement('div', 'nova-toast-stages'), cancelButton);
      document.body.append(box);
    }
    const text = box.querySelector('.nova-toast-txt');
    const legacyBar = box.querySelector(':scope > .nova-toast-bar');
    const progress = legacyBar.querySelector('i');
    const stages = box.querySelector('.nova-toast-stages');
    const cancel = box.querySelector('.nova-toast-cancel');
    const hideCancel = () => {
      box.__novaCancel = null;
      cancel.hidden = true;
    };
    return {
      set(message, fraction = 0) {
        clearTimeout(toastHideTimer);
        text.textContent = message;
        stages.replaceChildren();
        stages.classList.remove('show');
        legacyBar.hidden = false;
        progress.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
        hideCancel();
        box.classList.add('show');
      },
      setCancel(handler, label = 'Отменить загрузку') {
        if (!handler) {
          hideCancel();
          return;
        }
        box.__novaCancel = handler;
        cancel.textContent = label;
        cancel.hidden = false;
      },
      beginStages(message, definitions) {
        clearTimeout(toastHideTimer);
        text.textContent = message;
        legacyBar.hidden = true;
        stages.replaceChildren();
        for (const definition of definitions) {
          const row = createElement('div', 'nova-stage queued');
          row.dataset.stage = definition.id;
          const header = createElement('div', 'nova-stage-head');
          header.append(createElement('span', 'nova-stage-label', definition.label), createElement('span', 'nova-stage-value', 'ожидание'));
          const bar = createElement('div', 'nova-stage-bar');
          bar.append(createElement('i'));
          row.append(header, bar);
          stages.append(row);
        }
        stages.classList.add('show');
        box.classList.add('show');
      },
      stage(id, fraction, state = 'active', label) {
        const row = stages.querySelector(`[data-stage="${id}"]`);
        if (!row) return;
        row.className = `nova-stage ${state}`;
        if (label) row.querySelector('.nova-stage-label').textContent = label;
        const value = row.querySelector('.nova-stage-value');
        const bar = row.querySelector('.nova-stage-bar i');
        if (Number.isFinite(fraction)) {
          const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
          value.textContent = state === 'done' ? 'готово' : `${percent}%`;
          bar.style.width = `${percent}%`;
        } else {
          value.textContent = state === 'active' ? 'запуск…' : (state === 'error' ? 'ошибка' : 'ожидание');
          bar.style.width = state === 'done' ? '100%' : '0%';
        }
      },
      hide(delay = 0) {
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => box.classList.remove('show'), delay);
      },
    };
  }

  function safeFilename(value) {
    return (value || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function formatCueTime(seconds, separator) {
    const value = Math.max(0, seconds);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const wholeSeconds = Math.floor(value % 60);
    const milliseconds = Math.floor((value - Math.floor(value)) * 1000);
    const pad = (number, length = 2) => String(number).padStart(length, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${separator}${pad(milliseconds, 3)}`;
  }

  function normalizeCues(cues) {
    if (!Array.isArray(cues)) return [];
    const sorted = cues
      .filter((cue) => cue?.text?.trim())
      .map((cue) => ({ start: Number(cue.start) || 0, end: Number(cue.end) || 0, text: cue.text.trim() }))
      .sort((a, b) => a.start - b.start);

    return sorted.map((cue, index) => {
      const next = sorted[index + 1];
      const minimumDuration = Math.max(1.2, Math.min(6, cue.text.length * 0.07));
      if (next && next.start <= cue.start) next.start = cue.start + 0.5;
      const end = next
        ? Math.max(cue.start + minimumDuration, Math.min(next.start, cue.start + 5))
        : Math.max(cue.start + minimumDuration, cue.end || cue.start + 4);
      return { ...cue, end };
    });
  }

  function buildTimedSubtitles(cues, format) {
    const lines = format === 'vtt' ? ['WEBVTT', ''] : [];
    normalizeCues(cues).forEach((cue, index) => {
      if (format !== 'vtt') lines.push(String(index + 1));
      const separator = format === 'vtt' ? '.' : ',';
      lines.push(`${formatCueTime(cue.start, separator)} --> ${formatCueTime(cue.end, separator)}`);
      lines.push(cue.text, '');
    });
    return `${lines.join('\r\n').replace(/(\r?\n)+$/, '')}\r\n`;
  }

  const SUBTITLE_OUTPUTS = Object.freeze({
    srt: { extension: 'srt', mime: 'application/x-subrip', timed: true },
    vtt: { extension: 'vtt', mime: 'text/vtt', timed: true },
    txt: { extension: 'txt', mime: 'text/plain', timed: false },
  });

  async function downloadSubtitles(info, format) {
    const notification = getToast();
    notification.set(`Загружаю субтитры (${format || 'txt'})…`, 0.3);
    try {
      const output = SUBTITLE_OUTPUTS[format];
      if (!output) throw new Error(`неизвестный формат субтитров: ${format}`);
      const response = await callHook('subtitles');
      const language = response.lang || 'txt';
      if (output.timed && !response.cues?.length) {
        throw new Error(`не удалось сформировать .${output.extension}: отсутствуют таймкоды`);
      }
      const content = output.timed ? buildTimedSubtitles(response.cues, output.extension) : response.text;
      const filename = `${safeFilename(info.title)} [${language}].${output.extension}`;
      const url = `data:${output.mime};charset=utf-8,${encodeURIComponent(`\uFEFF${content}`)}`;
      const saved = await sendWorkerMessage({ t: 'nova-save', url, filename }, 30_000);
      if (!saved?.ok) throw new Error(saved?.error || 'не удалось сохранить субтитры');
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(4000);
    } catch (error) {
      notification.set(`Ошибка: ${error.message || error}`, 1);
      notification.hide(6000);
      await reportError('ui/subtitles', error, { format, videoId: info.videoId });
    }
  }

  async function startDownload({ format, height, audioFormat = 'mp3' }, info, options = {}) {
    const notification = getToast();
    if (downloadInProgress) {
      notification.set('Другая загрузка уже выполняется', 1);
      notification.hide(4000);
      return 'busy';
    }
    downloadInProgress = true;
    if (!options.freshPageResume) await clearReloadGuard();

    const isMp3 = format === 'mp3';
    const primedMedia = activeMediaElement();
    const requestedMediaState = options.restoreMediaState;
    const primedState = primedMedia ? {
      paused: typeof requestedMediaState?.paused === 'boolean'
        ? requestedMediaState.paused : primedMedia.paused,
      time: Number.isFinite(Number(requestedMediaState?.time))
        ? Math.max(0, Number(requestedMediaState.time)) : primedMedia.currentTime,
      muted: typeof requestedMediaState?.muted === 'boolean'
        ? requestedMediaState.muted : primedMedia.muted,
    } : null;
    if (primedMedia && requestedMediaState && primedState) {
      // A clean retry must capture the opening fragments before returning to
      // the user's position. Restore the saved state only after the tracks have
      // been received; applying it here made every retry begin around 20 s.
      try { primedMedia.currentTime = 0; } catch (error) {}
      try { primedMedia.muted = true; } catch (error) {}
      primedMedia.pause();
    }
    if (IS_MUSIC && primedMedia && primedState) {
      // ytmusic auto-advances to the next queue item when a playing track
      // ends, and downloads seek near the end: every Music download runs
      // paused and the track stays paused afterwards.
      primedState.paused = true;
      try { primedMedia.pause(); } catch (error) {}
    }
    let primedStateRestored = false;
    let reloadScheduled = false;
    const restorePrimedMedia = () => {
      if (!primedMedia || !primedState || primedStateRestored) return;
      primedStateRestored = true;
      try { primedMedia.currentTime = primedState.time; } catch (error) {}
      try { primedMedia.muted = primedState.muted; } catch (error) {}
      if (primedState.paused) primedMedia.pause();
      else primedMedia.play().catch(() => {});
    };
    const audioMeta = audioFormatMeta(audioFormat, info);
    const label = isMp3 ? audioMeta.title : `${height}p`;
    const processingLabel = isMp3 ? 'Кодирование аудио' : 'Склейка / кодирование';
    notification.beginStages(`Подготовка ${label}…`, [
      { id: 'capture', label: 'Получение сегментов' },
      { id: 'engine', label: 'Запуск медиадвижка' },
      { id: 'transfer', label: 'Передача и сборка' },
      { id: 'process', label: processingLabel },
    ]);
    notification.stage('capture', 0, 'active');
    notification.stage('engine', null, 'active');
    let scaleDown = false;
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

    let cancelRequested = false;
    notification.setCancel(() => {
      if (cancelRequested) return;
      cancelRequested = true;
      notification.setCancel(null);
      // Cancelling one item of a running playlist queue stops the whole queue.
      void clearQueue();
      try { sessionStorage.removeItem('nvs_queue_token'); } catch (error) {}
      document.getElementById('nova-queue')?.remove();
      void callHook('download-cancel').catch(() => {});
      if (IS_MUSIC) void callHook('music-mute', { mute: false }).catch(() => {});
      void sendRuntimeMessage({ t: 'nova-abort', jobId }, 10_000).catch(() => {});
    });

    const onFfmpegProgress = (message) => {
      if (message?.t !== 'nova-progress' || message.jobId !== jobId) return;
      const value = Math.max(0, Math.min(1, message.value || 0));
      const fallback = isMp3
        ? 'Кодирование аудио'
        : (scaleDown ? 'Уменьшение видео' : 'Склейка / кодирование');
      notification.stage('process', value, value >= 1 ? 'done' : 'active', message.status || fallback);
    };
    chrome.runtime.onMessage.addListener(onFfmpegProgress);

    try {
      // Loading the wasm core is expensive. Start it in parallel with segment
      // capture; actual ffmpeg execution still waits for a complete container.
      const warmup = warmupMediaProcessor().then(
        () => notification.stage('engine', 1, 'done'),
        () => notification.stage('engine', null, 'queued', 'Повторный запуск медиадвижка'),
      );
      const { transcode = false } = await chrome.storage.local.get(['transcode']);
      const captured = await callHook('download', {
        height,
        format,
        end: Number(info.duration) || 0,
        freshPageResume: Boolean(options.freshPageResume),
        reloadCount: Math.max(0, Number(options.reloadCount) || 0),
      }, (message) => {
        let captureLabel = 'Получение сегментов';
        if (message.paused) captureLabel = 'Приостановлено пользователем';
        else if (message.phase === 'rendered-audio') captureLabel = 'Захват звука плеера (1×)';
        else if (message.phase === 'rendered-video') captureLabel = 'Запись видео плеера (1×)';
        else if (message.phase === 'direct-audio') captureLabel = 'Прямая загрузка аудио';
        else if (message.phase === 'assembling') captureLabel = 'Проверка полученных дорожек';
        else if (message.phase === 'buffering-prefix') captureLabel = 'Проверка крайних сегментов';
        else if (message.phase === 'buffering-gap') captureLabel = 'Докачка пропущенного сегмента';
        else if (message.phase === 'rendered-prefix') captureLabel = 'Восстановление только начала видео (1×)';
        else if (message.phase === 'mse-sequential-video') captureLabel = 'Проверка непрерывности видео';
        notification.stage('capture', message.progress, message.progress >= 1 ? 'done' : 'active', captureLabel);
      });
      restorePrimedMedia();
      // The hook may have finished a phase without a cancellation checkpoint;
      // never save a file the user has already cancelled.
      if (cancelRequested) {
        const cancelledError = new Error('загрузка отменена пользователем');
        cancelledError.details = { cancelled: true };
        throw cancelledError;
      }
      notification.stage('capture', 1, 'done');
      // Transfer/processing cannot be interrupted mid-ffmpeg; hide the button.
      notification.setCancel(null);

      const actualHeight = !isMp3 && Number(captured.actualHeight) > 0 ? Number(captured.actualHeight) : height;
      scaleDown = !isMp3 && actualHeight > height;
      const unavailableHigherQuality = !isMp3 && actualHeight < height;
      const outputHeight = isMp3 ? null : (scaleDown ? height : actualHeight);
      const shouldTranscode = isMp3 || Boolean(transcode) || scaleDown || Boolean(captured.forceTranscode);
      const processStatus = isMp3
        ? 'Кодирование аудио'
        : (scaleDown
          ? `Уменьшение ${actualHeight}p до ${height}p`
          : (unavailableHigherQuality
            ? `Склейка ${actualHeight}p без апскейлинга`
            : (shouldTranscode ? 'Перекодирование в H.264/AAC' : 'Склейка дорожек')));

      const extension = isMp3 ? audioMeta.extension : '.mp4';
      const filename = `${safeFilename(info.title)}${isMp3 ? '' : ` [${outputHeight}p]`}${extension}`;
      notification.stage('transfer', 0, 'active', 'Передача и сборка');
      const result = await muxViaOffscreen({
        jobId,
        format,
        audioFormat: isMp3 ? audioFormat : null,
        audioQuality: 'best',
        videoId: info.videoId || '',
        video: isMp3 ? null : captured._v,
        videoPrefix: isMp3 ? null : captured._vp,
        audio: captured._a,
        videoMime: captured.video?.mime,
        videoPrefixMime: captured.videoPrefix?.mime,
        videoPrefixBoundary: Number(captured.videoPrefix?.boundary) || 0,
        audioMime: captured.audio?.mime,
        audioCaptureRate: Number(captured.audio?.captureRate) || 1,
        filename,
        transcode: shouldTranscode,
        scaleHeight: scaleDown ? height : 0,
        duration: Number(captured.duration) || Number(info.duration) || 0,
      }, (stage, fraction, state, stageLabel) => {
        notification.stage(stage, fraction, state, stageLabel);
      });
      if (!result?.ok) {
        const error = new Error(result?.error || 'не удалось собрать файл');
        error.logged = Boolean(result?.logged);
        error.recovered = Boolean(result?.recovered);
        throw error;
      }
      notification.stage('engine', 1, 'done');
      notification.stage('transfer', 1, 'done');
      notification.stage('process', 1, 'done', processStatus);
      await clearReloadGuard();
      notification.set(`Готово: ${result.filename || filename}`, 1);
      notification.hide(4000);
      return true;
    } catch (error) {
      if (cancelRequested || error?.details?.cancelled) {
        notification.set('Загрузка отменена', 1);
        notification.hide(4000);
        return false;
      }
      const reloadCount = Math.max(0, Number(options.reloadCount) || 0);
      if (error?.details?.reloadRequired && reloadCount < 2) {
        try {
          const queued = await sendRuntimeMessage({
            t: 'nova-set-reload-download',
            pending: {
              videoId: info.videoId,
              title: info.title,
              duration: Number(info.duration) || 0,
              format,
              audioFormat: isMp3 ? audioFormat : null,
              height: isMp3 ? null : Number(height),
              createdAt: Date.now(),
              token: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
              playerState: primedState,
              reloadCount: reloadCount + 1,
            },
          }, 10_000);
          if (!queued?.ok) {
            throw new Error(queued?.error || 'не удалось сохранить загрузку перед обновлением');
          }
          const reloadMessage = error.details.reason === 'edge-validation'
            ? 'Крайние сегменты повреждены — заново скачиваю медиадорожку…'
            : 'Обновляю страницу и автоматически продолжаю загрузку видео…';
          notification.set(reloadMessage, 0);
          // Keep the outgoing page at zero so YouTube creates the replacement
          // MSE session from the opening segments. Restoring the user's old
          // position in finally made the first post-MP3 pass start mid-stream;
          // the second reload then worked only because recovery had moved it
          // back to zero in the meantime.
          reloadScheduled = true;
          if (primedMedia) {
            try { primedMedia.currentTime = 0; } catch (primeError) {}
            try { primedMedia.muted = true; } catch (primeError) {}
            try { primedMedia.pause(); } catch (primeError) {}
          }
          // Nova's own reload: the playlist queue must survive it, while a
          // manual user reload (no flag) cancels the queue on the next load.
          try { sessionStorage.setItem('nvs_queue_nav', '1'); } catch (navError) {}
          // Reload through the browser, not the page: YouTube's SPA router can
          // intercept location.reload() and keep the wedged media session
          // alive — a tab-level reload behaves like a manual F5. On Music the
          // reload must target the track's own URL: a plain reload lets
          // ytmusic reopen the queue on the NEXT track and strand the resume.
          let reloadRequest = { t: 'nova-reload-tab' };
          if (IS_MUSIC && info.videoId) {
            const target = new URL('/watch', location.origin);
            target.searchParams.set('v', info.videoId);
            // Keep the playlist context: /watch?v= without list makes ytmusic
            // start a RADIO for the track and wander off to other songs.
            const listId = playlistIdFromLocation();
            if (listId) target.searchParams.set('list', listId);
            reloadRequest = { t: 'nova-navigate-tab', url: target.href };
          }
          setTimeout(() => {
            sendRuntimeMessage(reloadRequest, 5_000)
              .then((response) => { if (!response?.ok) location.reload(); })
              .catch(() => location.reload());
          }, 100);
          return 'reload';
        } catch (reloadError) {
          error = reloadError;
        }
      }
      await clearReloadGuard();
      const detail = String(error?.stack || error?.message || error);
      // The file itself survived — this is a "finish the save" notice, not a
      // failed download, and it needs long enough on screen to be read.
      notification.set(error?.recovered
        ? detail
        : `Ошибка: ${detail.split('\n').slice(0, 3).join(' ').slice(0, 280)}`, 1);
      notification.hide(error?.recovered ? 25_000 : 9000);
      if (!error?.logged) await reportError('ui/download', error, {
        format, height, videoId: info.videoId,
        ...(error?.details ? { capture: error.details } : {}),
      });
      return false;
    } finally {
      notification.setCancel(null);
      if (!reloadScheduled) restorePrimedMedia();
      chrome.runtime.onMessage.removeListener(onFfmpegProgress);
      downloadInProgress = false;
    }
  }

  function encodeBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
    }
    return btoa(binary);
  }

  async function warmupMediaProcessor() {
    const ensured = await sendWorkerMessage({ t: 'nova-ensure' }, 30_000);
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const warmed = await sendRuntimeMessage({ t: 'nova-warmup' }, 120_000);
    if (!warmed?.ok) throw new Error(warmed?.error || 'не удалось загрузить медиадвижок');
  }

  async function muxViaOffscreen(job, onStage) {
    const jobId = job.jobId;
    let begun = false;
    try {
      const ensured = await sendWorkerMessage({ t: 'nova-ensure' }, 30_000);
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');

      const registration = await sendRuntimeMessage({ t: 'nova-register-job', jobId }, 10_000);
      if (!registration?.ok || !Number.isInteger(registration.tabId)) {
        throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
      }

      const started = await sendRuntimeMessage({
        t: 'nova-begin', jobId, tabId: registration.tabId,
        filename: job.filename, format: job.format,
        audioFormat: job.audioFormat, audioQuality: job.audioQuality,
        videoId: job.videoId || '',
        videoMime: job.videoMime, audioMime: job.audioMime,
        videoPrefixMime: job.videoPrefixMime,
        videoPrefixBoundary: job.videoPrefixBoundary,
        transcode: job.transcode, scaleHeight: job.scaleHeight, duration: job.duration,
        audioCaptureRate: job.audioCaptureRate,
      }, 30_000);
      if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку');
      begun = true;

      const totalBytes = (job.video?.byteLength || 0)
        + (job.videoPrefix?.byteLength || 0)
        + (job.audio?.byteLength || 0);
      let transferredBytes = 0;
      onStage?.('transfer', 0, 'active', 'Передача и сборка');
      const sendTrack = async (track, buffer) => {
        if (!buffer) return;
        const bytes = new Uint8Array(buffer);
        for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
          const response = await sendRuntimeMessage({
            t: 'nova-chunk', jobId, track, b64: encodeBase64(chunk),
          }, 60_000);
          if (!response?.ok) throw new Error(response?.error || `передача данных прервалась (${track})`);
          transferredBytes += chunk.length;
          onStage?.('transfer', totalBytes ? transferredBytes / totalBytes : 1, 'active', 'Передача и сборка');
        }
      };

      // Track order is preserved inside each sender while audio/video transfers
      // overlap. Offscreen keeps separate part arrays, so interleaving is safe.
      await Promise.all([
        sendTrack('video', job.video),
        sendTrack('video-prefix', job.videoPrefix),
        sendTrack('audio', job.audio),
      ]);
      onStage?.('transfer', 1, 'done', 'Передача и сборка');
      onStage?.('process', 0, 'active');
      return await sendRuntimeMessage({ t: 'nova-finalize', jobId }, 2 * 60 * 60_000);
    } catch (error) {
      if (begun) await sendRuntimeMessage({ t: 'nova-abort', jobId }, 10_000).catch(() => {});
      throw error;
    }
  }

  function videoIdFromLocation() {
    try {
      const url = new URL(location.href);
      const queryId = url.searchParams.get('v');
      if (queryId) return queryId;
      return url.pathname.match(/\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{6,})/)?.[1] || '';
    } catch (error) {
      return '';
    }
  }

  async function clearReloadDownload() {
    return sendRuntimeMessage({ t: 'nova-clear-reload-download' }, 10_000).catch(() => null);
  }

  async function clearReloadGuard() {
    return sendRuntimeMessage({ t: 'nova-clear-reload-guard' }, 10_000).catch(() => null);
  }

  async function resumeReloadedVideoDownload() {
    let pending;
    // Probe first, and let it fail in silence. It runs on every page load,
    // when the service worker is usually cold, and virtually never finds
    // anything to resume — a red toast plus an auto-downloaded debug report
    // for a routine slow start is far worse than a missed resume.
    let response;
    try {
      response = await sendWorkerMessage({ t: 'nova-get-reload-download' }, 20_000);
    } catch (error) {
      void sendRuntimeMessage({
        t: 'nova-log', tag: 'resume',
        text: `pending-download probe skipped: ${String(error?.message || error)}`,
      }).catch(() => {});
      return;
    }
    if (!response?.ok || !response.pending) return;

    try {
      pending = response.pending;

      const age = Date.now() - Number(pending.createdAt);
      const locationVideoId = videoIdFromLocation();
      if (IS_MUSIC && pending.reloadAttempted === true && pending.videoId
        && locationVideoId && locationVideoId !== pending.videoId) {
        // ytmusic sometimes reopens the queue on the NEXT track after a
        // reload; the pending download then silently died here. Go back to
        // the track it belongs to (once) and resume there.
        let alreadyRedirected = false;
        try { alreadyRedirected = sessionStorage.getItem('nvs_resume_redirect') === pending.videoId; } catch (error) {}
        if (!alreadyRedirected) {
          try { sessionStorage.setItem('nvs_resume_redirect', pending.videoId); } catch (error) {}
          try { sessionStorage.setItem('nvs_queue_nav', '1'); } catch (error) {}
          const target = new URL('/watch', location.origin);
          target.searchParams.set('v', pending.videoId);
          // Without the list param ytmusic opens a radio and drifts further.
          const listId = playlistIdFromLocation();
          if (listId) target.searchParams.set('list', listId);
          const navigated = await sendRuntimeMessage({
            t: 'nova-navigate-tab', url: target.href,
          }, 5_000).catch(() => null);
          if (navigated?.ok) return; // pending stays stored; retried after load
        }
      }
      try { sessionStorage.removeItem('nvs_resume_redirect'); } catch (error) {}
      const valid = pending.reloadAttempted === true
        && (pending.format === 'mp4' || pending.format === 'mp3')
        && typeof pending.token === 'string'
        && (pending.format === 'mp3' || Number.isFinite(Number(pending.height)))
        && typeof pending.playerState?.paused === 'boolean'
        && Number.isFinite(Number(pending.playerState?.time))
        && typeof pending.playerState?.muted === 'boolean'
        && Number.isInteger(Number(pending.reloadCount))
        && Number(pending.reloadCount) >= 1
        && Number(pending.reloadCount) <= 2
        && age >= 0 && age <= 120_000
        && (!locationVideoId || locationVideoId === pending.videoId);
      if (!valid) {
        await clearReloadGuard();
        return;
      }

      downloadInProgress = true;
      const notification = getToast();
      notification.set(pending.format === 'mp3'
        ? 'Страница обновлена — продолжаю загрузку MP3…'
        : 'Страница обновлена — продолжаю загрузку видео…', 0);

      const holdReloadedMediaAtStart = () => {
        const media = activeMediaElement();
        if (!media) return;
        try { media.muted = true; } catch (error) {}
        // On Music a player paused at zero never builds its MSE buffers, so
        // the resumed capture starved and reloaded again. Muted playback from
        // zero warms it up; the capture pins the pause itself once it starts.
        if (!IS_MUSIC) try { media.pause(); } catch (error) {}
        try {
          if (Number(media.currentTime) > 0.05) media.currentTime = 0;
        } catch (error) {}
      };
      // Prime immediately, before waiting for metadata. Otherwise YouTube can
      // spend that wait building a fresh SourceBuffer beginning at the saved
      // playback position, forcing a complete second download at 99%.
      holdReloadedMediaAtStart();
      // Nova's own reload can land in a tab the user is not looking at, and
      // YouTube does not build its player in a hidden tab. The readiness poll
      // would then spend its whole budget on a page that was never going to be
      // ready, and the resume — a one-shot — is lost for good. Wait to be shown
      // before starting the clock; the toast already explains what is going on.
      if (document.visibilityState === 'hidden') {
        await new Promise((resolve) => {
          let settle = () => {
            settle = () => {};
            document.removeEventListener('visibilitychange', onVisible);
            resolve();
          };
          const onVisible = () => { if (document.visibilityState === 'visible') settle(); };
          document.addEventListener('visibilitychange', onVisible);
          setTimeout(() => settle(), 10 * 60_000);
        });
        holdReloadedMediaAtStart();
      }
      let info = null;
      // A cold player on a heavy page routinely needs more than twenty seconds.
      const readyDeadline = Date.now() + 45_000;
      while (Date.now() < readyDeadline) {
        holdReloadedMediaAtStart();
        const candidate = await callHook('info').catch(() => null);
        holdReloadedMediaAtStart();
        if (candidate?.videoId && candidate.videoId !== pending.videoId) {
          throw new Error('после обновления открыто другое видео');
        }
        if (candidate?.videoId === pending.videoId && Number(candidate.duration) > 0) {
          info = {
            ...candidate,
            title: candidate.title || pending.title,
            duration: Number(candidate.duration) || Number(pending.duration) || 0,
          };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!info) throw new Error('плеер не подготовился после обновления страницы');

      // Consume before starting: even if the fresh attempt fails, this request
      // must never create an automatic reload loop.
      const cleared = await clearReloadDownload();
      if (!cleared?.ok) throw new Error('не удалось подтвердить одноразовое возобновление');
      downloadInProgress = false;
      const outcome = await startDownload(
        {
          format: pending.format,
          height: pending.format === 'mp3' ? null : Number(pending.height),
          audioFormat: pending.format === 'mp3' ? (pending.audioFormat || 'mp3') : 'mp3',
        },
        info,
        {
          freshPageResume: true,
          restoreMediaState: pending.playerState,
          reloadCount: Number(pending.reloadCount),
        },
      );
      return { videoId: pending.videoId, ok: outcome === true, reloading: outcome === 'reload' };
    } catch (error) {
      await clearReloadGuard();
      downloadInProgress = false;
      const notification = getToast();
      notification.set(`Ошибка возобновления: ${error.message || error}`, 1);
      notification.hide(9000);
      await reportError('ui/reload-resume', error, {
        videoId: pending?.videoId,
        height: pending?.height,
      });
      return pending?.videoId ? { videoId: pending.videoId, ok: false } : null;
    }
  }

  // ---- live stream recording ----------------------------------------------
  // The hook forwards every MSE fragment through window.postMessage; this side
  // relays them (per-track, in order, with backpressure) to the offscreen
  // document, which spools them to OPFS and muxes the file at stop.
  let liveJob = null;

  function removeLivePanel() {
    document.getElementById('nova-live-panel')?.remove();
  }

  function renderLivePanel(state) {
    let box = document.getElementById('nova-live-panel');
    if (!box) {
      box = createElement('div');
      box.id = 'nova-live-panel';
      const head = createElement('div', 'nova-live-head');
      head.append(createElement('span', 'nova-live-dot'), createElement('span', 'nova-live-txt'));
      const stopButton = createElement('button', 'nova-btn nova-live-stop', 'Остановить и сохранить');
      stopButton.addEventListener('click', () => {
        stopButton.disabled = true;
        stopButton.textContent = 'Останавливаю…';
        void callHook('live-stop').catch(() => {});
      });
      box.append(head, stopButton);
      document.body.append(box);
    }
    const label = box.querySelector('.nova-live-txt');
    const megabytes = (Number(state.bytes || 0) / (1024 * 1024)).toFixed(1);
    const total = Math.max(0, Math.floor(Number(state.seconds) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, '0');
    label.textContent = state.caughtUp
      ? `Запись эфира: ${minutes}:${seconds} · ${megabytes} МБ`
      : `Догоняю эфир (отставание ${Math.round(Number(state.behind) || 0)} с) · ${megabytes} МБ`;
  }

  async function startLiveRecording(info, from) {
    const notification = getToast();
    if (downloadInProgress) {
      notification.set('Другая загрузка уже выполняется', 1);
      notification.hide(4000);
      return false;
    }
    downloadInProgress = true;
    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const chains = { video: Promise.resolve(), audio: Promise.resolve() };
    liveJob = { jobId, failed: '', queuedBytes: 0, sentBytes: 0 };
    const failLiveTransfer = (reason) => {
      if (liveJob && !liveJob.failed) {
        liveJob.failed = reason;
        void callHook('live-stop').catch(() => {});
      }
    };
    const onLiveChunk = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.__nova_live_chunk !== true || !data.buffer) return;
      if (!liveJob || liveJob.jobId !== jobId || liveJob.failed) return;
      const bytes = new Uint8Array(data.buffer);
      liveJob.queuedBytes += bytes.length;
      if (liveJob.queuedBytes - liveJob.sentBytes > 192 * 1024 * 1024) {
        failLiveTransfer('передача сегментов не успевает за эфиром');
        return;
      }
      const track = data.kind === 'audio' ? 'audio' : 'video';
      chains[track] = chains[track].then(async () => {
        if (!liveJob || liveJob.failed) return;
        for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_SIZE) {
          const part = bytes.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, bytes.length));
          const response = await sendRuntimeMessage({
            t: 'nova-live-chunk', jobId, track, mime: data.mime || '', b64: encodeBase64(part),
          }, 60_000);
          if (!response?.ok) throw new Error(response?.error || 'сегмент не принят обработчиком');
        }
        liveJob.sentBytes += bytes.length;
      }).catch((error) => failLiveTransfer(String(error?.message || error)));
    };
    window.addEventListener('message', onLiveChunk);
    const onFfmpegProgress = (message) => {
      if (message?.t !== 'nova-progress' || message.jobId !== jobId) return;
      notification.set(message.status || 'Сборка записи эфира…', Math.max(0, Math.min(1, message.value || 0)));
    };
    chrome.runtime.onMessage.addListener(onFfmpegProgress);
    try {
      notification.set('Подготовка записи эфира…', 0.05);
      const ensured = await sendWorkerMessage({ t: 'nova-ensure' }, 30_000);
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
      const registration = await sendRuntimeMessage({ t: 'nova-register-job', jobId }, 10_000);
      if (!registration?.ok || !Number.isInteger(registration.tabId)) {
        throw new Error(registration?.error || 'не удалось определить вкладку записи');
      }
      const begun = await sendRuntimeMessage({
        t: 'nova-live-begin', jobId, tabId: registration.tabId,
      }, 30_000);
      if (!begun?.ok) throw new Error(begun?.error || 'не удалось начать запись эфира');
      notification.hide(800);
      renderLivePanel({
        seconds: 0, bytes: 0, behind: 0, caughtUp: from !== 'start',
      });
      const result = await callHook('live-start', { from }, (message) => {
        if (message.live) renderLivePanel(message.live);
      });
      removeLivePanel();
      if (liveJob.failed) throw new Error(liveJob.failed);
      notification.set('Эфир записан, передаю остаток данных…', 0.15);
      await Promise.allSettled([chains.video, chains.audio]);
      if (liveJob.failed) throw new Error(liveJob.failed);
      notification.set('Собираю файл записи…', 0.25);
      const filename = `${safeFilename(info.title)} [LIVE].mp4`;
      const finalized = await sendRuntimeMessage({
        t: 'nova-live-finalize',
        jobId,
        filename,
        duration: Number(result.durationSeconds) || 0,
        videoMime: result.videoMime || '',
        audioMime: result.audioMime || '',
      }, 60 * 60_000);
      if (!finalized?.ok) {
        const failure = new Error(finalized?.error || 'не удалось собрать запись эфира');
        failure.recovered = Boolean(finalized?.recovered);
        failure.logged = Boolean(finalized?.logged);
        throw failure;
      }
      notification.set(finalized.split
        ? 'Готово: запись сохранена двумя файлами (видео + звук): она слишком велика для склейки в браузере'
        : (finalized.singleTrack
          ? `Внимание: плеер передал только ${finalized.singleTrack === 'audio' ? 'аудио' : 'видео'}дорожку — сохранена она (${finalized.filename})`
          : `Готово: ${finalized.filename || filename} (${result.reason || 'эфир записан'})`), 1);
      notification.hide(9000);
      return true;
    } catch (error) {
      removeLivePanel();
      await sendRuntimeMessage({ t: 'nova-live-abort', jobId }, 10_000).catch(() => {});
      const detail = String(error?.message || error);
      notification.set(error?.recovered ? detail : `Ошибка записи эфира: ${detail.slice(0, 240)}`, 1);
      notification.hide(error?.recovered ? 25_000 : 9000);
      if (!error?.logged) await reportError('ui/live', error, { videoId: info.videoId, from });
      return false;
    } finally {
      window.removeEventListener('message', onLiveChunk);
      chrome.runtime.onMessage.removeListener(onFfmpegProgress);
      liveJob = null;
      downloadInProgress = false;
    }
  }

  // ---- playlist queue ------------------------------------------------------
  // The queue survives navigation in chrome.storage.local; each watch page
  // load picks up the first pending item, downloads it with the regular
  // single-video pipeline and then navigates to the next video itself.
  const QUEUE_KEY = 'nvs_playlist_queue';
  let queueRunning = false;
  // Consumed once per page load: set by Nova right before its own reloads and
  // navigations. A page load without it means the user reloaded manually.
  let pageLoadWasNovaNavigation = false;
  try {
    pageLoadWasNovaNavigation = sessionStorage.getItem('nvs_queue_nav') === '1';
    sessionStorage.removeItem('nvs_queue_nav');
  } catch (error) {}

  function playlistIdFromLocation() {
    try { return new URL(location.href).searchParams.get('list') || ''; } catch (error) { return ''; }
  }

  function scrapePlaylistItems() {
    if (IS_MUSIC) return scrapeMusicQueueItems();
    const items = [];
    const seen = new Set();
    for (const row of document.querySelectorAll('ytd-playlist-panel-video-renderer')) {
      const link = row.querySelector('a#wc-endpoint') || row.querySelector('a[href*="watch"]');
      let videoId = '';
      try { videoId = new URL(link?.href || '', location.origin).searchParams.get('v') || ''; } catch (error) {}
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const titleNode = row.querySelector('#video-title');
      const title = (titleNode?.getAttribute('title') || titleNode?.textContent || videoId).trim();
      items.push({ videoId, title });
    }
    return items;
  }

  // YT Music queue rows expose no watch link; the video id lives in the
  // thumbnail URL (i.ytimg.com/vi/<id>/...).
  function scrapeMusicQueueItems() {
    const items = [];
    const seen = new Set();
    for (const row of document.querySelectorAll('ytmusic-player-queue-item')) {
      const thumb = row.querySelector('img');
      const videoId = ((thumb?.src || '').match(/\/vi\/([A-Za-z0-9_-]{6,})\//) || [])[1] || '';
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const titleNode = row.querySelector('.song-title');
      const artistNode = row.querySelector('.byline');
      const title = [
        (artistNode?.getAttribute('title') || artistNode?.textContent || '').trim(),
        (titleNode?.getAttribute('title') || titleNode?.textContent || videoId).trim(),
      ].filter(Boolean).join(' - ');
      items.push({ videoId, title });
    }
    return items;
  }

  async function readQueue() {
    const stored = await chrome.storage.local.get(QUEUE_KEY).catch(() => ({}));
    return stored[QUEUE_KEY] || null;
  }
  async function writeQueue(queue) {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue }).catch(() => {});
  }
  async function clearQueue() {
    await chrome.storage.local.remove(QUEUE_KEY).catch(() => {});
  }

  function closePlaylistPicker() {
    document.getElementById('nova-playlist-overlay')?.remove();
  }

  function openPlaylistPicker(info, items) {
    closePlaylistPicker();
    const overlay = createElement('div');
    overlay.id = 'nova-playlist-overlay';
    const panel = createElement('div', 'nova-playlist');
    panel.append(createElement('div', 'nova-playlist-head', `Скачивание плейлиста — ${items.length} видео`));
    panel.append(createElement('div', 'nova-playlist-note',
      'В списке видео, уже загруженные плеером. Если плейлист длиннее — прокрутите его на странице и откройте это окно снова.'));

    const formatRow = createElement('div', 'nova-playlist-format');
    formatRow.append(createElement('span', null, 'Формат:'));
    const select = document.createElement('select');
    // On Music the queue mixes songs and clips; a fixed video height would
    // fail on the audio-only entries, so the queue is audio-only there.
    if (!IS_MUSIC) {
      const videoGroup = document.createElement('optgroup');
      videoGroup.label = '─── Видео ───';
      const heights = [...new Set(info.heights || [])].sort((a, b) => b - a);
      for (const h of heights) videoGroup.append(new Option(`🎬 ${h}p (MP4)`, `mp4:${h}`));
      if (videoGroup.children.length) select.append(videoGroup);
    }
    const audioGroup = document.createElement('optgroup');
    audioGroup.label = '─── Аудио ───';
    for (const audio of audioFormatsFor(info)) audioGroup.append(new Option(`🎵 ${audio.title}`, `mp3:${audio.id}`));
    select.append(audioGroup);
    formatRow.append(select);
    panel.append(formatRow);

    const allRow = createElement('label', 'nova-playlist-row nova-playlist-all');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.checked = true;
    allRow.append(selectAll, createElement('span', 'nova-playlist-title', 'Выбрать все'));
    panel.append(allRow);

    const list = createElement('div', 'nova-playlist-list');
    const checks = items.map((item, index) => {
      const row = createElement('label', 'nova-playlist-row');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.addEventListener('change', () => {
        selectAll.checked = checks.every((box) => box.checked);
      });
      row.append(check,
        createElement('span', 'nova-playlist-idx', String(index + 1)),
        createElement('span', 'nova-playlist-title', item.title));
      list.append(row);
      return check;
    });
    panel.append(list);
    selectAll.addEventListener('change', () => checks.forEach((box) => { box.checked = selectAll.checked; }));

    const actions = createElement('div', 'nova-playlist-actions');
    const startButton = createElement('button', 'nova-btn primary', 'Скачать выбранные');
    const closeButton = createElement('button', 'nova-btn', 'Закрыть');
    actions.append(startButton, closeButton);
    panel.append(actions);
    overlay.append(panel);
    document.body.append(overlay);
    closeButton.addEventListener('click', closePlaylistPicker);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closePlaylistPicker();
    });
    startButton.addEventListener('click', async () => {
      const chosen = items.filter((_, index) => checks[index].checked);
      if (!chosen.length) return;
      const [format, sub] = String(select.value).split(':');
      // The token lives in this tab's sessionStorage: another tab (or a tab
      // opened after this one closes) can never adopt and resume this queue.
      const token = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      try { sessionStorage.setItem('nvs_queue_token', token); } catch (error) {}
      await writeQueue({
        listId: playlistIdFromLocation(),
        createdAt: Date.now(),
        active: true,
        token,
        format: {
          format: format === 'mp3' ? 'mp3' : 'mp4',
          height: format === 'mp4' ? Number(sub) : null,
          audioFormat: format === 'mp3' ? sub : null,
        },
        items: chosen.map((item) => ({
          videoId: item.videoId,
          title: item.title.slice(0, 200),
          status: 'pending',
        })),
      });
      closePlaylistPicker();
      void processPlaylistQueue(null);
    });
  }

  function renderQueuePanel(queue, state = {}) {
    let box = document.getElementById('nova-queue');
    if (!box) {
      box = createElement('div');
      box.id = 'nova-queue';
      const body = createElement('div', 'nova-queue-body');
      const cancelButton = createElement('button', 'nova-btn nova-queue-cancel', 'Отменить очередь');
      cancelButton.addEventListener('click', async () => {
        await clearQueue();
        try { sessionStorage.removeItem('nvs_queue_token'); } catch (error) {}
        if (IS_MUSIC) void callHook('music-mute', { mute: false }).catch(() => {});
        // Do not touch the toast here: a download may be mid-item and owns the
        // staged progress UI (with its own cancel button). Removing the panel
        // is the visible confirmation that the queue is gone.
        box.remove();
      });
      const actions = createElement('div', 'nova-queue-actions');
      actions.append(cancelButton);
      body.append(createElement('div', 'nova-queue-list'), actions);
      box.append(createElement('div', 'nova-queue-pill'), body);
      document.body.append(box);
    }
    const done = queue.items.filter((item) => item.status === 'done').length;
    const failed = queue.items.filter((item) => item.status === 'error').length;
    const activeItem = queue.items.find((item) => item.status === 'active');
    const pill = box.querySelector('.nova-queue-pill');
    pill.textContent = state.finished
      ? `Плейлист: готово ${done}/${queue.items.length}${failed ? `, ошибок: ${failed}` : ''}`
      : `Плейлист: ${done}/${queue.items.length}${activeItem ? ` · ${activeItem.title}` : ''}`;
    box.querySelector('.nova-queue-cancel').textContent = state.finished ? 'Закрыть' : 'Отменить очередь';
    box.classList.toggle('finished', Boolean(state.finished));
    const list = box.querySelector('.nova-queue-list');
    list.replaceChildren(...queue.items.map((item, index) => {
      const row = createElement('div', `nova-queue-row ${item.status}`);
      const icon = item.status === 'done' ? '✓'
        : (item.status === 'error' ? '✗' : (item.status === 'active' ? '▶' : '•'));
      row.append(createElement('span', 'nova-queue-ic', icon),
        createElement('span', 'nova-queue-idx', `${index + 1}.`),
        createElement('span', 'nova-queue-title', item.title));
      return row;
    }));
  }

  async function waitForPlayerReady(videoId, deadlineMs = 30_000, onTick) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      onTick?.();
      const candidate = await callHook('info').catch(() => null);
      onTick?.();
      if (candidate?.videoId === videoId && Number(candidate.duration) > 0) return candidate;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return null;
  }

  // Mirror of the reload-resume priming: pin the fresh player to a muted pause
  // at zero so YouTube builds its MSE session from the opening segments. Queue
  // items that skipped this occasionally landed in a wedged SABR session.
  function holdQueueMediaAtStart() {
    const media = activeMediaElement();
    if (!media) return;
    try { media.muted = true; } catch (error) {}
    // Music player: muted playback instead of a pause — paused at zero it
    // never loads metadata/buffers and the queue item waits out its 30s.
    if (!IS_MUSIC) try { media.pause(); } catch (error) {}
    try {
      if (Number(media.currentTime) > 0.05) media.currentTime = 0;
    } catch (error) {}
  }

  async function processPlaylistQueue(resumedResult, entry = 'inline') {
    if (location.pathname !== '/watch' || queueRunning || downloadInProgress) return;
    if (resumedResult?.reloading) return;
    // Claim the runner slot before any await: the startup path and the
    // yt-navigate-finish handler can otherwise both pass the guard above and
    // download the same item twice.
    queueRunning = true;
    try {
      let queue = await readQueue();
      if (!queue?.active || !Array.isArray(queue.items) || !queue.items.length) return;
      let sessionToken = null;
      try { sessionToken = sessionStorage.getItem('nvs_queue_token'); } catch (error) {}
      if (!queue.token || queue.token !== sessionToken) {
        // Queue owned by another tab: never adopt it here — and never destroy
        // it either, its owner tab may be running it right now. Only remove
        // tokenless (pre-token) queues and abandoned ones nobody can resume.
        if (!queue.token || Date.now() - Number(queue.createdAt || 0) > 12 * 60 * 60_000) {
          await clearQueue();
        }
        return;
      }
      if (entry === 'load') {
        if (!pageLoadWasNovaNavigation) {
          // A page load without Nova's navigation flag is the user pressing
          // reload by hand — that is the stop signal for the queue.
          await clearQueue();
          try { sessionStorage.removeItem('nvs_queue_token'); } catch (error) {}
          const notification = getToast();
          notification.set('Очередь плейлиста остановлена после обновления страницы', 1);
          notification.hide(6000);
          return;
        }
      }
      const active = queue.items.find((item) => item.status === 'active');
      if (active) {
        // A reload-resume that just finished settles the interrupted item;
        // anything else (browser restart, stray navigation) retries it.
        if (resumedResult && resumedResult.videoId === active.videoId) {
          active.status = resumedResult.ok ? 'done' : 'error';
        } else {
          active.status = 'pending';
        }
        await writeQueue(queue);
      }
      renderQueuePanel(queue);
      while (true) {
        queue = await readQueue();
        if (!queue?.active) break;
        const next = queue.items.find((item) => item.status === 'pending');
        if (!next) {
          renderQueuePanel(queue, { finished: true });
          const done = queue.items.filter((item) => item.status === 'done').length;
          const failed = queue.items.filter((item) => item.status === 'error').length;
          const notification = getToast();
          notification.set(`Плейлист: скачано ${done} из ${queue.items.length}${failed ? `, с ошибками: ${failed}` : ''}`, 1);
          notification.hide(8000);
          await clearQueue();
          if (IS_MUSIC) {
            // The queue kept the tab silent; give the sound back at the end.
            void callHook('music-mute', { mute: false }).catch(() => {});
            try { activeMediaElement().muted = false; } catch (error) {}
          }
          break;
        }
        if (videoIdFromLocation() !== next.videoId) {
          renderQueuePanel(queue);
          // Music included: every queue item gets a REAL page load. Tracks
          // opened through ytmusic's SPA switching inherit a wedged media
          // session and stall, while a fresh load downloads first try (the
          // beforeunload prompt is stripped by the hook, so loads are silent).
          const target = new URL('/watch', location.origin);
          target.searchParams.set('v', next.videoId);
          if (queue.listId) target.searchParams.set('list', queue.listId);
          try { sessionStorage.setItem('nvs_queue_nav', '1'); } catch (error) {}
          // Navigate through the browser so every queue item starts as a real
          // page load; page-initiated navigation gets intercepted into an SPA
          // transition where YouTube preloads media before the URL changes and
          // the captured head is lost.
          const navigated = await sendRuntimeMessage({
            t: 'nova-navigate-tab', url: target.href,
          }, 5_000).catch(() => null);
          if (!navigated?.ok) location.assign(target.href);
          return;
        }
        next.status = 'active';
        await writeQueue(queue);
        renderQueuePanel(queue);
        holdQueueMediaAtStart();
        // Never write a stale queue copy after a long await: the user may have
        // cancelled meanwhile, and writing would resurrect the cleared queue.
        const settleItem = async (videoId, status) => {
          const current = await readQueue();
          if (!current?.active || current.token !== queue.token) return false;
          const item = current.items.find((entry) => entry.videoId === videoId
            && (entry.status === 'active' || entry.status === 'pending'));
          if (item) item.status = status;
          await writeQueue(current);
          renderQueuePanel(current);
          return true;
        };
        const ready = await waitForPlayerReady(next.videoId, 30_000, holdQueueMediaAtStart);
        if (!ready) {
          if (!(await settleItem(next.videoId, 'error'))) break;
          continue;
        }
        const outcome = await startDownload({
          format: queue.format?.format === 'mp3' ? 'mp3' : 'mp4',
          height: Number(queue.format?.height) || null,
          audioFormat: queue.format?.audioFormat || 'mp3',
        }, ready, {
          // Music: keep the tab silent for the whole queue run; the last
          // item unmutes when the queue finishes.
          restoreMediaState: { paused: true, time: 0, muted: IS_MUSIC },
        });
        if (outcome === 'reload') return; // resume continues after the reload
        if (outcome === 'busy') {
          // The user started a manual download while the queue was between
          // items: put the item back, wait the manual download out, retry.
          if (!(await settleItem(next.videoId, 'pending'))) break;
          while (downloadInProgress) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          continue;
        }
        if (!(await settleItem(next.videoId, outcome === true ? 'done' : 'error'))) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    } finally {
      queueRunning = false;
      // The queue app-mutes the Music tab; if this tab's queue is over for
      // ANY reason (finished, cancelled, errored out), the sound must come
      // back. ytmusic persists its mute state across reloads, so a missed
      // unmute used to leave the tab silent until toggled by hand. Gated on
      // the tab's own token: without it this must never touch a mute the
      // user set manually.
      if (IS_MUSIC) {
        let hadToken = false;
        try { hadToken = Boolean(sessionStorage.getItem('nvs_queue_token')); } catch (error) {}
        if (hadToken) {
          const remaining = await readQueue().catch(() => null);
          if (!remaining?.active) {
            try { sessionStorage.removeItem('nvs_queue_token'); } catch (error) {}
            void callHook('music-mute', { mute: false }).catch(() => {});
          }
        }
      }
    }
  }

  new MutationObserver(scheduleButton).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', scheduleButton);
  scheduleButton();
  // With an active queue the freshly navigated track starts playing out loud
  // for the seconds before the download begins; silence it as early as
  // possible (the capture itself mutes only for its own duration).
  function muteEarlyIfQueueActive() {
    try {
      if (!sessionStorage.getItem('nvs_queue_token')) return;
      holdQueueMediaAtStart();
      // ytmusic re-applies its stored volume over element.muted; mute the
      // player app itself for the whole queue run (unmuted at completion).
      if (IS_MUSIC) void callHook('music-mute', { mute: true }).catch(() => {});
    } catch (error) {}
  }
  document.addEventListener('yt-navigate-finish', () => {
    muteEarlyIfQueueActive();
    setTimeout(() => { void processPlaylistQueue(null); }, 1_500);
  });
  muteEarlyIfQueueActive();
  (async () => {
    const resumed = await resumeReloadedVideoDownload();
    await processPlaylistQueue(resumed || null, 'load');
  })();
})();
