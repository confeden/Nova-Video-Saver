// Twitch stream recorder. Records the live player via captureStream +
// MediaRecorder (a live stream is realtime by nature, so 1x recording is the
// lossless-speed option here). The button sits leftmost inside the player's
// right control group so it never overlaps native or FrankerFaceZ buttons.
(() => {
  const BUTTON_ID = 'nvs-twitch-record';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let recorder = null;
  let recorderMime = 'video/webm';
  let parts = [];
  let recordedVideo = null;
  let recordingChannel = '';
  let startPath = '';
  let startedAt = 0;
  let watchdog = null;
  let stopReason = '';
  let injectFrame;

  function channelFromLocation() {
    const segments = location.pathname.split('/').filter(Boolean);
    return segments[0] === 'videos' ? (segments[1] ? `vod-${segments[1]}` : 'vod') : (segments[0] || 'stream');
  }

  function findControlsGroup() {
    return document.querySelector('.player-controls__right-control-group')
      || document.querySelector('[data-a-target="player-controls"] > div:last-child');
  }

  function findPlayerVideo() {
    const videos = [...document.querySelectorAll('video')];
    return videos.find((media) => media.readyState >= 2 && !media.ended) || videos[0] || null;
  }

  function toast(message, sticky = false) {
    let box = document.getElementById('nvs-twitch-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nvs-twitch-toast';
      document.body.append(box);
    }
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toast.timer);
    if (!sticky) toast.timer = setTimeout(() => box.classList.remove('show'), 5000);
  }

  function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  // Brand icon: green ring with the double down-arrows, same as the YouTube
  // button. While recording, the arrows give way to a pulsing red dot.
  function createIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'nvs-ring');
    ring.setAttribute('cx', '18');
    ring.setAttribute('cy', '18');
    ring.setAttribute('r', '16');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'currentColor');
    ring.setAttribute('stroke-width', '2.4');
    const arrows = document.createElementNS(SVG_NS, 'path');
    arrows.setAttribute('class', 'nvs-arrows');
    arrows.setAttribute('fill', 'currentColor');
    arrows.setAttribute('d', 'M10.8 5.53h14.4L18 18z M10.8 18h14.4L18 30.47z');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'nvs-rec-dot');
    dot.setAttribute('cx', '18');
    dot.setAttribute('cy', '18');
    dot.setAttribute('r', '7');
    dot.setAttribute('fill', 'currentColor');
    svg.append(ring, arrows, dot);
    return svg;
  }

  function setButtonState(recording) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.classList.toggle('recording', recording);
    button.title = recording
      ? 'Остановить запись и сохранить файл (NVS)'
      : 'Записать трансляцию (Nova Video Saver)';
    button.setAttribute('aria-label', button.title);
    const badge = button.querySelector('.nvs-rec-time');
    if (badge && !recording) badge.textContent = '';
  }

  function updateBadge() {
    const badge = document.querySelector(`#${BUTTON_ID} .nvs-rec-time`);
    if (badge && recorder) badge.textContent = formatElapsed(Date.now() - startedAt);
  }

  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function cleanupWatchdog() {
    clearInterval(watchdog);
    watchdog = null;
    if (recordedVideo) {
      recordedVideo.removeEventListener('ended', onPlayerEnded);
      recordedVideo = null;
    }
  }

  function onPlayerEnded() {
    stopRecording('трансляция завершилась');
  }

  async function startRecording() {
    if (recorder) return;
    const media = findPlayerVideo();
    if (!media) {
      toast('NVS: плеер не найден');
      return;
    }
    if (media.paused) {
      try { await media.play(); } catch (error) {}
    }
    let stream;
    try {
      stream = media.captureStream();
    } catch (error) {
      toast(`NVS: не удалось захватить поток (${error?.message || error})`);
      return;
    }
    if (!stream.getVideoTracks().length) {
      toast('NVS: видеопоток пока недоступен, попробуйте через пару секунд');
      return;
    }
    recorderMime = pickMimeType() || 'video/webm';
    parts = [];
    stopReason = '';
    recordingChannel = channelFromLocation();
    startPath = location.pathname;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: recorderMime || undefined,
        videoBitsPerSecond: 12_000_000,
        audioBitsPerSecond: 192_000,
      });
    } catch (error) {
      recorder = null;
      toast(`NVS: MediaRecorder недоступен (${error?.message || error})`);
      return;
    }
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) parts.push(event.data);
    };
    recorder.onstop = finalizeRecording;
    recorder.onerror = () => {
      // A fatal recorder error still ends with the final dataavailable and a
      // native stop event; calling stop()/finalize here would lose that tail
      // chunk and run finalize twice. Record the reason and let onstop finish.
      stopReason = 'ошибка записи потока';
      cleanupWatchdog();
    };
    recorder.start(1000);
    startedAt = Date.now();
    recordedVideo = media;
    media.addEventListener('ended', onPlayerEnded);
    // A raid/host or manual navigation replaces the stream: the file must be
    // finalized immediately, not silently record the next channel.
    watchdog = setInterval(() => {
      if (location.pathname !== startPath) {
        stopRecording('канал сменился');
        return;
      }
      if (recordedVideo && !document.contains(recordedVideo)) {
        stopRecording('плеер закрыт');
        return;
      }
      updateBadge();
    }, 1000);
    setButtonState(true);
    toast(`NVS: запись начата (${recordingChannel})`);
  }

  function stopRecording(reason) {
    if (!recorder) return;
    stopReason = reason || '';
    cleanupWatchdog();
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); return; } catch (error) {}
    }
    finalizeRecording();
  }

  function finalizeRecording() {
    const active = recorder;
    recorder = null;
    cleanupWatchdog();
    setButtonState(false);
    const blob = new Blob(parts, { type: active?.mimeType || recorderMime });
    parts = [];
    if (blob.size < 100_000) {
      toast('NVS: запись слишком короткая, файл не сохранён');
      return;
    }
    const stamp = new Date(startedAt).toLocaleString('sv').replace(/:/g, '-').replace(' ', '_');
    const channel = (recordingChannel || 'stream').replace(/[\\/:*?"<>|]+/g, '_');
    const filename = `Twitch - ${channel} - ${stamp}.webm`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    toast(`NVS: сохраняю ${filename}${stopReason ? ` (${stopReason})` : ''}`);
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'nvs-twitch-btn';
    button.type = 'button';
    button.append(createIcon());
    const badge = document.createElement('span');
    badge.className = 'nvs-rec-time';
    button.append(badge);
    button.addEventListener('click', () => {
      if (recorder) stopRecording('остановлено пользователем');
      else void startRecording();
    });
    return button;
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const group = findControlsGroup();
    if (!group || !findPlayerVideo()) return;
    group.prepend(createButton());
    setButtonState(Boolean(recorder));
  }

  function scheduleInject() {
    if (injectFrame) return;
    injectFrame = requestAnimationFrame(() => {
      injectFrame = undefined;
      ensureButton();
    });
  }

  new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
  scheduleInject();
  window.addEventListener('beforeunload', () => {
    // Best effort: flush what was recorded before the tab goes away.
    if (recorder) stopRecording('страница закрывается');
  });
})();
