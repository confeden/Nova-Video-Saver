// Isolated-world UI and the only bridge between the page hook and extension APIs.
(() => {
  const BUTTON_ID = 'nova-download-btn';
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
      const timeoutMs = cmd === 'download' ? 70_000 : (cmd === 'subtitles' ? 120_000 : 15_000);
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
    console.error('[Nova Youtube Downloader]', error);
    return chrome.runtime.sendMessage({ t: 'nova-error', context, error: text, details }).catch(() => null);
  }

  function sendRuntimeMessage(message, timeoutMs) {
    if (!timeoutMs) return chrome.runtime.sendMessage(message);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`extension message timed out (${message.t})`)), timeoutMs);
    });
    return Promise.race([chrome.runtime.sendMessage(message), timeout]).finally(() => clearTimeout(timer));
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function createDownloadIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 44 32');
    svg.setAttribute('aria-hidden', 'true');
    const outline = document.createElementNS(namespace, 'rect');
    outline.setAttribute('x', '1');
    outline.setAttribute('y', '1');
    outline.setAttribute('width', '42');
    outline.setAttribute('height', '30');
    outline.setAttribute('rx', '15');
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', '#35d477');
    outline.setAttribute('stroke-width', '1.5');
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    const arrows = document.createElementNS(namespace, 'path');
    arrows.setAttribute('fill', '#35d477');
    arrows.setAttribute('d', 'M12.2 5.4h19.6L22 13.7z M12.2 18.3h19.6L22 26.6z');
    svg.append(outline, arrows);
    return svg;
  }

  function createButton() {
    const button = createElement('button', 'ytp-button nova-download-btn');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'NYD (Nova Youtube Downloader)';
    button.setAttribute('aria-label', button.title);
    button.append(createDownloadIcon());
    button.addEventListener('click', openMenu);
    return button;
  }

  function ensureButton() {
    if (location.pathname !== '/watch' || document.getElementById(BUTTON_ID)) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (controls) controls.prepend(createButton());
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

  function createBrandHeading() {
    const heading = createElement('div', 'nova-menu-head nova-brand-head');
    const label = createElement('span');
    const version = chrome.runtime.getManifest().version;
    const link = createElement('a', null, 't.me/nova_txt');
    link.href = 'https://t.me/nova_txt';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', () => closeMenu());
    label.append(`Nova Youtube Downloader v${version} | `, link);
    heading.append(label);
    return heading;
  }

  function setItemLabel(item, title, description) {
    item.append(createElement('b', null, title));
    if (description) item.append(' ', createElement('span', 'nova-ext', description));
  }

  function addDownloadItems(info) {
    menu.append(createHeading('Качество видео (MP4 / MP3)'));
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

    const mp3 = createElement('div', 'nova-menu-item');
    setItemLabel(mp3, 'MP3', 'звук (аудиодорожка)');
    mp3.addEventListener('click', () => {
      closeMenu();
      startDownload({ format: 'mp3', height: null }, info);
    });
    menu.append(mp3);
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
      ['.vtt', 'vtt', 'VTT (с тайм-кодами)'],
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

  function addFormatSelector(transcode) {
    menu.append(createHeading('Формат видео'));
    const formats = [
      { value: false, title: 'Современный кодек (VP9)', note: 'быстро, без перекодирования' },
      { value: true, title: 'Кодек H.264 (перекодирование)', note: 'медленно, но совместимо с устаревшими плеерами' },
    ];
    let selected = Boolean(transcode);
    const rows = formats.map((format) => {
      const row = createElement('div', `nova-menu-radio${selected === format.value ? ' sel' : ''}`);
      const text = createElement('span', 'nova-radio-txt');
      text.append(createElement('b', null, format.title), createElement('i', null, format.note));
      row.append(createElement('span', 'nova-dot'), text);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        selected = format.value;
        chrome.storage.local.set({ transcode: selected }).catch((error) => reportError('ui/settings', error));
        rows.forEach((item, index) => item.classList.toggle('sel', formats[index].value === selected));
      });
      return row;
    });
    menu.append(...rows);
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
      const [info, availability, settings] = await Promise.all([
        callHook('info'),
        callHook('subs-available'),
        chrome.storage.local.get('transcode'),
      ]);
      menu = createElement('div', 'nova-menu');
      menu.append(createBrandHeading());
      addDownloadItems(info);
      addSubtitleItems(info, availability);
      addFormatSelector(settings.transcode);
      document.body.append(menu);

      const buttonRect = document.getElementById(BUTTON_ID)?.getBoundingClientRect();
      if (buttonRect) {
        menu.style.right = `${Math.max(8, window.innerWidth - buttonRect.right)}px`;
        menu.style.bottom = `${window.innerHeight - buttonRect.top + 8}px`;
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
      box.append(createElement('span', 'nova-toast-txt'), bar, createElement('div', 'nova-toast-stages'));
      document.body.append(box);
    }
    const text = box.querySelector('.nova-toast-txt');
    const legacyBar = box.querySelector(':scope > .nova-toast-bar');
    const progress = legacyBar.querySelector('i');
    const stages = box.querySelector('.nova-toast-stages');
    return {
      set(message, fraction = 0) {
        clearTimeout(toastHideTimer);
        text.textContent = message;
        stages.replaceChildren();
        stages.classList.remove('show');
        legacyBar.hidden = false;
        progress.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
        box.classList.add('show');
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
      const saved = await chrome.runtime.sendMessage({ t: 'nova-save', url, filename });
      if (!saved?.ok) throw new Error(saved?.error || 'не удалось сохранить субтитры');
      notification.set(`Готово: ${filename}`, 1);
      notification.hide(4000);
    } catch (error) {
      notification.set(`Ошибка: ${error.message || error}`, 1);
      notification.hide(6000);
      await reportError('ui/subtitles', error, { format, videoId: info.videoId });
    }
  }

  async function startDownload({ format, height }, info, options = {}) {
    const notification = getToast();
    if (downloadInProgress) {
      notification.set('Другая загрузка уже выполняется', 1);
      notification.hide(4000);
      return;
    }
    downloadInProgress = true;
    if (!options.freshPageResume) await clearReloadGuard();

    const isMp3 = format === 'mp3';
    const primedMedia = document.querySelector('video');
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
    const label = isMp3 ? 'MP3' : `${height}p`;
    const processingLabel = isMp3 ? 'Кодирование MP3' : 'Склейка / кодирование';
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

    const onFfmpegProgress = (message) => {
      if (message?.t !== 'nova-progress' || message.jobId !== jobId) return;
      const value = Math.max(0, Math.min(1, message.value || 0));
      const fallback = isMp3
        ? 'Кодирование MP3'
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
      const { transcode = false } = await chrome.storage.local.get('transcode');
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
      notification.stage('capture', 1, 'done');

      const actualHeight = !isMp3 && Number(captured.actualHeight) > 0 ? Number(captured.actualHeight) : height;
      scaleDown = !isMp3 && actualHeight > height;
      const unavailableHigherQuality = !isMp3 && actualHeight < height;
      const outputHeight = isMp3 ? null : (scaleDown ? height : actualHeight);
      const shouldTranscode = isMp3 || Boolean(transcode) || scaleDown || Boolean(captured.forceTranscode);
      const processStatus = isMp3
        ? 'Кодирование MP3'
        : (scaleDown
          ? `Уменьшение ${actualHeight}p до ${height}p`
          : (unavailableHigherQuality
            ? `Склейка ${actualHeight}p без апскейлинга`
            : (shouldTranscode ? 'Перекодирование в H.264/AAC' : 'Склейка дорожек')));

      const extension = isMp3 ? '.mp3' : '.mp4';
      const filename = `${safeFilename(info.title)}${isMp3 ? '' : ` [${outputHeight}p]`}${extension}`;
      notification.stage('transfer', 0, 'active', 'Передача и сборка');
      const result = await muxViaOffscreen({
        jobId,
        format,
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
        throw error;
      }
      notification.stage('engine', 1, 'done');
      notification.stage('transfer', 1, 'done');
      notification.stage('process', 1, 'done', processStatus);
      await clearReloadGuard();
      notification.set(`Готово: ${result.filename || filename}`, 1);
      notification.hide(4000);
    } catch (error) {
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
          setTimeout(() => location.reload(), 100);
          return;
        } catch (reloadError) {
          error = reloadError;
        }
      }
      await clearReloadGuard();
      const detail = String(error?.stack || error?.message || error);
      notification.set(`Ошибка: ${detail.split('\n').slice(0, 3).join(' ').slice(0, 280)}`, 1);
      notification.hide(9000);
      if (!error?.logged) await reportError('ui/download', error, {
        format, height, videoId: info.videoId,
        ...(error?.details ? { capture: error.details } : {}),
      });
    } finally {
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
    const ensured = await sendRuntimeMessage({ t: 'nova-ensure' }, 30_000);
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');
    const warmed = await sendRuntimeMessage({ t: 'nova-warmup' }, 120_000);
    if (!warmed?.ok) throw new Error(warmed?.error || 'не удалось загрузить медиадвижок');
  }

  async function muxViaOffscreen(job, onStage) {
    const jobId = job.jobId;
    let begun = false;
    try {
      const ensured = await sendRuntimeMessage({ t: 'nova-ensure' }, 30_000);
      if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить обработчик медиа');

      const registration = await sendRuntimeMessage({ t: 'nova-register-job', jobId }, 10_000);
      if (!registration?.ok || !Number.isInteger(registration.tabId)) {
        throw new Error(registration?.error || 'не удалось определить вкладку загрузки');
      }

      const started = await sendRuntimeMessage({
        t: 'nova-begin', jobId, tabId: registration.tabId,
        filename: job.filename, format: job.format,
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
    try {
      const response = await sendRuntimeMessage({ t: 'nova-get-reload-download' }, 10_000);
      if (!response?.ok || !response.pending) return;
      pending = response.pending;

      const age = Date.now() - Number(pending.createdAt);
      const locationVideoId = videoIdFromLocation();
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
        const media = document.querySelector('video');
        if (!media) return;
        try { media.muted = true; } catch (error) {}
        try { media.pause(); } catch (error) {}
        try {
          if (Number(media.currentTime) > 0.05) media.currentTime = 0;
        } catch (error) {}
      };
      // Prime immediately, before waiting for metadata. Otherwise YouTube can
      // spend that wait building a fresh SourceBuffer beginning at the saved
      // playback position, forcing a complete second download at 99%.
      holdReloadedMediaAtStart();
      let info = null;
      const readyDeadline = Date.now() + 20_000;
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
      await startDownload(
        {
          format: pending.format,
          height: pending.format === 'mp3' ? null : Number(pending.height),
        },
        info,
        {
          freshPageResume: true,
          restoreMediaState: pending.playerState,
          reloadCount: Number(pending.reloadCount),
        },
      );
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
    }
  }

  new MutationObserver(scheduleButton).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', scheduleButton);
  scheduleButton();
  void resumeReloadedVideoDownload();
})();
