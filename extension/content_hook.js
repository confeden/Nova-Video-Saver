// content_hook.js — runs in the PAGE (MAIN world) at document_start.
// Modern YouTube streams separate SABR tracks. This hook passively captures the
// player's ordered media bytes from SourceBuffer, then briefly advances
// the buffer edge only when the requested tail has not been loaded yet.

(function () {
  if (window.__novaHookInstalled) return;
  window.__novaHookInstalled = true;

  const TO_UI = '__nova_to_ui';
  const FROM_UI = '__nova_from_ui';
  const TO_HOOK = '__nova_to_hook';
  const FROM_HOOK = '__nova_from_hook';
  let backgroundRequestSequence = 1;
  const backgroundRequests = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data[FROM_UI] !== true) return;
    const request = backgroundRequests.get(ev.data.reqId);
    if (request) {
      backgroundRequests.delete(ev.data.reqId);
      clearTimeout(request.timeout);
      if (ev.data.ok === false) request.reject(new Error(ev.data.error || 'extension bridge failed'));
      else request.resolve(ev.data.resp);
    }
  });

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      const reqId = backgroundRequestSequence++;
      const timeout = setTimeout(() => {
        backgroundRequests.delete(reqId);
        reject(new Error('extension bridge timed out'));
      }, 30_000);
      backgroundRequests.set(reqId, { resolve, reject, timeout });
      window.postMessage({ [TO_UI]: true, reqId, msg }, location.origin);
    });
  }

  function sendLog(msg) {
    window.postMessage({ [TO_UI]: true, msg }, location.origin);
  }

  function log(tag, ...args) {
    try {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      console.log('[NOVA ' + tag + '] ' + text);
      sendLog({ t: 'nova-log', tag, text });
    } catch (e) {}
  }

  const MAX_CAPTURE_TRACK_BYTES = 750_000_000;
  const AUDIO_ITAGS = new Set(['139', '140', '141', '249', '250', '251', '256', '258', '325', '328', '338', '599', '600', '774']);
  const VIDEO_ITAG_HEIGHT = new Map([
    ['160', 144], ['278', 144], ['330', 144], ['394', 144],
    ['133', 240], ['242', 240], ['331', 240], ['395', 240],
    ['134', 360], ['243', 360], ['332', 360], ['396', 360],
    ['135', 480], ['244', 480], ['245', 480], ['246', 480], ['333', 480], ['397', 480],
    ['136', 720], ['247', 720], ['298', 720], ['302', 720], ['334', 720], ['398', 720],
    ['137', 1080], ['248', 1080], ['299', 1080], ['303', 1080], ['335', 1080], ['399', 1080],
    ['264', 1440], ['271', 1440], ['308', 1440], ['336', 1440], ['400', 1440],
    ['266', 2160], ['272', 2160], ['313', 2160], ['315', 2160], ['337', 2160], ['401', 2160],
  ]);
  const MUSIC_HOST = location.hostname === 'music.youtube.com';
  // Paused seeks starve faster on Music before SABR reacts; escalate to the
  // playback-driven rescue much sooner there.
  const CAPTURE_IDLE_ESCALATION_MS = MUSIC_HOST ? 6_000 : 20_000;

  if (MUSIC_HOST) {
    // ytmusic's beforeunload prompt ("changes you made may not be saved")
    // blocks every automated reload/navigation of the download queue behind
    // a dialog the user has to click through. Drop those handlers.
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = function (type, ...rest) {
      if (type === 'beforeunload') return undefined;
      return originalAddEventListener(type, ...rest);
    };
    try {
      Object.defineProperty(window, 'onbeforeunload', {
        configurable: true,
        get() { return null; },
        set() {},
      });
    } catch (e) {}
    // Capture seeks may touch the very end of a track; ytmusic answers a
    // fired 'ended' by jumping to the next queue item mid-download. While a
    // download is active, clamp programmatic seeks just short of the end.
    try {
      const timeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        enumerable: timeDescriptor.enumerable,
        get: timeDescriptor.get,
        set(value) {
          let target = Number(value);
          if (store.musicSeekClamp) {
            const mediaDuration = Number(this.duration);
            // 1.2s shy of the end: ytmusic treats positions closer than that
            // as "track finished" and advances the queue even while paused.
            if (Number.isFinite(mediaDuration) && mediaDuration > 3
              && Number.isFinite(target) && target > mediaDuration - 1.2) {
              target = Math.max(0, mediaDuration - 1.2);
            }
          }
          return timeDescriptor.set.call(this, target);
        },
      });
    } catch (e) {}
  }

  // Worker script URLs must be TrustedScriptURL wherever Trusted Types are
  // enforced (music.youtube.com does). Without a policy the MSE worker bridge
  // below silently fell back to an unwrapped worker and captured nothing.
  let novaScriptUrlPolicy = null;
  try {
    novaScriptUrlPolicy = window.trustedTypes?.createPolicy?.(
      `nova-worker-${Math.random().toString(36).slice(2)}`,
      { createScriptURL: (input) => input },
    ) || null;
  } catch (e) {}
  const asWorkerScriptUrl = (rawUrl) => {
    if (!novaScriptUrlPolicy) return rawUrl;
    try { return novaScriptUrlPolicy.createScriptURL(rawUrl); } catch (e) { return rawUrl; }
  };

  const store = {
    // MSE running inside a dedicated worker is observed through the worker
    // bridge; these transports cannot be manipulated like page SourceBuffers,
    // so range removal is requested by message instead.
    workerTransports: { audio: new Set(), video: new Set() },
    workerRemoveAcks: 0,
    // Init segments survive resetCapture: a worker-side SourceBuffer often
    // keeps serving a new track without re-appending its decoder init.
    initFallback: Object.create(null),
    videoId: null,
    capturing: false,
    tracks: Object.create(null),
    _lastInit: Object.create(null),
    _pendingInit: Object.create(null),
    trackRevision: { audio: 0, video: 0 },
    lastAppendAt: { audio: 0, video: 0 },
    captureError: null,
    sourceBuffers: { audio: new Set(), video: new Set() },
    observedMediaFormats: { audio: [], video: [] },
    innertubeFormats: null,
    innertubeRefusals: 0,
    innertubeBlockedUntil: 0,
    // Set to 'audio'/'video' while a sequential pass rebuilds that one track.
    singleTrackPass: null,
    // True for the whole of a download: capture helpers must not un-silence.
    silenceHeld: false,
    invalidDirectUrls: new Set(),
    mediaEpochStart: performance.now(),
    completedAudioCache: null,
    mp3Isolation: null,
    liveSession: null,
    cancelRequested: false,
  };

  function throwIfDownloadCancelled() {
    if (!store.cancelRequested) return;
    const error = new Error('загрузка отменена пользователем');
    error.novaFatal = true;
    error.details = { cancelled: true };
    throw error;
  }

  function vidId() {
    try {
      const q = new URLSearchParams(location.search).get('v');
      if (q) return q;
      // embed / watch URLs: /embed/VIDEO_ID or /shorts/VIDEO_ID
      const m = location.pathname.match(/\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }
  function resetCapture() {
    store.tracks = Object.create(null);
    store._lastInit = Object.create(null);
    store._pendingInit = Object.create(null);
    store.trackRevision = { audio: 0, video: 0 };
    store.lastAppendAt = { audio: 0, video: 0 };
    store.captureError = null;
    store.invalidDirectUrls.clear();
    // YouTube can reuse its MediaSource across SPA navigation. Keep registered
    // SourceBuffers and discard only ones already detached from their source.
    liveSourceBuffers('audio', false);
    liveSourceBuffers('video', false);
  }

  // A capture helper snapshots `muted` when it starts and restores it when it
  // finishes. That snapshot can predate the download-wide mute, so restoring it
  // un-silences the tab in the middle of a download — which is why sound kept
  // returning however hard the top level muted things. While a download holds
  // the silence, these local restores are ignored.
  function restoreMediaMuted(media, previousMuted) {
    try { if (media) media.muted = store.silenceHeld ? true : previousMuted; } catch (e) {}
  }

  // YouTube's own player re-asserts `muted = false` while it manages playback:
  // measured at 22 writes in 12 seconds during a capture, all from base.js.
  // Reacting to `volumechange` is far too late — on a page busy with capture the
  // event arrives hundreds of milliseconds after the write, and those windows
  // (up to 867 ms observed) are exactly the sound users hear. So the write is
  // refused at the property level for as long as a download holds the silence.
  function installSilenceClamp() {
    const proto = HTMLMediaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'muted');
    if (typeof descriptor?.get !== 'function' || typeof descriptor?.set !== 'function') return () => {};
    try {
      Object.defineProperty(proto, 'muted', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() { return descriptor.get.call(this); },
        set(value) {
          if (value === false && store.silenceHeld) return;
          descriptor.set.call(this, value);
        },
      });
    } catch (e) {
      return () => {};
    }
    return () => {
      try { Object.defineProperty(proto, 'muted', descriptor); } catch (e) {}
    };
  }

  function liveSourceBuffers(kind, currentVideoOnly = true) {
    const buffers = [];
    const currentVideoId = vidId();
    for (const sb of [...store.sourceBuffers[kind]]) {
      try {
        void sb.buffered;
        if (!currentVideoOnly || sb.__novaInitVideoId === currentVideoId) buffers.push(sb);
      } catch (e) {
        store.sourceBuffers[kind].delete(sb);
      }
    }
    return buffers;
  }

  const isAv1 = (s) => typeof s === 'string' && /av01|av1\b/i.test(s);
  try {
    const origITS = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => (isAv1(type) ? false : origITS(type));
  } catch (e) {}
  try {
    const proto = HTMLMediaElement.prototype;
    const origCPT = proto.canPlayType;
    proto.canPlayType = function (type) { return isAv1(type) ? '' : origCPT.call(this, type); };
  } catch (e) {}

  function u8of(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  function startsWithInit(u8) {
    if (u8.length >= 4 && u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return true;
    if (u8.length >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
    return false;
  }
  function fragmentFingerprint(u8) {
    // FNV-1a over the complete fragment. Seek retries can append byte-identical
    // moof/mdat or WebM clusters; retaining both creates duplicate timestamps.
    let hash = 0x811c9dc5;
    for (let index = 0; index < u8.length; index++) {
      hash = Math.imul(hash ^ u8[index], 0x01000193);
    }
    return `${u8.length}:${hash >>> 0}`;
  }
  function rememberTimedText(text) {
    if (!text || text.length <= 5) return;
    const captured = window.__nova_captured_timedtext ||= [];
    captured.push(text);
    if (captured.length > 20) captured.splice(0, captured.length - 20);
  }

  function rememberTranscriptParams(text) {
    if (!text) return;
    const params = window.__nova_next_params ||= [];
    const pattern = /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/g;
    for (const match of text.matchAll(pattern)) params.push(match[1]);
    if (params.length > 50) params.splice(0, params.length - 50);
  }

  function rememberObservedMediaFormat(rawUrl, source = 'request-observer') {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      if (url.protocol !== 'https:'
        || (url.hostname !== 'googlevideo.com' && !url.hostname.endsWith('.googlevideo.com'))) return;
      const mimeType = url.searchParams.get('mime') || '';
      const itag = url.searchParams.get('itag') || '';
      const kind = /^audio\//i.test(mimeType) || AUDIO_ITAGS.has(itag)
        ? 'audio' : (/^video\//i.test(mimeType) || VIDEO_ITAG_HEIGHT.has(itag) ? 'video' : null);
      if (!kind) return;
      const durationSeconds = Number(url.searchParams.get('dur')) || Number(video()?.duration) || 0;
      // Rungs are named by the short edge: a portrait Short's 1080p stream is
      // 1080x1920, so reading the tall side would label it "1920p".
      const sizeMatch = (url.searchParams.get('size') || '').match(/^(\d+)x(\d+)$/i);
      const shortEdge = sizeMatch
        ? Math.min(Number(sizeMatch[1]), Number(sizeMatch[2]))
        : Math.min(Number(url.searchParams.get('width')) || Infinity,
          Number(url.searchParams.get('height')) || Infinity);
      const observedHeight = kind === 'video'
        ? (VIDEO_ITAG_HEIGHT.get(itag) || (Number.isFinite(shortEdge) ? shortEdge : 0) || null)
        : null;
      const entry = {
        url: withoutTransientMediaParams(url.href),
        itag,
        mimeType,
        contentLength: Number(url.searchParams.get('clen')) || 0,
        approxDurationMs: durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0,
        // Never infer an unknown itag from the currently selected player
        // quality. Progressive itag 18 (360p) was otherwise mislabelled 1080p.
        height: observedHeight,
        videoId: vidId(),
        observedAt: Date.now(),
        _novaSource: source,
      };
      if (!directUrlIsUsable(entry.url)) return;
      const entries = store.observedMediaFormats[kind];
      const key = `${entry.videoId || ''}:${entry.itag}:${entry.height || ''}:${entry.url}`;
      const duplicateIndex = entries.findIndex((candidate) => candidate._novaKey === key);
      entry._novaKey = key;
      if (duplicateIndex >= 0) entries.splice(duplicateIndex, 1);
      entries.push(entry);
      if (entries.length > 30) entries.splice(0, entries.length - 30);
      if (source === 'worker-request' && duplicateIndex < 0) {
        log('direct-url', 'worker observed; kind=', kind,
          'itag=', itag || null, 'height=', observedHeight || null);
      }
    } catch (e) {}
  }

  async function inspectFetchResponse(response, url) {
    try {
      if (/youtube\.com\/api\/timedtext/.test(url)) {
        rememberTimedText(await response.clone().text());
      } else if (/youtubei\/v1\/(?:next|engage)/.test(url)) {
        rememberTranscriptParams(await response.clone().text());
      }
    } catch (e) {}
  }

  const OrigFetch = window.fetch ? window.fetch.bind(window) : null;
  if (OrigFetch) {
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      rememberObservedMediaFormat(url);
      return OrigFetch(input, init).then((response) => {
        inspectFetchResponse(response, url);
        return response;
      });
    };
  }

  try {
    const xhrUrl = Symbol('novaUrl');
    const xhrWrapped = Symbol('novaWrapped');
    const OrigXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (!this[xhrWrapped]) {
        this.addEventListener('load', function () {
          const url = this[xhrUrl] || this.responseURL || '';
          try {
            if (/youtube\.com\/api\/timedtext/.test(url)) {
              rememberTimedText(this.responseText);
            } else if (/youtubei\/v1\/(?:next|engage)/.test(url)) {
              rememberTranscriptParams(this.responseText);
            }
          } catch (e) {}
        });
        this[xhrWrapped] = true;
      }
      return OrigXHRSend.apply(this, arguments);
    };
    const OrigXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method, url) {
      this[xhrUrl] = String(url || '');
      rememberObservedMediaFormat(this[xhrUrl]);
      return OrigXHROpen.apply(this, arguments);
    };
  } catch (e) {}

  // ---- ordered media capture -------------------------------------------------
  function hookMediaSourceConstructor(MediaSourceConstructor, label) {
    const proto = MediaSourceConstructor?.prototype;
    if (!proto || typeof proto.addSourceBuffer !== 'function' || proto.addSourceBuffer.__novaWrapped) return;
    const originalAddSourceBuffer = proto.addSourceBuffer;
    const wrappedAddSourceBuffer = function (mime) {
      const sb = originalAddSourceBuffer.call(this, mime);
      try {
        sb.__novaMime = mime;
        sb.__novaKind = /audio/i.test(mime) ? 'audio' : (/video/i.test(mime) ? 'video' : null);
        sb.__novaMediaSourceType = label;
        if (sb.__novaKind) store.sourceBuffers[sb.__novaKind].add(sb);
      } catch (e) {}
      return sb;
    };
    wrappedAddSourceBuffer.__novaWrapped = true;
    proto.addSourceBuffer = wrappedAddSourceBuffer;
  }
  hookMediaSourceConstructor(window.MediaSource, 'MediaSource');
  hookMediaSourceConstructor(window.ManagedMediaSource, 'ManagedMediaSource');
  function observeMediaAppend(transport, data) {
    try {
      if (store.liveSession) forwardLiveAppend(transport, data);
      const kind = transport.__novaKind;
      if (kind === 'video' || kind === 'audio') {
        const currentVideoId = vidId();
        // yt-navigate-finish can arrive after the first media append. Reset on
        // the first observed URL video-id change so passive capture never loses
        // the opening fragments of an SPA-loaded video.
        if (currentVideoId && store.videoId && currentVideoId !== store.videoId) {
          store.videoId = currentVideoId;
          store.mediaEpochStart = performance.now();
          store.completedAudioCache = null;
          store.mp3Isolation = null;
          resetCapture();
          if (!store.liveSession) store.capturing = true;
          log('capture', 'video change detected from media append; vid=', currentVideoId);
        }
        // Re-register buffers after resetCapture or a YouTube SPA transition.
        if (!transport.__novaWorker) store.sourceBuffers[kind].add(transport);
        transport.__novaLastAppendAt = Date.now();
        if (!store.capturing) {
          const dormantBytes = u8of(data);
          if (dormantBytes?.length && startsWithInit(dormantBytes)) {
            const bytes = dormantBytes.slice();
            transport.__novaLastInit = {
              bytes,
              mime: transport.__novaMime || '',
              height: kind === 'video' ? currentQuality() : null,
              initKey: fragmentFingerprint(dormantBytes),
            };
            transport.__novaInitVideoId = currentVideoId;
            store.initFallback[kind] = transport.__novaLastInit;
          }
        }
      }
      if ((kind === 'video' || kind === 'audio') && store.capturing && !store.captureError) {
        const u8 = u8of(data);
        if (u8 && u8.length) {
          store.lastAppendAt[kind] = Date.now();
          const init = startsWithInit(u8);
          const mime = transport.__novaMime || '';
          if (init) {
            const bytes = u8.slice();
            const height = kind === 'video' ? currentQuality() : null;
            const initKey = fragmentFingerprint(u8);
            const previousInit = store._lastInit[kind];
            const initRecord = { bytes, mime, height, initKey };
            transport.__novaLastInit = initRecord;
            transport.__novaInitVideoId = currentVideoId;
            store._lastInit[kind] = initRecord;
            store.initFallback[kind] = initRecord;
            if (store.tracks[kind] && previousInit?.initKey !== initKey) {
              // Keep the complete previous representation until the first media
              // fragment for the new one arrives; an init-only file is unusable.
              store._pendingInit[kind] = { bytes, mime, height, initKey };
            } else {
              store.tracks[kind] ||= {
                mime, height, parts: [bytes], seen: new Set(), duplicates: 0, capturedBytes: bytes.length,
              };
            }
          } else {
            // A sequential pass rewinds and replays the whole video to rebuild
            // ONE track. The player keeps serving the other one, and those bytes
            // piled onto an already complete track: a finished 555 MB video grew
            // to 750 MB during an audio-only pass and tripped the memory ceiling.
            // The companion is already captured — drop its fragments here.
            if (store.singleTrackPass && store.singleTrackPass !== kind) return;
            const appendMediaTime = Number(video()?.currentTime);
            if (!store._lastInit[kind] && transport.__novaLastInit) {
              // YouTube commonly reuses one SourceBuffer across SPA videos and
              // omits a new init when the codec configuration is unchanged.
              // The first media fragment proves that this attached transport is
              // now serving the current video, so its decoder init is reusable.
              const reusedAcrossNavigation = transport.__novaInitVideoId !== currentVideoId;
              store._lastInit[kind] = {
                ...transport.__novaLastInit,
                height: kind === 'video' ? (currentQuality() || transport.__novaLastInit.height) : null,
              };
              transport.__novaInitVideoId = currentVideoId;
              if (reusedAcrossNavigation) log('capture', 'reused active MSE init; kind=', kind, 'vid=', currentVideoId);
            }
            if (!store._lastInit[kind] && store.initFallback[kind]) {
              // Worker-side buffers are recreated per stream, losing their own
              // init reference; the remembered one belongs to the same decoder
              // configuration as long as the MIME type matches.
              const fallback = store.initFallback[kind];
              if (!mime || !fallback.mime || mime === fallback.mime) {
                store._lastInit[kind] = fallback;
                log('capture', 'reused remembered init segment; kind=', kind,
                  'worker=', Boolean(transport.__novaWorker), 'mime=', mime || fallback.mime || '');
              }
            }
            const pendingInit = store._pendingInit[kind];
            const partKey = fragmentFingerprint(u8);
            let t;
            if (pendingInit) {
              // Atomically switch representations so bytes from different fMP4
              // tracks never share one output file.
              t = store.tracks[kind] = {
                mime: mime || pendingInit.mime,
                height: kind === 'video' ? (currentQuality() || pendingInit.height) : null,
                parts: [pendingInit.bytes, u8.slice()],
                seen: new Set([partKey]),
                duplicates: 0,
                capturedBytes: pendingInit.bytes.length + u8.length,
                firstMediaTime: Number.isFinite(appendMediaTime) ? appendMediaTime : null,
                lastMediaTime: Number.isFinite(appendMediaTime) ? appendMediaTime : null,
              };
              store.trackRevision[kind] += 1;
              delete store._pendingInit[kind];
            } else {
              t = store.tracks[kind];
            }
            if (!t) {
              const savedInit = store._lastInit[kind];
              if (savedInit) {
                t = store.tracks[kind] = {
                  mime: mime || savedInit.mime,
                  height: kind === 'video' ? (currentQuality() || savedInit.height) : null,
                  parts: [savedInit.bytes, u8.slice()],
                  seen: new Set([partKey]),
                  duplicates: 0,
                  capturedBytes: savedInit.bytes.length + u8.length,
                  firstMediaTime: Number.isFinite(appendMediaTime) ? appendMediaTime : null,
                  lastMediaTime: Number.isFinite(appendMediaTime) ? appendMediaTime : null,
                };
              }
            } else if (!pendingInit) {
              t.seen ||= new Set();
              if (t.seen.has(partKey)) {
                t.duplicates = (t.duplicates || 0) + 1;
              } else {
                t.capturedBytes ||= t.parts.reduce((total, part) => total + part.length, 0);
                if (t.capturedBytes + u8.length > MAX_CAPTURE_TRACK_BYTES) {
                  const error = new Error(`дорожка ${kind} превышает безопасный лимит памяти`);
                  error.details = { kind, bytes: t.capturedBytes + u8.length, limit: MAX_CAPTURE_TRACK_BYTES };
                  error.novaFatal = true;
                  store.captureError = error;
                  store.capturing = false;
                } else {
                  t.seen.add(partKey);
                  t.parts.push(u8.slice());
                  t.capturedBytes += u8.length;
                  if (kind === 'video') t.height = currentQuality() || t.height;
                }
              }
            }
            if (t && Number.isFinite(appendMediaTime)) {
              t.firstMediaTime = Number.isFinite(t.firstMediaTime)
                ? Math.min(t.firstMediaTime, appendMediaTime) : appendMediaTime;
              t.lastMediaTime = Number.isFinite(t.lastMediaTime)
                ? Math.max(t.lastMediaTime, appendMediaTime) : appendMediaTime;
            }
          }
        }
      }
    } catch (e) {}
  }

  const OrigAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    observeMediaAppend(this, data);
    return OrigAppend.apply(this, arguments);
  };

  // Chrome can construct MediaSource and SourceBuffer inside a Dedicated
  // Worker. A MediaSourceHandle attached to the page still grows video.buffered,
  // but the Window SourceBuffer hook above never sees its bytes. Wrap workers
  // created after document_start and relay MSE appends back to this realm.
  const OrigWorker = window.Worker;
  if (typeof OrigWorker === 'function' && typeof URL?.createObjectURL === 'function') {
    const wrappedWorkerBlobUrls = new Set();
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function (objectUrl) {
      const normalized = String(objectUrl || '');
      if (wrappedWorkerBlobUrls.has(normalized)) {
        wrappedWorkerBlobUrls.delete(normalized);
        // Native Worker consumes its blob URL during construction. Our
        // bootstrap imports it from inside the new worker a moment later, so a
        // page's immediate revoke must be deferred until that import has run.
        setTimeout(() => {
          try { originalRevokeObjectURL(normalized); } catch (e) {}
        }, 60_000);
        return;
      }
      return originalRevokeObjectURL(objectUrl);
    };
    const buildWorkerBootstrap = (workerUrl, isModule) => {
      const originalUrl = JSON.stringify(new URL(String(workerUrl), location.href).href);
      const loader = isModule
        ? `import(${originalUrl}).catch((error) => setTimeout(() => { throw error; }));`
        : `importScripts(${originalUrl});`;
      return `
        (() => {
          let nextStreamId = 1;
          const novaPostMessage = self.postMessage.bind(self);
          const reportMediaUrl = (rawUrl) => {
            try {
              const url = new URL(String(rawUrl || ''), self.location.href);
              if (url.protocol === 'https:'
                && (url.hostname === 'googlevideo.com'
                  || url.hostname.endsWith('.googlevideo.com'))) {
                novaPostMessage({ __novaMediaUrl: true, url: url.href });
              }
            } catch (e) {}
          };
          try {
            if (typeof self.fetch === 'function') {
              const originalFetch = self.fetch.bind(self);
              self.fetch = function (input, init) {
                reportMediaUrl(typeof input === 'string' ? input : input?.url);
                return originalFetch(input, init);
              };
            }
          } catch (e) {}
          try {
            if (typeof self.XMLHttpRequest === 'function') {
              const originalOpen = self.XMLHttpRequest.prototype.open;
              self.XMLHttpRequest.prototype.open = function (method, url) {
                reportMediaUrl(url);
                return originalOpen.apply(this, arguments);
              };
            }
          } catch (e) {}
          const hookAppend = (proto) => {
            if (!proto || typeof proto.appendBuffer !== 'function' || proto.appendBuffer.__novaWorkerWrapped) return;
            const originalAppend = proto.appendBuffer;
            const wrappedAppend = function (data) {
              try {
                const kind = this.__novaKind;
                if (kind === 'audio' || kind === 'video') {
                  const view = data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
                  if (view.byteLength) {
                    const copy = view.slice();
                    novaPostMessage({
                      __novaMseSegment: true,
                      streamId: this.__novaStreamId,
                      kind,
                      mime: this.__novaMime || '',
                      bytes: copy.buffer,
                    }, [copy.buffer]);
                  }
                }
              } catch (e) {}
              return originalAppend.apply(this, arguments);
            };
            wrappedAppend.__novaWorkerWrapped = true;
            proto.appendBuffer = wrappedAppend;
          };
          const novaBuffers = new Map();
          const hookMediaSource = (Ctor) => {
            const proto = Ctor && Ctor.prototype;
            if (!proto || typeof proto.addSourceBuffer !== 'function' || proto.addSourceBuffer.__novaWorkerWrapped) return;
            const originalAddSourceBuffer = proto.addSourceBuffer;
            const wrappedAddSourceBuffer = function (mime) {
              const sourceBuffer = originalAddSourceBuffer.call(this, mime);
              sourceBuffer.__novaMime = String(mime || '');
              sourceBuffer.__novaKind = /audio/i.test(sourceBuffer.__novaMime)
                ? 'audio' : (/video/i.test(sourceBuffer.__novaMime) ? 'video' : null);
              sourceBuffer.__novaStreamId = nextStreamId++;
              novaBuffers.set(sourceBuffer.__novaStreamId, sourceBuffer);
              return sourceBuffer;
            };
            wrappedAddSourceBuffer.__novaWorkerWrapped = true;
            proto.addSourceBuffer = wrappedAddSourceBuffer;
          };
          // Buffered-range removal requested by the page: the capture pass
          // relies on it to make SABR re-serve ranges the player already has.
          // Registered before the real worker script, so stopImmediatePropagation
          // keeps these internal messages away from YouTube's own handlers.
          self.addEventListener('message', (event) => {
            const message = event.data;
            if (!message || message.__novaWorkerRemove !== true) return;
            event.stopImmediatePropagation();
            const sourceBuffer = novaBuffers.get(message.streamId);
            let removed = false;
            try {
              if (sourceBuffer && !sourceBuffer.updating) {
                for (let index = sourceBuffer.buffered.length - 1; index >= 0; index--) {
                  const start = Math.max(sourceBuffer.buffered.start(index), Math.max(0, message.start));
                  const end = Math.min(sourceBuffer.buffered.end(index), message.end);
                  if (start >= end || end <= 0) continue;
                  sourceBuffer.remove(start, end);
                  removed = true;
                  break; // one remove() per updating cycle
                }
              }
            } catch (e) {}
            novaPostMessage({ __novaWorkerRemoved: true, streamId: message.streamId, removed });
          });
          hookAppend(self.SourceBuffer && self.SourceBuffer.prototype);
          hookAppend(self.ManagedSourceBuffer && self.ManagedSourceBuffer.prototype);
          hookMediaSource(self.MediaSource);
          hookMediaSource(self.ManagedMediaSource);
          novaPostMessage({ __novaMseBridgeReady: true });
          ${loader}
        })();
      `;
    };

    const WrappedWorker = function (scriptURL, options) {
      let worker;
      let bootstrapUrl;
      let originalWorkerUrl;
      try {
        originalWorkerUrl = new URL(String(scriptURL), location.href).href;
        if (originalWorkerUrl.startsWith('blob:')) {
          wrappedWorkerBlobUrls.add(originalWorkerUrl);
          setTimeout(() => wrappedWorkerBlobUrls.delete(originalWorkerUrl), 60_000);
        }
        const isModule = options?.type === 'module';
        const bootstrap = buildWorkerBootstrap(originalWorkerUrl, isModule);
        bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], {
          type: isModule ? 'text/javascript' : 'application/javascript',
        }));
        worker = new OrigWorker(asWorkerScriptUrl(bootstrapUrl), options);
      } catch (error) {
        if (originalWorkerUrl) wrappedWorkerBlobUrls.delete(originalWorkerUrl);
        if (bootstrapUrl) try { URL.revokeObjectURL(bootstrapUrl); } catch (e) {}
        // Falling back means media handled by this worker stays invisible to
        // the capture; it must be visible in diagnostics, not silent.
        log('capture', 'worker MSE bridge not installed; using native worker:',
          String(error?.message || error));
        return new OrigWorker(scriptURL, options);
      }

      const transports = new Map();
      worker.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.__novaMediaUrl && message.url) {
          event.stopImmediatePropagation();
          rememberObservedMediaFormat(message.url, 'worker-request');
          return;
        }
        if (message?.__novaMseBridgeReady) {
          event.stopImmediatePropagation();
          log('capture', 'worker MSE bridge ready; module=', options?.type === 'module');
          return;
        }
        if (message?.__novaWorkerRemoved) {
          event.stopImmediatePropagation();
          if (message.removed) store.workerRemoveAcks += 1;
          return;
        }
        if (!message?.__novaMseSegment || !message.bytes) return;
        event.stopImmediatePropagation();
        const key = `${message.kind}:${message.streamId}`;
        let transport = transports.get(key);
        if (!transport) {
          transport = {
            __novaWorker: true,
            __novaKind: message.kind,
            __novaMime: String(message.mime || ''),
            __novaStreamId: message.streamId,
            __novaRequestRemove(start, end) {
              worker.postMessage({
                __novaWorkerRemove: true, streamId: message.streamId, start, end,
              });
            },
          };
          transports.set(key, transport);
          if (message.kind === 'audio' || message.kind === 'video') {
            store.workerTransports[message.kind].add(transport);
          }
          log('capture', 'worker MSE stream detected; kind=', message.kind,
            'mime=', message.mime || '');
        }
        observeMediaAppend(transport, new Uint8Array(message.bytes));
      }, true);
      if (bootstrapUrl) setTimeout(() => {
        try { URL.revokeObjectURL(bootstrapUrl); } catch (e) {}
      }, 60_000);
      return worker;
    };
    WrappedWorker.prototype = OrigWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, OrigWorker);
    window.Worker = WrappedWorker;
  }

  function readEbmlVint(bytes, offset, keepMarker = false) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let marker = 0x80;
    let length = 1;
    while (length <= 8 && !(first & marker)) {
      marker >>= 1;
      length += 1;
    }
    if (length > 8 || offset + length > bytes.length) return null;
    let value = keepMarker ? first : (first & (marker - 1));
    for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index];
    return { length, value };
  }

  function readUnsignedBytes(bytes, offset, length) {
    if (length < 1 || length > 8 || offset + length > bytes.length) return null;
    let value = 0;
    for (let index = 0; index < length; index++) value = value * 256 + bytes[offset + index];
    return Number.isSafeInteger(value) ? value : null;
  }

  function webmClusterTimecode(bytes, clusterOffset) {
    const clusterSize = readEbmlVint(bytes, clusterOffset + 4);
    if (!clusterSize) return null;
    let offset = clusterOffset + 4 + clusterSize.length;
    const limit = Math.min(bytes.length, offset + 512);
    while (offset < limit) {
      const id = readEbmlVint(bytes, offset, true);
      if (!id) return null;
      const size = readEbmlVint(bytes, offset + id.length);
      if (!size) return null;
      const payloadOffset = offset + id.length + size.length;
      if (id.value === 0xe7) return readUnsignedBytes(bytes, payloadOffset, size.value);
      if (!Number.isSafeInteger(size.value) || size.value < 0 || payloadOffset + size.value > bytes.length) return null;
      offset = payloadOffset + size.value;
    }
    return null;
  }

  function webmBlockRelativeTimecode(bytes, payloadOffset, payloadEnd) {
    const trackNumber = readEbmlVint(bytes, payloadOffset);
    if (!trackNumber) return null;
    const timecodeOffset = payloadOffset + trackNumber.length;
    if (timecodeOffset + 2 > payloadEnd) return null;
    let relative = (bytes[timecodeOffset] << 8) | bytes[timecodeOffset + 1];
    if (relative & 0x8000) relative -= 0x10000;
    return relative;
  }

  function webmClusterBlockTimecodes(bytes, clusterOffset, clusterEnd) {
    const clusterTimecode = webmClusterTimecode(bytes, clusterOffset);
    const clusterSize = readEbmlVint(bytes, clusterOffset + 4);
    if (!Number.isFinite(clusterTimecode) || !clusterSize) return [];
    const timecodes = [];
    const inspectElements = (start, end, nested = false) => {
      let offset = start;
      while (offset < end) {
        const id = readEbmlVint(bytes, offset, true);
        if (!id) break;
        const size = readEbmlVint(bytes, offset + id.length);
        if (!size || !Number.isSafeInteger(size.value) || size.value < 0) break;
        const payloadOffset = offset + id.length + size.length;
        const payloadEnd = payloadOffset + size.value;
        if (payloadEnd > end || payloadEnd > bytes.length) break;
        if (id.value === 0xa3 || (nested && id.value === 0xa1)) {
          const relative = webmBlockRelativeTimecode(bytes, payloadOffset, payloadEnd);
          if (Number.isFinite(relative)) {
            const absolute = clusterTimecode + relative;
            timecodes.push(absolute);
          }
        } else if (!nested && id.value === 0xa0) {
          inspectElements(payloadOffset, payloadEnd, true);
        }
        offset = payloadEnd;
      }
    };
    inspectElements(clusterOffset + 4 + clusterSize.length, clusterEnd);
    return timecodes;
  }

  function webmClusterLastBlockTimecode(bytes, clusterOffset, clusterEnd) {
    const timecodes = webmClusterBlockTimecodes(bytes, clusterOffset, clusterEnd);
    return timecodes.length ? Math.max(...timecodes) : null;
  }

  function webmPartsCoverage(parts, startMs, endMs, toleranceMs = 500) {
    const usableParts = (parts || []).filter((part) => part?.length);
    const totalBytes = usableParts.reduce((total, part) => total + part.length, 0);
    if (!totalBytes || totalBytes > 100_000_000) {
      return {
        covered: false, firstBlockMs: null, lastBlockMs: null,
        largestGapMs: null, blocks: 0,
      };
    }
    const bytes = new Uint8Array(totalBytes);
    let writeOffset = 0;
    for (const part of usableParts) {
      bytes.set(part, writeOffset);
      writeOffset += part.length;
    }
    const clusterOffsets = [];
    for (let offset = 0; offset + 4 <= bytes.length; offset++) {
      if (bytes[offset] !== 0x1f || bytes[offset + 1] !== 0x43
        || bytes[offset + 2] !== 0xb6 || bytes[offset + 3] !== 0x75) continue;
      if (Number.isFinite(webmClusterTimecode(bytes, offset))) {
        clusterOffsets.push(offset);
        offset += 3;
      }
    }
    const timecodes = [];
    for (let index = 0; index < clusterOffsets.length; index++) {
      const clusterOffset = clusterOffsets[index];
      const clusterEnd = index + 1 < clusterOffsets.length
        ? clusterOffsets[index + 1] : bytes.length;
      timecodes.push(...webmClusterBlockTimecodes(bytes, clusterOffset, clusterEnd));
    }
    timecodes.sort((left, right) => left - right);
    const unique = timecodes.filter((timecode, index) => (
      index === 0 || timecode - timecodes[index - 1] > 2
    ));
    const relevant = unique.filter((timecode) => (
      timecode >= startMs - toleranceMs && timecode <= endMs + toleranceMs
    ));
    let largestGapMs = 0;
    for (let index = 1; index < relevant.length; index++) {
      largestGapMs = Math.max(largestGapMs, relevant[index] - relevant[index - 1]);
    }
    const firstBlockMs = relevant.length ? relevant[0] : null;
    const lastBlockMs = relevant.length ? relevant[relevant.length - 1] : null;
    return {
      covered: Number.isFinite(firstBlockMs) && Number.isFinite(lastBlockMs)
        && firstBlockMs <= startMs + toleranceMs
        && lastBlockMs >= endMs - toleranceMs
        && largestGapMs <= toleranceMs,
      firstBlockMs,
      lastBlockMs,
      largestGapMs: relevant.length > 1 ? largestGapMs : null,
      blocks: relevant.length,
    };
  }

  function normalizeWebmClusters(bytes, kind, expectedDurationSeconds = 0, options = {}) {
    const clusters = [];
    for (let offset = 0; offset + 4 <= bytes.length; offset++) {
      if (bytes[offset] !== 0x1f || bytes[offset + 1] !== 0x43
        || bytes[offset + 2] !== 0xb6 || bytes[offset + 3] !== 0x75) continue;
      const timecode = webmClusterTimecode(bytes, offset);
      if (Number.isFinite(timecode)) {
        clusters.push({ offset, timecode, originalIndex: clusters.length });
        offset += 3;
      }
    }
    if (clusters.length < 2) {
      if ((kind === 'video' || (kind === 'audio' && options.strictEdges))
        && expectedDurationSeconds > 10) {
        const onlyTimecode = clusters.length ? clusters[0].timecode : 0;
        const error = new Error('видеодорожка содержит недостаточно WebM-кластеров');
        error.details = {
          kind,
          container: 'webm',
          missingTail: true,
          firstTimecode: onlyTimecode,
          lastTimecode: onlyTimecode,
          expectedEndMs: expectedDurationSeconds * 1000,
          typicalDelta: 0,
          tailToleranceMs: 2_500,
          clusters: clusters.length,
        };
        throw error;
      }
      return { bytes, container: 'webm', fragments: clusters.length, reordered: false };
    }

    const firstTimecode = Math.min(...clusters.map((cluster) => cluster.timecode));
    const prefixToleranceMs = kind === 'audio' && options.strictEdges ? 1_500 : 5_000;
    if (firstTimecode > prefixToleranceMs && !options.allowMissingPrefix) {
      const error = new Error(`дорожка ${kind} не содержит начало WebM (первый кластер ${firstTimecode} мс)`);
      error.details = {
        kind,
        container: 'webm',
        missingPrefix: true,
        firstTimecode,
        clusters: clusters.length,
      };
      throw error;
    }
    const sorted = [...clusters].sort((left, right) => left.timecode - right.timecode
      || left.originalIndex - right.originalIndex);
    const positiveDeltas = sorted.slice(1)
      .map((cluster, index) => cluster.timecode - sorted[index].timecode)
      .filter((delta) => delta > 0)
      .sort((left, right) => left - right);
    const typicalDelta = positiveDeltas.length
      ? positiveDeltas[Math.floor(positiveDeltas.length / 2)] : 0;
    const lastTimecode = Math.max(...clusters.map((cluster) => cluster.timecode));
    const lastCluster = [...clusters].sort((left, right) => right.timecode - left.timecode
      || right.originalIndex - left.originalIndex)[0];
    const lastClusterSourceEnd = lastCluster.originalIndex + 1 < clusters.length
      ? clusters[lastCluster.originalIndex + 1].offset : bytes.length;
    const lastBlockTimecode = webmClusterLastBlockTimecode(
      bytes, lastCluster.offset, lastClusterSourceEnd,
    );
    if (kind === 'video' && expectedDurationSeconds > 0) {
      // A cluster timecode marks the start of a cluster, not its end. Allow one
      // normal cluster cadence plus a small margin, but never let a complete
      // audio track hide a video tail that ends several clusters too early.
      const hasBlockEvidence = Number.isFinite(lastBlockTimecode);
      const tailEvidenceMs = hasBlockEvidence ? lastBlockTimecode : lastTimecode;
      const tailToleranceMs = hasBlockEvidence
        ? Math.max(1_000, Math.min(3_000, (typicalDelta || 3_000) * 0.4))
        : Math.max(2_500, Math.min(10_000, (typicalDelta || 3_000) * 1.5));
      const expectedEndMs = expectedDurationSeconds * 1000;
      if (tailEvidenceMs < expectedEndMs - tailToleranceMs) {
        const error = new Error(`видеодорожка не содержит конец WebM (последний кадр ${tailEvidenceMs} мс)`);
        error.details = {
          kind,
          container: 'webm',
          missingTail: true,
          firstTimecode,
          lastTimecode,
          lastBlockTimecode,
          tailEvidenceMs,
          expectedEndMs,
          typicalDelta,
          tailToleranceMs,
          clusters: clusters.length,
        };
        throw error;
      }
    }
    if (expectedDurationSeconds > 10) {
      // Container duration alone cannot prove completeness: FFmpeg preserves the
      // timestamps on both sides of a missing YouTube segment, so the hole is
      // muxed as silence on audio and as a frozen picture on video, held for
      // exactly as long as the lost fragment. Both tracks are therefore checked
      // for interior continuity; only the tolerance differs, because a valid
      // variable-frame-rate video track may hold one frame a little longer than
      // Opus ever stretches its packet cadence.
      const blockTimecodes = [];
      for (let index = 0; index < clusters.length; index++) {
        const cluster = clusters[index];
        const sourceEnd = index + 1 < clusters.length ? clusters[index + 1].offset : bytes.length;
        blockTimecodes.push(...webmClusterBlockTimecodes(bytes, cluster.offset, sourceEnd));
      }
      blockTimecodes.sort((left, right) => left - right);
      // Matroska block timecodes are signed relative to their cluster, so a
      // stray or partially appended block can land before zero. Such a value is
      // not a hole in the recording: kept in the list it fabricated a
      // "14274 ms gap" ending at 0, and the repair that followed was handed a
      // negative start it could only reject — three times, before escalating to
      // a re-capture that doubled the track and blew the memory ceiling.
      const negativeBlocks = blockTimecodes.filter((timecode) => timecode < 0).length;
      const sanitizedTimecodes = negativeBlocks
        ? blockTimecodes.filter((timecode) => timecode >= 0) : blockTimecodes;
      if (negativeBlocks) {
        log('assembly', `webm ${kind}; ignored`, negativeBlocks,
          'block timecode(s) before zero');
      }
      const uniqueTimecodes = sanitizedTimecodes.filter((timecode, index) => (
        index === 0 || timecode - sanitizedTimecodes[index - 1] > 2
      ));
      const blockDeltas = uniqueTimecodes.slice(1)
        .map((timecode, index) => timecode - uniqueTimecodes[index])
        .filter((delta) => delta > 2)
        .sort((left, right) => left - right);
      const typicalBlockDelta = blockDeltas.length
        ? blockDeltas[Math.floor(blockDeltas.length / 2)] : 0;
      const interiorGapToleranceMs = kind === 'video'
        ? Math.max(300, Math.min(1_500, (typicalBlockDelta || 17) * 15))
        : Math.max(500, Math.min(2_500, (typicalBlockDelta || 20) * 20));
      let largestGapMs = 0;
      let gapStartMs = 0;
      let gapEndMs = 0;
      for (let index = 1; index < uniqueTimecodes.length; index++) {
        const gapMs = uniqueTimecodes[index] - uniqueTimecodes[index - 1];
        if (gapMs > largestGapMs) {
          largestGapMs = gapMs;
          gapStartMs = uniqueTimecodes[index - 1];
          gapEndMs = uniqueTimecodes[index];
        }
      }
      log('assembly', `webm ${kind} continuity; blocks=`, uniqueTimecodes.length,
        'typicalDeltaMs=', typicalBlockDelta, 'largestGapMs=', largestGapMs,
        'toleranceMs=', interiorGapToleranceMs);
      if (options.strictEdges && uniqueTimecodes.length) {
        const firstBlockTimecode = uniqueTimecodes[0];
        const lastAudioBlockTimecode = uniqueTimecodes[uniqueTimecodes.length - 1];
        const expectedEndMs = expectedDurationSeconds * 1000;
        const audioTailToleranceMs = Math.max(
          1_000,
          Math.min(2_500, (typicalBlockDelta || 20) * 75),
        );
        if (firstBlockTimecode > 1_500) {
          const error = new Error(
            `аудиодорожка не содержит начало WebM (первый пакет ${firstBlockTimecode} мс)`,
          );
          error.details = {
            kind,
            container: 'webm',
            missingPrefix: true,
            firstTimecode: firstBlockTimecode,
            lastTimecode: lastAudioBlockTimecode,
            expectedEndMs,
            prefixToleranceMs: 1_500,
          };
          throw error;
        }
        if (lastAudioBlockTimecode < expectedEndMs - audioTailToleranceMs) {
          const error = new Error(
            `аудиодорожка не содержит конец WebM (последний пакет ${lastAudioBlockTimecode} мс)`,
          );
          error.details = {
            kind,
            container: 'webm',
            missingTail: true,
            firstTimecode: firstBlockTimecode,
            lastTimecode: lastAudioBlockTimecode,
            expectedEndMs,
            tailToleranceMs: audioTailToleranceMs,
          };
          throw error;
        }
      }
      if (largestGapMs > interiorGapToleranceMs) {
        const error = new Error(
          `дорожка ${kind} содержит внутренний разрыв WebM ${Math.round(largestGapMs)} мс`,
        );
        error.details = {
          kind,
          container: 'webm',
          missingInterior: true,
          firstTimecode,
          lastTimecode,
          expectedEndMs: expectedDurationSeconds * 1000,
          gapStartMs,
          gapEndMs,
          gapMs: largestGapMs,
          typicalBlockDelta,
          interiorGapToleranceMs,
          blocks: uniqueTimecodes.length,
          clusters: clusters.length,
        };
        throw error;
      }
    }
    // Boundary duplicates observed from YouTube differ by only 1 ms. Keep the
    // tolerance far below a legitimate cluster cadence, including short video
    // clusters, so ordinary neighbouring clusters are never merged.
    const overlapToleranceMs = Math.max(2, Math.min(50, typicalDelta * 0.02 || 2));
    const clusterStats = new Map();
    const statsForCluster = (cluster) => {
      if (clusterStats.has(cluster.originalIndex)) return clusterStats.get(cluster.originalIndex);
      const sourceEnd = cluster.originalIndex + 1 < clusters.length
        ? clusters[cluster.originalIndex + 1].offset : bytes.length;
      const blockTimes = webmClusterBlockTimecodes(bytes, cluster.offset, sourceEnd);
      const stats = {
        blockCount: blockTimes.length,
        firstBlock: blockTimes.length ? Math.min(...blockTimes) : cluster.timecode,
        lastBlock: blockTimes.length ? Math.max(...blockTimes) : cluster.timecode,
        byteLength: sourceEnd - cluster.offset,
      };
      stats.span = Math.max(0, stats.lastBlock - stats.firstBlock);
      clusterStats.set(cluster.originalIndex, stats);
      return stats;
    };
    const preferDuplicateCluster = (candidate, current) => {
      const candidateStats = statsForCluster(candidate);
      const currentStats = statsForCluster(current);
      // A bounded prefix/tail refill can append a short partial cluster with
      // the same cluster timecode as an already complete one. Keeping the
      // newest copy unconditionally used to manufacture an 8-second hole.
      if (candidateStats.span !== currentStats.span) {
        return candidateStats.span > currentStats.span ? candidate : current;
      }
      if (candidateStats.blockCount !== currentStats.blockCount) {
        return candidateStats.blockCount > currentStats.blockCount ? candidate : current;
      }
      if (candidateStats.firstBlock !== currentStats.firstBlock) {
        return candidateStats.firstBlock < currentStats.firstBlock ? candidate : current;
      }
      if (candidateStats.lastBlock !== currentStats.lastBlock) {
        return candidateStats.lastBlock > currentStats.lastBlock ? candidate : current;
      }
      if (candidateStats.byteLength !== currentStats.byteLength) {
        return candidateStats.byteLength > currentStats.byteLength ? candidate : current;
      }
      return current;
    };
    const normalizedClusters = [];
    let overlapDuplicates = 0;
    let overlapKeptBoth = 0;
    for (const cluster of sorted) {
      const previous = normalizedClusters[normalizedClusters.length - 1];
      if (previous && cluster.timecode - previous.timecode <= overlapToleranceMs) {
        // Prefix refill deliberately overlaps the old tail by a few seconds.
        // YouTube commonly timestamps the same boundary at 20000/20001 ms.
        // Keep the later appended copy and discard the near-identical cluster,
        // otherwise MP3 sample timestamp rebuilding adds a full extra segment.
        const kept = preferDuplicateCluster(cluster, previous);
        const dropped = kept === cluster ? previous : cluster;
        const keptStats = statsForCluster(kept);
        const droppedStats = statsForCluster(dropped);
        // ...but discarding is only safe when the survivor actually contains
        // the other one. A refilled prefix and the original tail share a
        // cluster timecode while covering different blocks, and dropping one
        // wholesale tore a hole at the seam that no later refill could close:
        // the bytes were never missing from the network, only from our copy.
        if (keptStats.firstBlock <= droppedStats.firstBlock
          && keptStats.lastBlock >= droppedStats.lastBlock) {
          normalizedClusters[normalizedClusters.length - 1] = kept;
          overlapDuplicates += 1;
        } else {
          normalizedClusters[normalizedClusters.length - 1] = previous;
          normalizedClusters.push(cluster);
          overlapKeptBoth += 1;
        }
      } else {
        normalizedClusters.push(cluster);
      }
    }
    if (overlapKeptBoth) {
      log('assembly', `webm ${kind}; kept`, overlapKeptBoth,
        'overlapping cluster(s) that covered different blocks');
    }
    const reordered = normalizedClusters.length !== clusters.length
      || normalizedClusters.some((cluster, index) => cluster !== clusters[index]);
    log('assembly', `webm ${kind}; clusters=`, clusters.length, 'unique=', normalizedClusters.length,
      'overlapDuplicates=', overlapDuplicates, 'overlapToleranceMs=', overlapToleranceMs,
      'first=', firstTimecode, 'last=', lastTimecode,
      'reordered=', reordered);
    if (!reordered) return { bytes, container: 'webm', fragments: clusters.length, reordered: false };

    const prefixEnd = clusters[0].offset;
    const sourceRange = (cluster) => {
      const sourceIndex = cluster.originalIndex;
      return {
        start: cluster.offset,
        end: sourceIndex + 1 < clusters.length ? clusters[sourceIndex + 1].offset : bytes.length,
      };
    };
    // When the survivors keep their original order — the usual case, where all
    // that changed is a dropped overlap duplicate — the result is a subsequence
    // of the input and can be compacted in place. Every write lands at or
    // before the byte it reads, so nothing unread is overwritten, and dropping
    // the tail with a zero-copy transfer keeps peak memory flat. The copying
    // path below needs a second full buffer, which is why it has a ceiling that
    // used to refuse a 555 MB track outright.
    const ranges = normalizedClusters.map(sourceRange);
    const ascending = ranges.every((range, index) => index === 0 || range.start >= ranges[index - 1].end);
    if (ascending && bytes.byteOffset === 0 && typeof bytes.buffer.transfer === 'function') {
      let compactOffset = prefixEnd;
      for (const range of ranges) {
        if (compactOffset !== range.start) bytes.copyWithin(compactOffset, range.start, range.end);
        compactOffset += range.end - range.start;
      }
      return {
        bytes: new Uint8Array(bytes.buffer.transfer(compactOffset)),
        container: 'webm',
        fragments: normalizedClusters.length,
        reordered: true,
        overlapDuplicates,
      };
    }
    if (bytes.length > 400_000_000) {
      const error = new Error(`дорожка ${kind} слишком велика для безопасной перестановки WebM-кластеров`);
      error.novaFatal = true;
      throw error;
    }
    const fragments = normalizedClusters.map((cluster) => {
      const sourceIndex = cluster.originalIndex;
      const sourceEnd = sourceIndex + 1 < clusters.length ? clusters[sourceIndex + 1].offset : bytes.length;
      return bytes.subarray(cluster.offset, sourceEnd);
    });
    const outputLength = prefixEnd + fragments.reduce((total, fragment) => total + fragment.length, 0);
    const output = new Uint8Array(outputLength);
    output.set(bytes.subarray(0, prefixEnd), 0);
    let writeOffset = prefixEnd;
    for (const fragment of fragments) {
      output.set(fragment, writeOffset);
      writeOffset += fragment.length;
    }
    if (writeOffset !== output.length) throw new Error(`ошибка перестановки WebM-фрагментов ${kind}`);
    return {
      bytes: output,
      container: 'webm',
      fragments: normalizedClusters.length,
      reordered: true,
      overlapDuplicates,
    };
  }

  function readU32(bytes, offset) {
    if (offset + 4 > bytes.length) return null;
    return (bytes[offset] * 0x1000000)
      + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8)
      + bytes[offset + 3];
  }

  function mp4FragmentDecodeTime(bytes, start, end) {
    for (let offset = start + 4; offset + 12 <= end; offset++) {
      if (bytes[offset] !== 0x74 || bytes[offset + 1] !== 0x66
        || bytes[offset + 2] !== 0x64 || bytes[offset + 3] !== 0x74) continue;
      const boxStart = offset - 4;
      const boxSize = readU32(bytes, boxStart);
      if (!boxSize || boxStart + boxSize > end || boxSize < 16) continue;
      const version = bytes[offset + 4];
      if (version === 0) return readU32(bytes, offset + 8);
      if (version === 1 && offset + 16 <= end) {
        const high = readU32(bytes, offset + 8);
        const low = readU32(bytes, offset + 12);
        const value = high * 0x100000000 + low;
        return Number.isSafeInteger(value) ? value : null;
      }
    }
    return null;
  }

  // Box walk over a captured fMP4 stream. Segments arrive in many appends and
  // can leave gaps or junk between fragments, so a strict sequential walk used
  // to stop at the first bad size — everything after it stayed unindexed and
  // was silently carried inside the last fragment, where no sample table
  // describes it (players then showed a few frames per second). Resyncing on
  // the next 'moof' keeps the whole stream addressable.
  function scanMp4Fragments(bytes) {
    const boxSizeAt = (offset) => {
      if (offset + 8 > bytes.length) return 0;
      let size = readU32(bytes, offset);
      if (size === 1) {
        if (offset + 16 > bytes.length) return 0;
        const high = readU32(bytes, offset + 8);
        const low = readU32(bytes, offset + 12);
        if (high !== 0) return 0; // > 4 GB is never a captured fragment
        size = low;
      }
      if (size < 8 || offset + size > bytes.length) return 0;
      return size;
    };
    const typeAt = (offset) => String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const findNextMoof = (from) => {
      for (let offset = from; offset + 8 <= bytes.length; offset++) {
        if (bytes[offset + 4] === 0x6d && bytes[offset + 5] === 0x6f
          && bytes[offset + 6] === 0x6f && bytes[offset + 7] === 0x66 && boxSizeAt(offset)) {
          return offset;
        }
      }
      return -1;
    };
    const fragments = [];
    let skippedBytes = 0;
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      const size = boxSizeAt(offset);
      if (!size) {
        const next = findNextMoof(offset + 1);
        if (next < 0) {
          skippedBytes += bytes.length - offset;
          break;
        }
        skippedBytes += next - offset;
        offset = next;
        continue;
      }
      if (typeAt(offset) === 'moof') {
        // A fragment is moof + the payload box that follows it; taking exactly
        // those two keeps every rebuilt fragment self-contained.
        let end = offset + size;
        const payloadSize = boxSizeAt(end);
        if (payloadSize && typeAt(end) === 'mdat') end += payloadSize;
        fragments.push({ offset, size, end, originalIndex: fragments.length });
        offset = end;
        continue;
      }
      offset += size;
    }
    return { fragments, skippedBytes };
  }

  function normalizeMp4Fragments(bytes, kind) {
    const scan = scanMp4Fragments(bytes);
    const moofs = scan.fragments;
    if (scan.skippedBytes) {
      log('assembly', `mp4 ${kind}; resynced past`, scan.skippedBytes, 'unindexed bytes');
    }
    for (const fragment of moofs) {
      fragment.decodeTime = mp4FragmentDecodeTime(bytes, fragment.offset,
        fragment.offset + fragment.size);
    }
    if (moofs.length < 2 || moofs.some((fragment) => !Number.isFinite(fragment.decodeTime))) {
      return { bytes, container: 'mp4', fragments: moofs.length, reordered: false };
    }
    const sorted = [...moofs].sort((left, right) => left.decodeTime - right.decodeTime
      || left.originalIndex - right.originalIndex);
    // A prefix refill can re-append fragments the capture already holds (same
    // decode time, possibly different bytes). Keep the first occurrence only:
    // duplicated fragments produce a repeated timeline that players reject.
    // Among fragments sharing a decode time keep the largest payload: a refill
    // can deliver a complete copy of a fragment the capture only half received.
    const deduped = sorted.filter((fragment, index) => {
      if (index > 0 && fragment.decodeTime === sorted[index - 1].decodeTime) return false;
      let best = fragment;
      for (let next = index + 1; next < sorted.length
        && sorted[next].decodeTime === fragment.decodeTime; next++) {
        if (sorted[next].end - sorted[next].offset > best.end - best.offset) best = sorted[next];
      }
      if (best !== fragment) {
        fragment.offset = best.offset;
        fragment.size = best.size;
        fragment.end = best.end;
      }
      return true;
    });
    const duplicatesDropped = sorted.length - deduped.length;
    const deltas = deduped.slice(1).map((fragment, index) => fragment.decodeTime - deduped[index].decodeTime)
      .filter((delta) => delta > 0);
    const normalDelta = deltas.length ? Math.min(...deltas) : 0;
    if (normalDelta && deduped[0].decodeTime > normalDelta * 1.5) {
      const error = new Error(`дорожка ${kind} не содержит начало MP4`);
      error.details = {
        kind, container: 'mp4', firstDecodeTime: deduped[0].decodeTime,
        normalDelta, fragments: moofs.length,
      };
      throw error;
    }
    const indexedBytes = moofs.reduce((total, fragment) => total + (fragment.end - fragment.offset), 0)
      + (moofs.length ? moofs[0].offset : 0);
    // Rebuild whenever anything was dropped, reordered, or left unindexed:
    // trailing junk inside the final fragment is exactly what turned a full
    // capture into a few frames per second.
    const changed = duplicatesDropped > 0
      || scan.skippedBytes > 0
      || indexedBytes !== bytes.length
      || deduped.some((fragment, index) => fragment !== moofs[index]);
    log('assembly', `mp4 ${kind}; fragments=`, moofs.length, 'unique=', deduped.length,
      'first=', deduped[0].decodeTime, 'last=', deduped[deduped.length - 1].decodeTime,
      'duplicatesDropped=', duplicatesDropped, 'indexedBytes=', indexedBytes,
      'totalBytes=', bytes.length, 'rebuilt=', changed);
    if (!changed) return { bytes, container: 'mp4', fragments: moofs.length, reordered: false };
    if (bytes.length > 400_000_000) {
      const error = new Error(`дорожка ${kind} слишком велика для безопасной перестановки MP4-фрагментов`);
      error.novaFatal = true;
      throw error;
    }
    const prefixEnd = moofs[0].offset;
    const fragmentSlices = deduped.map((fragment) => bytes.subarray(fragment.offset, fragment.end));
    const output = new Uint8Array(prefixEnd
      + fragmentSlices.reduce((total, slice) => total + slice.length, 0));
    output.set(bytes.subarray(0, prefixEnd), 0);
    let writeOffset = prefixEnd;
    for (const slice of fragmentSlices) {
      output.set(slice, writeOffset);
      writeOffset += slice.length;
    }
    if (writeOffset !== output.length) throw new Error(`ошибка перестановки MP4-фрагментов ${kind}`);
    return { bytes: output, container: 'mp4', fragments: deduped.length, reordered: true };
  }

  function normalizeCapturedTrack(bytes, mime, kind, expectedDurationSeconds = 0, options = {}) {
    const isWebm = /webm/i.test(mime)
      || (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3);
    if (isWebm) return normalizeWebmClusters(bytes, kind, expectedDurationSeconds, options);
    const isMp4 = /mp4/i.test(mime)
      || (bytes.length > 8 && ['ftyp', 'styp', 'moov'].includes(
        String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])));
    if (isMp4) return normalizeMp4Fragments(bytes, kind);
    return { bytes, container: 'unknown', fragments: 0, reordered: false };
  }

  function validateDirectAudioTrack(audio, expectedDurationSeconds) {
    const expectedDuration = Number(expectedDurationSeconds) || Number(video()?.duration) || 0;
    const declaredDuration = Number(audio?.duration) || 0;
    const durationTolerance = Math.max(1.5, expectedDuration * 0.005);
    if (expectedDuration > 10 && declaredDuration > 0
      && Math.abs(declaredDuration - expectedDuration) > durationTolerance) {
      const error = new Error(
        `прямая аудиодорожка короче видео (${declaredDuration.toFixed(3)} из ${expectedDuration.toFixed(3)} сек)`,
      );
      error.details = {
        kind: 'audio',
        source: audio?._novaSource || 'direct',
        declaredDuration,
        expectedDuration,
        durationTolerance,
      };
      throw error;
    }
    const normalized = normalizeCapturedTrack(
      audio.bytes, audio.mime || '', 'audio', expectedDuration, { strictEdges: true },
    );
    return { ...audio, bytes: normalized.bytes };
  }

  function firstCapturedWebmTimecode(kind) {
    const track = store.tracks[kind];
    if (!track?.parts?.length || !/webm/i.test(track.mime || '')) return null;
    let first = Infinity;
    for (const part of track.parts) {
      for (let offset = 0; offset + 4 <= part.length; offset++) {
        if (part[offset] !== 0x1f || part[offset + 1] !== 0x43
          || part[offset + 2] !== 0xb6 || part[offset + 3] !== 0x75) continue;
        const timecode = webmClusterTimecode(part, offset);
        if (Number.isFinite(timecode)) {
          first = Math.min(first, timecode);
          if (first === 0) return 0;
        }
        offset += 3;
      }
    }
    return Number.isFinite(first) ? first : null;
  }

  function assemble(options = {}) {
    if (store.captureError) throw store.captureError;
    const expectedDurationSeconds = Number(video()?.duration)
      || Number(player()?.getDuration?.()) || 0;
    const out = {};
    for (const kind of ['audio', 'video']) {
      if (kind === 'audio' && options.skipAudio) continue;
      const t = store.tracks[kind];
      if (!t || !t.parts.length) continue;
      let initIndex = -1;
      for (let index = 0; index < t.parts.length; index++) {
        if (startsWithInit(t.parts[index])) initIndex = index;
      }
      let parts = initIndex >= 0 ? t.parts.slice(initIndex) : t.parts;
      if (!startsWithInit(parts[0]) && store._lastInit[kind]) {
        parts = [store._lastInit[kind].bytes, ...parts];
      }
      if (!startsWithInit(parts[0])) {
        throw new Error(`дорожка ${kind} не содержит инициализационный сегмент`);
      }
      let n = 0; for (const p of parts) n += p.length;
      if (n > MAX_CAPTURE_TRACK_BYTES) {
        const error = new Error(`дорожка ${kind} превышает безопасный лимит памяти`);
        error.novaFatal = true;
        throw error;
      }
      const buf = new Uint8Array(n);
      let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      const normalized = normalizeCapturedTrack(
        buf, t.mime || '', kind, expectedDurationSeconds,
        {
          allowMissingPrefix: kind === 'video' && options.allowMissingVideoPrefix,
          strictEdges: kind === 'audio' && options.strictAudioEdges,
        },
      );
      out[kind] = { bytes: normalized.bytes, mime: t.mime, height: t.height || null };
      if (t.forceTranscode) out.forceTranscode = true;
      log('assembly', 'track assembled; kind=', kind, 'container=', normalized.container,
        'parts=', parts.length, 'droppedBeforeInit=', Math.max(0, initIndex),
        'rawBytes=', n, 'finalBytes=', normalized.bytes.length);
    }
    return out;
  }

  // ---- player helpers ------------------------------------------------------
  // A Shorts page carries BOTH players: the real #shorts-player inside the
  // active reel and a leftover, empty #movie_player whose getPlayerResponse()
  // returns null and whose duration is 0. Picking the wrong one made every
  // Shorts lookup silently answer "no video".
  const SHORTS_PATH = /^\/shorts\/[A-Za-z0-9_-]{6,}/;
  function isShortsPage() { return SHORTS_PATH.test(location.pathname); }
  function player() {
    const reel = document.getElementById('shorts-player');
    const watch = document.getElementById('movie_player');
    return isShortsPage() ? (reel || watch) : (watch || reel);
  }
  // Scoped to the chosen player: the Shorts feed keeps the neighbouring reels'
  // <video> elements in the DOM, so the first one in document order is often
  // not the one being watched.
  function video() {
    return player()?.querySelector('video') || document.querySelector('video');
  }

  // YouTube reports `height` as the long edge, so every rung of a portrait
  // Short is labelled by a number nobody selected: the 1080p rung is
  // height 1920. qualityLabel is the authoritative name of the rung (and the
  // only correct one for oddities such as 608x1080 = "480p").
  function formatQualityHeight(format) {
    const labelled = Number.parseInt(String(format?.qualityLabel || ''), 10);
    if (Number.isFinite(labelled) && labelled > 0) return labelled;
    const width = Number(format?.width) || 0;
    const height = Number(format?.height) || 0;
    if (width > 0 && height > 0) return Math.min(width, height);
    return height;
  }
  const QUALITY_BY_HEIGHT = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium', 240: 'small', 144: 'tiny' };
  const HEIGHT_BY_QUALITY = Object.fromEntries(Object.entries(QUALITY_BY_HEIGHT).map(([height, quality]) => [quality, Number(height)]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- playback hold -------------------------------------------------------
  // A capture pass is a sequence of paused seeks: SABR answers those with plain
  // range requests. Ordinary playback fights that — the player prefetches on its
  // own schedule, overrides the seek target and keeps advancing currentTime — so
  // downloads used to come out clean only when the user had already pressed
  // pause. Nova now pins the element to paused for the whole download and lifts
  // the pin only for the playback it starts on purpose (SABR primers and the
  // MediaRecorder fallbacks), then restores the user's play state at the end.
  let deliberatePlaybackDepth = 0;

  async function withDeliberatePlayback(run) {
    deliberatePlaybackDepth += 1;
    try {
      return await run();
    } finally {
      deliberatePlaybackDepth = Math.max(0, deliberatePlaybackDepth - 1);
    }
  }

  // Pause the way the user's own pause button does. HTMLMediaElement.pause()
  // alone stops the element while YouTube's player object still believes it is
  // playing; its SABR scheduler then keeps retrying playback instead of
  // answering the paused seeks the capture pass is built on, and the download
  // stalls behind a spinner. Going through pauseVideo() keeps both state
  // machines agreed, which is exactly the condition under which capture has
  // always worked.
  function pauseForCapture(media) {
    let viaPlayer = false;
    try {
      const activePlayer = player();
      if (activePlayer?.pauseVideo) {
        activePlayer.pauseVideo();
        viaPlayer = true;
      }
    } catch (e) {}
    try { if (media && !media.paused) media.pause(); } catch (e) {}
    return viaPlayer;
  }

  function holdPlaybackPaused(media) {
    let released = !media;
    let enforcements = 0;
    let pendingEnforce = 0;
    // A guard, not a fight. If YouTube insists on resuming this many times the
    // page is clearly driving playback for its own reasons; keep the capture
    // loop's own gentle pause and stop re-entering the contest.
    const enforcementLimit = 24;
    const enforce = () => {
      if (released || deliberatePlaybackDepth > 0) return;
      if (enforcements >= enforcementLimit || pendingEnforce) return;
      // Never pause synchronously inside the play event: that turns an autoplay
      // attempt into a play/pause storm and wedges the media pipeline.
      pendingEnforce = setTimeout(() => {
        pendingEnforce = 0;
        if (released || deliberatePlaybackDepth > 0) return;
        if (media.paused) return;
        enforcements += 1;
        pauseForCapture(media);
        if (enforcements >= enforcementLimit) {
          log('capture', 'playback hold reached its enforcement limit; leaving pacing to the capture loop');
        }
      }, 60);
    };
    if (media) {
      media.addEventListener('play', enforce, true);
      pauseForCapture(media);
    }
    return {
      media,
      enforce,
      release() {
        if (released) return;
        released = true;
        if (pendingEnforce) { clearTimeout(pendingEnforce); pendingEnforce = 0; }
        try { media.removeEventListener('play', enforce, true); } catch (e) {}
      },
    };
  }

  async function playWithTimeout(media, timeoutMs = 10_000) {
    // Every deliberate playback start goes through here, so the hold above can
    // tell "Nova asked for this" apart from autoplay or a user resume.
    deliberatePlaybackDepth += 1;
    let timer;
    const playback = media.play();
    // Promise.race observes rejection too, but keep an explicit handler on the
    // underlying play request because pause() below can reject it after timeout.
    playback?.catch?.(() => {});
    try {
      await Promise.race([
        playback,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`плеер не начал воспроизведение за ${Math.round(timeoutMs / 1000)} секунд`));
            // Prevent a late play() resolution from restarting the element
            // after the caller has already entered its failure/cleanup path.
            try { media.pause(); } catch (e) {}
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      deliberatePlaybackDepth = Math.max(0, deliberatePlaybackDepth - 1);
    }
  }
  let defaultQualityAppliedVideoId = null;
  let manuallySelectedQualityVideoId = null;
  let manualQualityRevision = 0;
  // What the monitor-based default asked for on this video. Applied once per
  // video, so it is the only record of the quality the viewer should end up on.
  let recommendedQuality = { videoId: null, quality: null };

  function setQualityRaw(q) {
    const p = player();
    try { p.setPlaybackQualityRange && p.setPlaybackQualityRange(q, q); } catch (e) {}
    try { p.setPlaybackQuality && p.setPlaybackQuality(q); } catch (e) {}
  }
  function recommendQuality(q) {
    const p = player();
    try { p && p.setPlaybackQuality && p.setPlaybackQuality(q); } catch (e) {}
  }
  // Quality names ordered worst to best, so a restore can only ever raise.
  const QUALITY_RANK = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080',
    'hd1440', 'hd2160', 'highres'];
  const qualityRank = (name) => QUALITY_RANK.indexOf(String(name || ''));

  function qualitySnapshot() {
    const p = player();
    let range = null;
    try { range = p?.getPlaybackQualityRange?.() || null; } catch (e) {}
    let quality = null;
    try { quality = p?.getPlaybackQuality?.() || null; } catch (e) {}
    // getPlaybackQuality() reports the rendition on screen right now, which is
    // not the same as what the viewer should get back. Two ways it lies: ABR
    // can be sitting on a lower rung at this instant, and a previous download
    // on the same page may have left the player pinned to its own low quality
    // — the recommendation only runs once per video, so nothing raised it back
    // and the next download would faithfully restore that leftover.
    const videoId = vidId();
    const preferred = recommendedQuality.videoId === videoId
      && manuallySelectedQualityVideoId !== videoId
      ? recommendedQuality.quality : null;
    return {
      quality, range, preferred, videoId, manualRevision: manualQualityRevision,
    };
  }
  async function restoreQuality(snapshot) {
    const p = player();
    if (!p || !snapshot?.quality) return false;
    // Do not overwrite a quality selected by the user while the download was
    // running, and never apply an old video's quality after navigation.
    const snapshotIsCurrent = () => (
      snapshot.videoId === vidId()
      && snapshot.manualRevision === manualQualityRevision
    );
    if (!snapshotIsCurrent()) return false;
    // Raise to the recommended default when the snapshot caught something
    // lower; never lower, so a deliberately modest choice is left alone.
    const desiredQuality = qualityRank(snapshot.preferred) > qualityRank(snapshot.quality)
      ? snapshot.preferred : snapshot.quality;
    const applyOriginalRange = () => {
      if (Array.isArray(snapshot.range) && snapshot.range.length >= 2) {
        p.setPlaybackQualityRange?.(snapshot.range[0], snapshot.range[1]);
      } else if (snapshot.range && typeof snapshot.range === 'object') {
        const min = snapshot.range.min || snapshot.range.minQuality;
        const max = snapshot.range.max || snapshot.range.maxQuality;
        if (min && max) p.setPlaybackQualityRange?.(min, max);
        else p.setPlaybackQualityRange?.('tiny', 'highres');
      } else {
        p.setPlaybackQualityRange?.('tiny', 'highres');
      }
    };
    const pinDesiredQuality = () => {
      p.setPlaybackQualityRange?.(desiredQuality, desiredQuality);
      p.setPlaybackQuality?.(desiredQuality);
    };

    try {
      // A single setPlaybackQuality call is only a recommendation and is often
      // ignored immediately after the MP3 MSE pass pinned the lowest quality.
      // Pin the old level temporarily, verify the actual player state, and only
      // then restore the user's original range/auto policy.
      pinDesiredQuality();
      for (let attempt = 0; attempt < 30; attempt++) {
        if (!snapshotIsCurrent()) return false;
        if (p.getPlaybackQuality?.() === desiredQuality) {
          await sleep(250);
          if (!snapshotIsCurrent()) return false;
          applyOriginalRange();
          p.setPlaybackQuality?.(desiredQuality);
          log('quality', 'restored after download; quality=', desiredQuality);
          return true;
        }
        if (attempt > 0 && attempt % 5 === 0) pinDesiredQuality();
        await sleep(100);
      }
      applyOriginalRange();
      p.setPlaybackQuality?.(desiredQuality);
      log('quality', 'restore command sent after verification timeout; quality=', desiredQuality,
        'current=', p.getPlaybackQuality?.());
      return false;
    } catch (error) {
      log('quality', 'could not restore quality:', error?.message || error);
      return false;
    }
  }
  function availableHeights() {
    try {
      return (player().getAvailableQualityLevels() || []).map((quality) => HEIGHT_BY_QUALITY[quality]).filter(Boolean);
    } catch (e) { return []; }
  }
  async function lowestAvailableHeight(timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const heights = availableHeights();
      if (heights.length) return Math.min(...heights);
      await sleep(100);
    } while (Date.now() < deadline);
    return null;
  }
  function currentQuality() {
    try {
      const quality = player().getPlaybackQuality?.();
      return HEIGHT_BY_QUALITY[quality] || null;
    } catch (e) { return null; }
  }
  function monitorDefaultHeight() {
    const ratio = Number(window.devicePixelRatio) || 1;
    const shortEdge = Math.min(Number(screen.width) || 0, Number(screen.height) || 0) * ratio;
    if (shortEdge >= 2160) return 2160;
    if (shortEdge >= 1440) return 1440;
    if (shortEdge >= 1080) return 1080;
    if (shortEdge >= 720) return 720;
    return 480;
  }
  function scheduleDefaultQuality() {
    const videoId = vidId();
    if (!videoId || defaultQualityAppliedVideoId === videoId) return;
    let tries = 30;
    (function tick() {
      if (vidId() !== videoId || defaultQualityAppliedVideoId === videoId) return;
      if (manuallySelectedQualityVideoId === videoId) {
        defaultQualityAppliedVideoId = videoId;
        return;
      }
      const heights = availableHeights().sort((a, b) => b - a);
      if (!heights.length && tries-- > 0) { setTimeout(tick, 200); return; }
      const target = monitorDefaultHeight();
      const selected = heights.find((height) => height <= target) || heights[heights.length - 1];
      const quality = QUALITY_BY_HEIGHT[selected];
      defaultQualityAppliedVideoId = videoId;
      if (quality) {
        // A recommendation only: no quality range is pinned, and a later
        // selection in YouTube's own menu always wins.
        recommendedQuality = { videoId, quality };
        recommendQuality(quality);
        log('quality', 'default recommendation', selected + 'p', 'monitorShortEdge=', monitorDefaultHeight());
      }
    })();
  }
  function keepAutoplayOff() {
    try {
      const btn = document.querySelector('.ytp-autonav-toggle-button');
      if (!btn) return false;
      if (btn.getAttribute('aria-checked') === 'true') btn.click();
      return true;
    } catch (e) { return false; }
  }

  const waitForUpdateEnd = (sb, timeoutMs = 2500) => new Promise((resolve) => {
    if (!sb?.updating) { resolve(); return; }
    let timer;
    const done = () => {
      clearTimeout(timer);
      try { sb.removeEventListener('updateend', done); } catch (e) {}
      resolve();
    };
    try { sb.addEventListener('updateend', done, { once: true }); } catch (e) { resolve(); return; }
    timer = setTimeout(done, timeoutMs);
  });

  async function resetTrackBufferForCapture(kind, currentVideoOnly = true) {
    let cleared = false;
    // Worker-hosted buffers answer only to messages; ask them first.
    if (store.workerTransports[kind]?.size) {
      const media = video();
      const span = (Number(media?.duration) || 0) + 5 || 86_400;
      cleared = await removeWorkerTrackRange(kind, 0, span);
    }
    for (const sb of liveSourceBuffers(kind, currentVideoOnly)) {
      try {
        await waitForUpdateEnd(sb);
        if (!sb.buffered?.length) continue;
        sb.remove(sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1));
        await waitForUpdateEnd(sb);
        cleared = true;
      } catch (e) {
        log('capture', `could not reset ${kind} buffer:`, e?.message || e);
      }
    }
    if (cleared) {
      delete store.tracks[kind];
      delete store._pendingInit[kind];
      store.lastAppendAt[kind] = 0;
    }
    return cleared;
  }

  // Worker-side SourceBuffers can only be told to drop a range by message;
  // the acknowledgement tells us whether anything was actually removed.
  async function removeWorkerTrackRange(kind, startSeconds, endSeconds) {
    const transports = [...(store.workerTransports[kind] || [])];
    if (!transports.length) return false;
    const acksBefore = store.workerRemoveAcks;
    for (const transport of transports) {
      try { transport.__novaRequestRemove?.(Math.max(0, startSeconds), endSeconds); } catch (e) {}
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      await sleep(100);
      if (store.workerRemoveAcks > acksBefore) return true;
    }
    return false;
  }

  async function removeTrackRangeForCapture(kind, startSeconds, endSeconds, currentVideoOnly = true) {
    let removed = await removeWorkerTrackRange(kind, startSeconds, endSeconds);
    for (const sourceBuffer of liveSourceBuffers(kind, currentVideoOnly)) {
      try {
        await waitForUpdateEnd(sourceBuffer);
        for (let index = sourceBuffer.buffered.length - 1; index >= 0; index--) {
          const start = Math.max(sourceBuffer.buffered.start(index), Math.max(0, startSeconds));
          const end = Math.min(sourceBuffer.buffered.end(index), endSeconds);
          if (start >= end || end <= 0) continue;
          sourceBuffer.remove(start, end);
          await waitForUpdateEnd(sourceBuffer);
          removed = true;
        }
      } catch (error) {
        log('capture', `could not remove ${kind} range:`, error?.message || error);
      }
    }
    return removed;
  }

  async function removeTrackPrefixForCapture(kind, endSeconds, currentVideoOnly = true) {
    return removeTrackRangeForCapture(kind, 0, endSeconds, currentVideoOnly);
  }

  // A Music track opened by the queue has never played, so ytmusic has not
  // built its MSE session yet: there are no SourceBuffers to observe and SABR
  // answers no paused seek. A short muted play from the start creates the
  // session (and its opening segments) without ever nearing the track end,
  // which is what makes ytmusic jump to the next item.
  // On Music the audio representation follows the selected video tier: a low
  // tier is served Opus 250 (~70 kbit/s) while 720p and above get 251
  // (~150 kbit/s). Asking for a high tier before the URLs are observed is what
  // makes "Оригинал" actually mean the best available audio.
  function requestBestMusicAudioTier() {
    if (!MUSIC_HOST) return;
    try {
      const heights = availableHeights().sort((a, b) => a - b);
      const target = heights.find((height) => height >= 720) || heights[heights.length - 1];
      const quality = QUALITY_BY_HEIGHT[target];
      if (!quality) return;
      if (currentQuality() >= 720) return;
      setQualityRaw(quality);
      log('capture', 'requested high tier for best Music audio; height=', target);
    } catch (e) {}
  }

  // The URL of the better representation only becomes known once the player
  // has actually requested it, so wait for one after raising the tier.
  const MUSIC_GOOD_AUDIO_KBPS = 100;

  async function ensureBestMusicAudioObserved(durationSeconds) {
    if (!MUSIC_HOST || !(durationSeconds > 0)) return;
    const kbpsOf = (format) => {
      const length = Number(format?.contentLength) || 0;
      return length ? (length * 8) / durationSeconds / 1000 : 0;
    };
    // URLs published in the player response always answer 403 on Music, so a
    // usable candidate must be one the player itself has requested.
    const usable = (format) => Boolean(format)
      && format._novaSource !== 'player-response'
      && kbpsOf(format) >= MUSIC_GOOD_AUDIO_KBPS;
    if (usable(selectDirectAudioFormat())) return;
    await primeMusicMediaSession(video(), durationSeconds, { force: true });
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const candidate = selectDirectAudioFormat();
      if (usable(candidate)) {
        log('direct-audio', 'best Music audio observed; itag=', candidate.itag || '?',
          'kbps=', Math.round(kbpsOf(candidate)));
        return;
      }
      await sleep(300);
    }
    const fallbackCandidate = selectDirectAudioFormat();
    log('direct-audio', 'no observed high-bitrate audio; continuing with',
      fallbackCandidate?._novaSource || 'none', Math.round(kbpsOf(fallbackCandidate)), 'kbps');
  }

  async function primeMusicMediaSession(media, capEnd, options = {}) {
    if (!MUSIC_HOST || !media) return false;
    const duration = Number(media.duration) || capEnd || 0;
    if (duration > 0 && duration < 8) return false;
    const hadBuffers = liveSourceBuffers('audio', false).length
      || store.workerTransports.audio.size;
    if (hadBuffers && !options.force) return false;
    const appendsBefore = store.lastAppendAt.audio || 0;
    log('capture', 'priming music media session with a short muted play');
    return withDeliberatePlayback(async () => {
      try { media.muted = true; } catch (e) {}
      try { media.currentTime = 0; } catch (e) {}
      try { await playWithTimeout(media, 3_000); } catch (e) {}
      const deadline = Date.now() + 4_000;
      let primed = false;
      while (Date.now() < deadline) {
        await sleep(200);
        throwIfDownloadCancelled();
        if ((store.lastAppendAt.audio || 0) > appendsBefore
          || liveSourceBuffers('audio', false).length
          || store.workerTransports.audio.size) {
          primed = true;
          // Give the freshly created session a moment to append its init and
          // first media segments before the paused-seek pass takes over.
          await sleep(600);
          break;
        }
      }
      pauseForCapture(media);
      log('capture', 'music media session primed=', primed,
        'audioBuffers=', liveSourceBuffers('audio', false).length,
        'workerAudio=', store.workerTransports.audio.size);
      return primed;
    });
  }

  function adoptAttachedInitForCapture(kind, buffers, currentVideoId) {
    const withInit = buffers.filter((sb) => sb?.__novaLastInit?.bytes?.length);
    const current = withInit.filter((sb) => sb.__novaInitVideoId === currentVideoId);
    let selected = null;
    if (current.length) {
      selected = current.sort((a, b) => (b.__novaLastAppendAt || 0) - (a.__novaLastAppendAt || 0))[0];
    } else if (withInit.length === 1) {
      // A SourceBuffer may survive a YouTube SPA navigation without receiving
      // another init segment. If there is exactly one transport for this kind,
      // its last init is still the decoder configuration used by that buffer.
      selected = withInit[0];
    } else if (withInit.length > 1) {
      // A navigation can leave the previous session's transport registered
      // beside the live one. Giving up here cost a whole download: with two
      // buffers per kind and neither tagged for this video, the capture started
      // with no init at all, every primer observed nothing, and the pass ended
      // in a page reload. The transport that received bytes most recently is
      // the live one — but only trust that when the timestamps actually differ.
      const ranked = withInit
        .filter((sourceBuffer) => Number(sourceBuffer.__novaLastAppendAt) > 0)
        .sort((left, right) => right.__novaLastAppendAt - left.__novaLastAppendAt);
      if (ranked.length === 1
        || (ranked.length > 1 && ranked[0].__novaLastAppendAt > ranked[1].__novaLastAppendAt)) {
        selected = ranked[0];
      }
    }
    if (!selected) {
      log('capture', 'no adoptable init; kind=', kind, 'buffers=', buffers.length,
        'withInit=', withInit.length);
      return false;
    }
    const init = selected.__novaLastInit;
    store._lastInit[kind] = {
      bytes: init.bytes,
      mime: init.mime || selected.__novaMime || '',
      height: kind === 'video' ? (currentQuality() || init.height || null) : null,
      initKey: init.initKey || fragmentFingerprint(init.bytes),
    };
    selected.__novaInitVideoId = currentVideoId;
    log('capture', 'adopted attached init; kind=', kind, 'reusedAcrossNavigation=', current.length === 0);
    return true;
  }

  function withoutTransientMediaParams(rawUrl) {
    const hashAt = rawUrl.indexOf('#');
    const withoutHash = hashAt >= 0 ? rawUrl.slice(0, hashAt) : rawUrl;
    const queryAt = withoutHash.indexOf('?');
    if (queryAt < 0) return withoutHash;
    const kept = withoutHash.slice(queryAt + 1).split('&').filter((field) => {
      let name = field.split('=', 1)[0];
      try { name = decodeURIComponent(name); } catch (e) {}
      return name !== 'range' && name !== 'rn' && name !== 'rbuf';
    });
    return `${withoutHash.slice(0, queryAt)}?${kept.join('&')}`;
  }

  function directUrlIsUsable(rawUrl) {
    const normalized = withoutTransientMediaParams(String(rawUrl || ''));
    if (!normalized || store.invalidDirectUrls.has(normalized)) return false;
    try {
      const expiresAt = Number(new URL(normalized).searchParams.get('expire')) * 1000;
      // Do not start a large download with a signature about to expire.
      if (expiresAt > 0 && expiresAt <= Date.now() + 30_000) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  function invalidateDirectUrl(rawUrl) {
    const normalized = withoutTransientMediaParams(String(rawUrl || ''));
    if (!normalized) return;
    store.invalidDirectUrls.add(normalized);
    for (const kind of ['audio', 'video']) {
      store.observedMediaFormats[kind] = store.observedMediaFormats[kind]
        .filter((format) => format.url !== normalized);
    }
  }

  function observedDirectAudioFormat() {
    // Best quality first (a track can be observed in several representations
    // as the player switches bitrate); URLs that stop serving data are retired
    // by the downloader, so the next call falls through to the lesser one.
    const intercepted = store.observedMediaFormats.audio
      .filter((format) => format.videoId === vidId() && directUrlIsUsable(format.url))
      .sort((left, right) => (Number(right.contentLength) || 0) - (Number(left.contentLength) || 0)
        || right.observedAt - left.observedAt)[0];
    if (intercepted) return { ...intercepted };
    if (vidId() !== store.videoId) return null;
    let entries;
    try { entries = performance.getEntriesByType('resource'); } catch (e) { return null; }
    if (!Array.isArray(entries) || !entries.length) return null;
    for (let index = entries.length - 1; index >= 0; index--) {
      try {
        if (Number(entries[index].startTime) < store.mediaEpochStart) continue;
        const url = new URL(entries[index].name);
        if (url.protocol !== 'https:'
          || (url.hostname !== 'googlevideo.com' && !url.hostname.endsWith('.googlevideo.com'))) continue;
        if (!directUrlIsUsable(entries[index].name)) continue;
        const mime = url.searchParams.get('mime') || '';
        const itag = url.searchParams.get('itag') || '';
        if (!/^audio\//i.test(mime) && !AUDIO_ITAGS.has(itag)) continue;

        // Preserve the exact encoding/order of every signed parameter. Mutating
        // URL.searchParams can reserialize values and invalidate the signature.
        return {
          url: withoutTransientMediaParams(entries[index].name),
          itag,
          mimeType: mime || 'application/octet-stream',
          contentLength: 0,
          approxDurationMs: Number(video()?.duration) > 0 ? Math.round(video().duration * 1000) : 0,
          _novaSource: 'resource-timing',
        };
      } catch (e) {}
    }
    return null;
  }

  // ---- InnerTube fallback for direct URLs ---------------------------------
  // The web player has moved to SABR: streamingData now carries adaptiveFormats
  // with neither `url` nor `signatureCipher`, just a single
  // serverAbrStreamingUrl, and every media request is a POST to
  // /videoplayback?sabr=1 whose query has no itag or mime. Both of Nova's
  // direct-URL sources — the player response and observed player requests —
  // therefore find nothing on an ordinary watch page, and each download
  // degraded to the real-time MSE capture (minutes for a long video).
  //
  // The mobile player API still answers with plain, range-fetchable URLs that
  // carry no throttling `n` parameter and stay valid for hours. The request is
  // deliberately sent WITHOUT cookies: pairing a mobile client with the
  // signed-in session is what trips YouTube's bot checks. The cost is that
  // age-restricted and members-only videos keep falling through to the MSE
  // capture exactly as they do today.
  const INNERTUBE_CLIENTS = [
    { label: 'ios', client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2' } },
    { label: 'ios-tablet', client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPad14,3' } },
    { label: 'android-vr', client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceModel: 'Quest 3', androidSdkVersion: 32 } },
  ];
  // Never begin a long download on a signature that is about to lapse.
  const INNERTUBE_SAFETY_MS = 60_000;
  const INNERTUBE_INFLIGHT_MS = 5 * 60_000;
  const INNERTUBE_FAILURE_MS = 60_000;
  // A URL googlevideo refuses is a property of the environment, not of the
  // video: with a split tunnel (VPN/DPI bypass covering googlevideo.com but
  // not youtube.com) the signature is issued to one address and presented from
  // another, and every video in the session will be refused the same way.
  // Stop paying an API call plus a doomed request for each of them.
  const INNERTUBE_REFUSAL_LIMIT = 2;
  const INNERTUBE_COOLDOWN_MS = 30 * 60_000;

  function innertubeApiKey() {
    try {
      const key = window.ytcfg?.data_?.INNERTUBE_API_KEY;
      if (typeof key === 'string' && /^[\w-]{20,}$/.test(key)) return key;
    } catch (e) {}
    return '';
  }

  function normalizeInnertubeFormats(payload, videoId) {
    if (payload?.videoDetails?.videoId && payload.videoDetails.videoId !== videoId) return [];
    const source = payload?.streamingData?.adaptiveFormats;
    if (!Array.isArray(source)) return [];
    return source
      .filter((format) => typeof format?.url === 'string'
        && /^(?:audio|video)\//i.test(format.mimeType || ''))
      .map((format) => ({
        url: withoutTransientMediaParams(format.url),
        itag: String(format.itag || ''),
        mimeType: format.mimeType || '',
        contentLength: Number(format.contentLength) || 0,
        approxDurationMs: Number(format.approxDurationMs) || 0,
        height: formatQualityHeight(format) || null,
        bitrate: Number(format.bitrate) || 0,
        audioQuality: format.audioQuality || '',
        audioTrack: format.audioTrack || null,
        isDrc: Boolean(format.isDrc),
        _novaSource: 'innertube',
      }))
      .filter((format) => directUrlIsUsable(format.url));
  }

  async function requestInnertubeFormats(videoId) {
    const key = innertubeApiKey();
    if (!key) throw new Error('ключ InnerTube API недоступен');
    let lastError = null;
    for (const candidate of INNERTUBE_CLIENTS) {
      try {
        // Deliberately the unhooked fetch: this request is Nova's own and has
        // no business passing through the page-observation wrapper.
        const response = await (OrigFetch || fetch)(
          `${location.origin}/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`,
          {
            method: 'POST',
            credentials: 'omit',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              videoId,
              context: { client: { hl: 'en', gl: 'US', ...candidate.client } },
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const formats = normalizeInnertubeFormats(payload, videoId);
        if (!formats.length) {
          const status = payload?.playabilityStatus?.status || 'без форматов';
          const reason = payload?.playabilityStatus?.reason || '';
          throw new Error(reason ? `${status}: ${reason}` : status);
        }
        const lifetimeSeconds = Number(payload?.streamingData?.expiresInSeconds) || 0;
        const heights = [...new Set(formats.filter((format) => format.height)
          .map((format) => format.height))].sort((left, right) => right - left);
        log('direct-url', 'innertube formats; client=', candidate.label,
          'count=', formats.length, 'heights=', heights.join(',') || 'none');
        return {
          formats,
          expiresAt: Date.now()
            + (lifetimeSeconds > 0 ? lifetimeSeconds * 1000 : 30 * 60_000) - INNERTUBE_SAFETY_MS,
        };
      } catch (error) {
        lastError = error;
        log('direct-url', 'innertube client', candidate.label, 'failed:',
          String(error?.message || error));
      }
    }
    throw lastError || new Error('InnerTube не вернул форматы');
  }

  // One request per video, shared by the video and audio halves of a download
  // and negatively cached for a minute so a blocked video does not re-ask.
  function ensureInnertubeFormats(videoId) {
    const cache = store.innertubeFormats;
    if (cache && cache.videoId === videoId && cache.expiresAt > Date.now()) {
      return cache.promise || Promise.resolve(cache.formats);
    }
    if (!videoId || Date.now() < store.innertubeBlockedUntil) return Promise.resolve([]);
    const entry = {
      videoId, formats: [], expiresAt: Date.now() + INNERTUBE_INFLIGHT_MS, promise: null,
    };
    entry.promise = requestInnertubeFormats(videoId)
      .then((result) => {
        entry.formats = result.formats;
        entry.expiresAt = result.expiresAt;
        return entry.formats;
      })
      .catch((error) => {
        entry.formats = [];
        entry.expiresAt = Date.now() + INNERTUBE_FAILURE_MS;
        entry.error = String(error?.message || error);
        return [];
      })
      .finally(() => { entry.promise = null; });
    store.innertubeFormats = entry;
    return entry.promise;
  }

  // Every URL in one InnerTube response is signed the same way, so a refusal of
  // the first one condemns the rest. Park the set as an empty negative-cache
  // entry: further candidates resolve to nothing instead of re-asking the API.
  function dropInnertubeFormats() {
    const cache = store.innertubeFormats;
    if (cache) {
      cache.formats = [];
      cache.expiresAt = Date.now() + INNERTUBE_FAILURE_MS;
    }
    store.innertubeRefusals += 1;
    log('direct-url', 'innertube formats discarded after a refused signature; refusals=',
      store.innertubeRefusals);
    if (store.innertubeRefusals < INNERTUBE_REFUSAL_LIMIT) return;
    store.innertubeBlockedUntil = Date.now() + INNERTUBE_COOLDOWN_MS;
    log('direct-url', 'fast direct downloads disabled for',
      Math.round(INNERTUBE_COOLDOWN_MS / 60_000), 'min: googlevideo refuses the signed URLs.',
      'Usual cause: a VPN/DPI bypass that routes googlevideo.com differently from youtube.com,',
      'so the signature is issued to one address and presented from another.');
  }

  function noteInnertubeSuccess(format) {
    if (format?._novaSource !== 'innertube' || !store.innertubeRefusals) return;
    store.innertubeRefusals = 0;
    store.innertubeBlockedUntil = 0;
  }

  // fetch() reports a rejected connection as a bare TypeError: no status, no
  // headers. Told apart from a slow or truncated transfer, it means the request
  // never reached a server willing to answer it.
  function isNetworkRefusal(error) {
    return /failed to fetch|networkerror|load failed|network error/i
      .test(String(error?.message || error));
  }

  // The parameters googlevideo signs over. A mismatch between the address that
  // asked for the URL and the one that fetches it (split tunnel, proxy, DPI
  // bypass) is the usual reason a perfectly fresh URL answers 403.
  function directUrlDiagnostics(rawUrl) {
    try {
      const params = new URL(rawUrl).searchParams;
      const expiresIn = Math.round((Number(params.get('expire')) * 1000 - Date.now()) / 1000);
      return `client=${params.get('c') || '?'} itag=${params.get('itag') || '?'}`
        + ` signedForIp=${params.get('ip') || '?'} expiresInSec=${Number.isFinite(expiresIn) ? expiresIn : '?'}`
        + ` hasPot=${params.has('pot')}`;
    } catch (e) { return 'diagnostics unavailable'; }
  }

  function innertubeFormatsFor(videoId) {
    const cache = store.innertubeFormats;
    if (!cache || cache.videoId !== videoId || !Array.isArray(cache.formats)) return [];
    return cache.formats.filter((format) => directUrlIsUsable(format.url));
  }

  function selectInnertubeAudioFormat() {
    const candidates = innertubeFormatsFor(vidId())
      .filter((format) => /^audio\//i.test(format.mimeType));
    if (!candidates.length) return null;
    const score = (format) => ((format.audioTrack?.audioIsDefault === false ? 0 : 1) * 1e12)
      + (format.isDrc ? 0 : 1e8) + format.bitrate;
    return { ...candidates.sort((left, right) => score(right) - score(left))[0] };
  }

  // Exact height first; among equals prefer H.264, which the muxer stream-copies
  // into MP4 while AV1 would force a slow re-encode. The mobile ladder is
  // AV1-only above 1080p and can omit a rung entirely, so an unavailable height
  // steps down to the closest one below it instead of dropping to a 1x capture.
  function selectInnertubeVideoFormat(requestedHeight) {
    const candidates = innertubeFormatsFor(vidId())
      .filter((format) => /^video\//i.test(format.mimeType) && format.height > 0);
    if (!candidates.length) return null;
    const score = (format) => (/avc1|h264/i.test(format.mimeType) ? 1e12 : 0) + format.bitrate;
    const exact = candidates.filter((format) => format.height === requestedHeight)
      .sort((left, right) => score(right) - score(left))[0];
    if (exact) return { ...exact };
    const lower = candidates.filter((format) => format.height < requestedHeight)
      .sort((left, right) => (right.height - left.height) || (score(right) - score(left)))[0];
    if (lower) return { ...lower };
    const higher = candidates
      .sort((left, right) => (left.height - right.height) || (score(right) - score(left)))[0];
    return higher ? { ...higher } : null;
  }

  function selectDirectAudioFormat() {
    const formats = playerResponse()?.streamingData?.adaptiveFormats;
    const audioQuality = { AUDIO_QUALITY_LOW: 1, AUDIO_QUALITY_MEDIUM: 2, AUDIO_QUALITY_HIGH: 3 };
    const selected = (Array.isArray(formats) ? formats : [])
      .filter((format) => /^audio\//i.test(format?.mimeType || '') && typeof format.url === 'string')
      .filter((format) => {
        try {
          const url = new URL(format.url);
          return url.protocol === 'https:'
            && (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
            && directUrlIsUsable(format.url);
        } catch (e) { return false; }
      })
      .sort((left, right) => {
        const score = (format) => ((format.audioTrack?.audioIsDefault === false ? 0 : 1) * 1e12)
          + ((audioQuality[format.audioQuality] || 0) * 1e9)
          + (format.isDrc ? 0 : 1e8)
          + (Number(format.bitrate) || 0);
        return score(right) - score(left);
      })[0] || null;
    // On music.youtube the URLs published in the player response answer 403;
    // only the ones the player itself has already used are signed acceptably.
    const observed = observedDirectAudioFormat();
    if (MUSIC_HOST && observed) return observed;
    if (selected) {
      return { ...selected, url: withoutTransientMediaParams(selected.url), _novaSource: 'player-response' };
    }
    // InnerTube last: on Music an observed URL is Opus, which beats the mobile
    // ladder's AAC. It only fills the hole SABR left on ordinary watch pages.
    return observed || selectInnertubeAudioFormat();
  }

  function selectDirectVideoFormat(height) {
    const requestedHeight = Number(height) || 0;
    const formats = playerResponse()?.streamingData?.adaptiveFormats;
    const selected = (Array.isArray(formats) ? formats : [])
      .filter((format) => /^video\//i.test(format?.mimeType || '')
        && typeof format.url === 'string' && formatQualityHeight(format) === requestedHeight)
      .filter((format) => {
        try {
          const url = new URL(format.url);
          return url.protocol === 'https:'
            && (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
            && directUrlIsUsable(format.url);
        } catch (e) { return false; }
      })
      .sort((left, right) => (Number(right.bitrate) || 0) - (Number(left.bitrate) || 0))[0];
    if (selected) {
      return {
        ...selected,
        url: withoutTransientMediaParams(selected.url),
        _novaSource: 'player-response',
      };
    }
    const intercepted = store.observedMediaFormats.video
      .filter((format) => format.videoId === vidId()
        && Number(format.height) === requestedHeight
        && directUrlIsUsable(format.url))
      .sort((left, right) => right.observedAt - left.observedAt)
      .map((format) => ({ ...format }))[0];
    if (intercepted) return intercepted;
    let entries;
    try { entries = performance.getEntriesByType('resource'); } catch (e) { return null; }
    for (let index = entries.length - 1; index >= 0; index--) {
      try {
        if (Number(entries[index].startTime) < store.mediaEpochStart) continue;
        const url = new URL(entries[index].name);
        if (url.protocol !== 'https:'
          || (url.hostname !== 'googlevideo.com' && !url.hostname.endsWith('.googlevideo.com'))) continue;
        if (!directUrlIsUsable(entries[index].name)) continue;
        const mimeType = url.searchParams.get('mime') || '';
        const itag = url.searchParams.get('itag') || '';
        if ((!/^video\//i.test(mimeType) && !VIDEO_ITAG_HEIGHT.has(itag))
          || VIDEO_ITAG_HEIGHT.get(itag) !== requestedHeight) continue;
        return {
          url: withoutTransientMediaParams(entries[index].name),
          itag,
          mimeType,
          contentLength: Number(url.searchParams.get('clen')) || 0,
          approxDurationMs: (Number(url.searchParams.get('dur')) || Number(video()?.duration) || 0) * 1000,
          height: requestedHeight,
          _novaSource: 'resource-timing',
        };
      } catch (e) {}
    }
    return selectInnertubeVideoFormat(requestedHeight);
  }

  function cacheCompletedAudio(audio, duration) {
    const bytes = audio?.bytes;
    const captureRate = Number(audio?.captureRate) || 1;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 150_000_000
      || Math.abs(captureRate - 1) > 0.001) {
      store.completedAudioCache = null;
      return;
    }
    store.completedAudioCache = {
      videoId: vidId(),
      bytes: bytes.slice(),
      mime: audio.mime || 'application/octet-stream',
      // googlevideo's audio `dur` is sometimes several seconds shorter than the
      // actual player timeline. Keep the authoritative requested/player duration
      // so the next video can reuse this track and MP3 output is not truncated.
      duration: Number(duration) || Number(video()?.duration) || Number(audio.duration) || 0,
      cachedAt: Date.now(),
    };
    log('capture', 'cached completed MP3 source audio for next video; bytes=',
      bytes.length, 'duration=', store.completedAudioCache.duration);
  }

  function reusableCompletedAudio(expectedDuration) {
    const cached = store.completedAudioCache;
    if (!cached) return null;
    const requestedVideoId = vidId();
    const duration = Number(expectedDuration) || Number(video()?.duration) || 0;
    const durationTolerance = Math.max(1.5, duration * 0.005);
    const invalid = cached.videoId !== requestedVideoId
      || Date.now() - Number(cached.cachedAt) > 30 * 60_000
      || !(cached.bytes instanceof Uint8Array)
      || !cached.bytes.length
      || (duration > 0 && Number(cached.duration) > 0
        && Math.abs(Number(cached.duration) - duration) > durationTolerance);
    if (invalid) {
      store.completedAudioCache = null;
      store.mp3Isolation = null;
      return null;
    }
    return {
      bytes: cached.bytes.slice(),
      mime: cached.mime,
      duration: Number(cached.duration) || duration,
      captureRate: 1,
      _novaSource: 'completed-mp3-cache',
    };
  }

  // googlevideo throttles a single continuous stream to roughly playback speed
  // (music.youtube always, www often). Splitting the byte range across a few
  // concurrent requests — the same trick the player itself uses with its
  // `range=` parameter — is answered at full link speed.
  const PARALLEL_RANGE_PARTS = 8;
  // Small enough that even a short track is split: a single stream is
  // throttled to playback speed, so two slices already halve the wait.
  const PARALLEL_RANGE_MIN_BYTES = 128 * 1024;

  // Range requests made through the `range=` query parameter are answered in
  // googlevideo's UMP container: a sequence of (type, size, payload) parts
  // where the media bytes live in type 21, each payload prefixed by one
  // header-id byte. Concatenating those payloads reproduces the raw stream
  // byte for byte (verified against an unsplit download).
  function umpVarint(bytes, offset) {
    const first = bytes[offset];
    const size = first < 128 ? 1 : (first < 192 ? 2 : (first < 224 ? 3 : (first < 240 ? 4 : 5)));
    let value;
    if (size === 1) value = first;
    else if (size === 2) value = (first & 0x3f) | (bytes[offset + 1] << 6);
    else if (size === 3) value = (first & 0x1f) | (bytes[offset + 1] << 5) | (bytes[offset + 2] << 13);
    else if (size === 4) {
      value = (first & 0x0f) | (bytes[offset + 1] << 4) | (bytes[offset + 2] << 12)
        | (bytes[offset + 3] << 20);
    } else {
      value = bytes[offset + 1] | (bytes[offset + 2] << 8)
        | (bytes[offset + 3] << 16) | (bytes[offset + 4] << 24);
    }
    return [value >>> 0, size];
  }

  function extractUmpMedia(bytes) {
    const chunks = [];
    let offset = 0;
    while (offset < bytes.length) {
      const [type, typeSize] = umpVarint(bytes, offset);
      offset += typeSize;
      if (offset >= bytes.length) break;
      const [size, sizeSize] = umpVarint(bytes, offset);
      offset += sizeSize;
      if (offset + size > bytes.length) {
        // Truncated final part: keep the media bytes it did deliver.
        if (type === 21 && bytes.length - offset > 1) chunks.push(bytes.subarray(offset + 1));
        break;
      }
      if (type === 21 && size > 1) chunks.push(bytes.subarray(offset + 1, offset + size));
      offset += size;
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const media = new Uint8Array(total);
    let written = 0;
    for (const chunk of chunks) {
      media.set(chunk, written);
      written += chunk.length;
    }
    return media;
  }

  async function fetchDirectRangeSlice(url, start, end, logTag) {
    const wanted = end - start + 1;
    let lastError = null;
    // Slices run eight at a time. Once one of them has retired the URL there is
    // nothing left to learn: without this the siblings each repeated the page
    // fetch and the worker fetch, turning one refusal into sixteen round trips
    // and a visibly slow start.
    if (!directUrlIsUsable(url)) {
      const retired = new Error('ссылка уже отклонена сервером');
      retired.novaRetiredUrl = true;
      throw retired;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(200 * attempt);
      try {
        const response = await (OrigFetch || window.fetch.bind(window))(
          `${url}${url.includes('?') ? '&' : '?'}range=${start}-${end}`,
          { credentials: 'omit' },
        );
        if (!response.ok) {
          // googlevideo explains a refusal in a short plain-text body; without
          // it a 403 is indistinguishable from an expired signature.
          const reason = await response.text().then((text) => text.trim().slice(0, 160)).catch(() => '');
          const error = new Error(`HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
          error.novaHttpStatus = response.status;
          throw error;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error(`пустой ответ на диапазон ${start}-${end}`);
        const media = bytes.length === wanted ? bytes : extractUmpMedia(bytes);
        if (media.length < wanted) {
          throw new Error(`диапазон ${start}-${end}: получено ${media.length} из ${wanted} байт`);
        }
        if (attempt) log(logTag, 'range recovered on retry', attempt + 1, `${start}-${end}`);
        return media.length > wanted ? media.subarray(0, wanted) : media;
      } catch (error) {
        lastError = error;
        const refused = error?.novaHttpStatus === 401 || error?.novaHttpStatus === 403
          || error?.novaHttpStatus === 410 || isNetworkRefusal(error);
        if (!refused) continue;
        // Retire the URL so the sibling slices stop repeating the same failure.
        invalidateDirectUrl(url);
        break;
      }
    }
    throw lastError || new Error(`диапазон ${start}-${end} не получен`);
  }

  async function fetchDirectRangesInParallel(url, totalLength, onProgress, logTag, maxParts) {
    const parts = Math.min(maxParts || PARALLEL_RANGE_PARTS,
      Math.max(2, Math.floor(totalLength / PARALLEL_RANGE_MIN_BYTES)));
    const chunkSize = Math.ceil(totalLength / parts);
    const buffers = new Array(parts).fill(null);
    let received = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: parts }, async (_, index) => {
      const start = index * chunkSize;
      const end = Math.min(totalLength - 1, start + chunkSize - 1);
      if (start > end) {
        buffers[index] = new Uint8Array(0);
        return;
      }
      buffers[index] = await fetchDirectRangeSlice(url, start, end, logTag);
      received += buffers[index].length;
      onProgress(Math.min(0.99, received / totalLength));
    }));
    const assembled = new Uint8Array(buffers.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of buffers) {
      assembled.set(part, offset);
      offset += part.length;
    }
    // The server may hand back a couple of bytes more than clen announced.
    if (assembled.length < totalLength) {
      throw new Error(`параллельная загрузка вернула ${assembled.length} из ${totalLength} байт`);
    }
    log(logTag, 'parallel range download complete; parts=', parts, 'bytes=', assembled.length,
      'seconds=', ((Date.now() - started) / 1000).toFixed(1));
    return assembled;
  }

  async function fetchDirectAudio(onProgress, suppliedFormat = null, mediaKind = 'audio') {
    const requestedVideoId = vidId();
    let format = suppliedFormat || selectDirectAudioFormat();
    if (!format && !suppliedFormat) {
      // Nothing signed is on hand: ask the mobile player API before conceding
      // the download to the real-time capture.
      await ensureInnertubeFormats(requestedVideoId);
      format = selectDirectAudioFormat();
    }
    if (!format) throw new Error(`YouTube не предоставил прямой URL ${mediaKind === 'video' ? 'видео' : 'аудио'}дорожки`);

    const directLogTag = mediaKind === 'video' ? 'direct-video' : 'direct-audio';
    const declaredLength = Number(format.contentLength) || 0;
    const durationSeconds = (Number(format.approxDurationMs) || 0) / 1000;
    const fetchStartedAt = Date.now();
    const parts = [];
    let received = 0;
    let expectedLength = declaredLength;
    let responseMime = format.mimeType || 'application/octet-stream';
    let lastError = null;
    let reportedProgress = 0;
    const maxAttempts = 4;
    const reportProgress = (value) => {
      reportedProgress = Math.max(reportedProgress, Math.max(0, Math.min(1, Number(value) || 0)));
      onProgress(reportedProgress);
    };

    log(directLogTag, JSON.stringify({
      itag: format.itag || null,
      mime: format.mimeType || '',
      bitrate: Number(format.bitrate) || 0,
      contentLength: declaredLength || null,
      source: format._novaSource || 'player-response',
      resumable: true,
    }));
    reportProgress(0.01);

    if (declaredLength > PARALLEL_RANGE_MIN_BYTES * 2) {
      try {
        let assembled = null;
        let parallelError = null;
        // Fewer, larger slices on retry: a rejected slice is usually the
        // server pushing back on concurrency, not a broken URL.
        for (const maxParts of [PARALLEL_RANGE_PARTS, 4, 2]) {
          try {
            assembled = await fetchDirectRangesInParallel(
              format.url, declaredLength, reportProgress, directLogTag, maxParts);
            break;
          } catch (error) {
            parallelError = error;
            if (error?.novaFatal || error?.novaHttpStatus === 401
              || error?.novaHttpStatus === 403 || error?.novaHttpStatus === 410) throw error;
            log(directLogTag, 'parallel range attempt failed with', maxParts, 'parts:',
              String(error?.message || error));
            // A connection refused at the network layer (CORS rejection, reset
            // by a tunnel) is not concurrency pushback: retrying with fewer,
            // larger slices only repeats it nine more times.
            if (isNetworkRefusal(error)) break;
          }
        }
        if (!assembled) {
          // Empty replies for every slice mean this URL no longer serves the
          // track (the player has since switched to another representation).
          // Retire it and let the caller retry with the next observed URL
          // instead of grinding through the throttled sequential path.
          invalidateDirectUrl(format.url);
          const retired = parallelError || new Error('параллельная загрузка не удалась');
          retired.novaRetiredUrl = true;
          log(directLogTag, 'direct URL retired (no data);', directUrlDiagnostics(format.url));
          if (format._novaSource === 'innertube') dropInnertubeFormats();
          throw retired;
        }
        if (vidId() !== requestedVideoId) {
          const navigationError = new Error('страница YouTube перешла к другому видео во время загрузки');
          navigationError.novaFatal = true;
          throw navigationError;
        }
        reportProgress(1);
        noteInnertubeSuccess(format);
        return {
          bytes: assembled,
          mime: responseMime,
          duration: (Number(format.approxDurationMs) || 0) / 1000,
          captureRate: 1,
          _novaSource: `${format._novaSource || 'player-response'}+parallel`,
        };
      } catch (error) {
        if (error?.novaFatal || error?.novaRetiredUrl) throw error;
        if (error?.novaHttpStatus === 403 || error?.novaHttpStatus === 401
          || error?.novaHttpStatus === 410) {
          // The signature is refused, not merely unlucky: the sequential path
          // would spend four more attempts on the very same URL. Retire it,
          // record why, and let the caller move on.
          invalidateDirectUrl(format.url);
          log(directLogTag, 'direct URL refused;', String(error?.message || error),
            directUrlDiagnostics(format.url));
          if (format._novaSource === 'innertube') dropInnertubeFormats();
          error.novaRetiredUrl = true;
          throw error;
        }
        log(directLogTag, 'parallel range download unavailable; falling back to stream:',
          String(error?.message || error));
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptStart = received;
      const controller = new AbortController();
      let idleTimer;
      let stalled = false;
      const armIdleWatchdog = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, 20_000);
      };
      try {
        const headers = received > 0 ? { Range: `bytes=${received}-` } : {};
        armIdleWatchdog();
        // Bypass our observation wrapper: a failed Nova request must not make
        // its own stale signed URL appear newly observed.
        const response = await (OrigFetch || window.fetch.bind(window))(format.url, {
          credentials: 'omit',
          headers,
          signal: controller.signal,
        });
        if (!response.ok || (response.status !== 200 && response.status !== 206)) {
          const httpError = new Error(`HTTP ${response.status}`);
          httpError.novaHttpStatus = response.status;
          if (response.status === 401 || response.status === 403 || response.status === 410) {
            invalidateDirectUrl(format.url);
            httpError.novaStaleDirectUrl = true;
          }
          throw httpError;
        }
        if (!response.body) throw new Error('пустой поток ответа');

        const contentRange = response.headers.get('content-range') || '';
        const rangeMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
        const rangeStart = rangeMatch ? Number(rangeMatch[1]) : 0;
        const rangeEnd = rangeMatch ? Number(rangeMatch[2]) : 0;
        const rangeTotal = rangeMatch && rangeMatch[3] !== '*' ? Number(rangeMatch[3]) : 0;
        if (received > 0 && (response.status !== 206 || !rangeMatch || rangeStart !== received)) {
          throw new Error(`сервер не продолжил загрузку с байта ${received}`);
        }
        if (received === 0 && rangeStart !== 0) {
          throw new Error(`поток начался с байта ${rangeStart}, а не с нуля`);
        }
        const responseLength = Number(response.headers.get('content-length')) || 0;
        // The server's own totals are authoritative. A clen observed from
        // request URLs can undercount by a few bytes, which used to strand
        // the download resuming from a byte past the end of the file.
        const serverTotal = rangeTotal
          || (response.status === 200 && responseLength ? responseLength : 0);
        if (serverTotal) {
          if (expectedLength && serverTotal !== expectedLength) {
            log(directLogTag, 'declared size corrected by server; declared=',
              expectedLength, 'server=', serverTotal);
          }
          expectedLength = serverTotal;
        } else if (!expectedLength) {
          expectedLength = rangeMatch ? rangeEnd + 1 : responseLength;
        }
        responseMime = format.mimeType || response.headers.get('content-type') || responseMime;

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          if (vidId() !== requestedVideoId) {
            controller.abort();
            const navigationError = new Error('страница YouTube перешла к другому видео во время загрузки');
            navigationError.novaFatal = true;
            throw navigationError;
          }
          armIdleWatchdog();
          parts.push(value);
          received += value.length;
          if (received > 750_000_000) throw new Error('медиадорожка превышает безопасный лимит памяти');
          // Some endpoints (notably music.youtube) throttle direct URLs to
          // roughly playback speed. Bailing out to the MSE capture is far
          // faster than finishing a 1x download here — but only for tracks
          // big enough for the wait to matter; a small file finishes in
          // seconds even throttled, and the capture path is slower than that.
          if (durationSeconds > 0 && expectedLength > 4 * 1024 * 1024) {
            const elapsedSeconds = (Date.now() - fetchStartedAt) / 1000;
            if (elapsedSeconds > 8) {
              const speedFactor = (received / elapsedSeconds) / (expectedLength / durationSeconds);
              if (speedFactor < 2.5) {
                controller.abort();
                const throttled = new Error(
                  `сервер отдаёт прямой поток со скоростью воспроизведения (${speedFactor.toFixed(1)}x)`);
                throttled.novaDirectThrottled = true;
                throw throttled;
              }
            }
          }
          if (expectedLength && received > expectedLength) {
            // The declared size undercounted and the server offered no total:
            // the real size is unknown, so read to EOF and accept the stream.
            log(directLogTag, 'declared size exceeded; reading to end of stream; declared=',
              expectedLength, 'received=', received);
            expectedLength = 0;
          }
          reportProgress(expectedLength ? Math.min(0.99, received / expectedLength) : 0.01);
          if (expectedLength && received === expectedLength) {
            // googlevideo may keep an HTTP stream open after delivering every
            // byte declared by clen/Content-Range. Do not wait at 99% for EOF.
            try { reader.cancel().catch(() => {}); } catch (e) {}
            break;
          }
        }

        if (!expectedLength || received === expectedLength) {
          lastError = null;
          break;
        }
        lastError = new Error(`поток завершился раньше (${received} из ${expectedLength} байт)`);
      } catch (error) {
        if (error?.novaFatal) throw error;
        if (error?.novaDirectThrottled) {
          // Deliberate switch to the MSE path: skip the resume loop and never
          // mark the error novaNoFallback despite the partial data.
          log(directLogTag, 'throttled by server; falling back to MSE;',
            'received=', received, 'reason=', error.message);
          throw error;
        }
        lastError = stalled
          ? new Error(`нет данных более 20 секунд после байта ${received}`)
          : error;
      } finally {
        clearTimeout(idleTimer);
      }

      if (!lastError) break;
      if (lastError.novaStaleDirectUrl) break;
      // Not a byte arrived and the connection itself was refused: three more
      // identical attempts cannot end differently.
      if (received === attemptStart && isNetworkRefusal(lastError)) {
        invalidateDirectUrl(format.url);
        log(directLogTag, 'direct URL refused at the network layer;',
          directUrlDiagnostics(format.url));
        if (format._novaSource === 'innertube') dropInnertubeFormats();
        lastError.novaRetiredUrl = true;
        break;
      }
      if (received === attemptStart && attempt + 1 >= maxAttempts) break;
      log(directLogTag, 'resume; attempt=', attempt + 2, 'from=', received,
        'expected=', expectedLength || null, 'reason=', lastError.message);
      await sleep(350 * (attempt + 1));
    }

    if (lastError) {
      // A substantially received signed track has already selected the
      // reliable network path: do not discard it for a real-time 1x capture.
      // A stream that died in its first bytes proves nothing, so there the
      // MSE capture must still get its chance.
      const meaningfulProgress = expectedLength
        ? received >= expectedLength * 0.25
        : received > 1_000_000;
      if (meaningfulProgress) lastError.novaNoFallback = true;
      throw lastError;
    }
    if (!received) throw new Error('прямой медиапоток пуст');
    if (expectedLength && received !== expectedLength) {
      throw new Error(`медиадорожка получена не полностью (${received} из ${expectedLength} байт)`);
    }
    if (vidId() !== requestedVideoId) {
      const navigationError = new Error('страница YouTube перешла к другому видео во время загрузки');
      navigationError.novaFatal = true;
      throw navigationError;
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    reportProgress(1);
    noteInnertubeSuccess(format);
    log(directLogTag, 'complete; bytes=', received, 'parts=', parts.length);
    return {
      bytes,
      mime: responseMime,
      duration: (Number(format.approxDurationMs) || 0) / 1000,
      height: mediaKind === 'video' ? (Number(format.height) || null) : null,
      _novaSource: format._novaSource || 'direct',
    };
  }

  async function fetchDirectVideo(height, onProgress) {
    let format = selectDirectVideoFormat(height);
    if (!format) {
      // Cheaper and far more reliable than the quality-switch probe below,
      // which cannot work at all while the player speaks SABR.
      await ensureInnertubeFormats(vidId());
      format = selectDirectVideoFormat(height);
    }
    if (!format) {
      const media = video();
      const previous = {
        paused: !!media?.paused,
        muted: !!media?.muted,
        time: Number(media?.currentTime) || 0,
      };
      try {
        setQualityRaw(QUALITY_BY_HEIGHT[height] || 'hd720');
        if (media) {
          media.muted = true;
          const target = Math.min(previous.time + 0.5,
            Math.max(0, (Number(media.duration) || 0) - 0.1));
          media.currentTime = target;
          await playWithTimeout(media, 1_250).catch(() => {});
        }
        for (let index = 0; index < 30 && !format; index++) {
          await sleep(100);
          format = selectDirectVideoFormat(height);
        }
      } finally {
        if (media) {
          if (previous.paused) media.pause();
          try { media.currentTime = previous.time; } catch (e) {}
          restoreMediaMuted(media, previous.muted);
        }
      }
    }
    if (!format) throw new Error(`YouTube не предоставил прямой URL видеодорожки ${height}p`);
    return fetchDirectAudio(onProgress, format, 'video');
  }

  async function captureRenderedAudio(end, onProgress) {
    const media = video();
    const captureStream = media && (media.captureStream || media.mozCaptureStream);
    if (!media || typeof captureStream !== 'function' || typeof MediaRecorder !== 'function') {
      throw new Error('браузер не поддерживает резервный захват звука плеера');
    }

    let duration = Number(media.duration) || 0;
    if (!duration) {
      for (let i = 0; i < 50 && !duration; i++) {
        await sleep(100);
        duration = Number(media.duration) || 0;
      }
    }
    const targetEnd = Math.min(Number(end) > 0 ? Number(end) : duration, duration);
    if (!targetEnd) throw new Error('длительность аудиодорожки неизвестна');

    const requestedVideoId = vidId();
    const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'video/webm;codecs=opus'];
    const recorderMime = preferredTypes.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    const previous = {
      paused: media.paused,
      time: media.currentTime,
      rate: media.playbackRate,
      muted: media.muted,
      loop: media.loop,
      preservesPitch: media.preservesPitch,
      webkitPreservesPitch: media.webkitPreservesPitch,
    };
    // MediaRecorder records already rendered audio. Accelerated playback uses
    // the browser's lossy time-stretching and discarded samples cannot be
    // reconstructed reliably by ffmpeg, so lossless fallback must run at 1x.
    const captureRate = 1;
    const parts = [];
    let stream;
    let recorder;
    let recorderError;
    let stopResolve;
    let stopped;

    const seekAndWait = async (time) => {
      const startedAt = Date.now();
      const deadline = startedAt + 15_000;
      let primedPlayback = false;
      try { player()?.seekTo?.(time, true); } catch (e) {}
      try { media.currentTime = time; } catch (e) {}
      while (Date.now() < deadline) {
        const closeEnough = Math.abs((Number(media.currentTime) || 0) - time) <= 0.35;
        if (!media.seeking && closeEnough) break;
        // An emptied MSE buffer cannot finish a seek while the element is
        // paused. Muted playback lets YouTube request the target segment.
        if (!primedPlayback && Date.now() - startedAt >= 300) {
          primedPlayback = true;
          try { await playWithTimeout(media); } catch (e) {}
        }
        await sleep(50);
      }
      if (primedPlayback) media.pause();
      if (media.seeking || Math.abs((Number(media.currentTime) || 0) - time) > 0.35) {
        throw new Error('плеер не завершил переход к началу аудио');
      }
    };

    try {
      media.loop = false;
      media.muted = true;
      if ('preservesPitch' in media) media.preservesPitch = true;
      if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
      media.playbackRate = 1;
      await seekAndWait(0);

      stream = captureStream.call(media);
      let audioTracks = stream?.getAudioTracks?.() || [];
      if (!audioTracks.length) {
        await playWithTimeout(media);
        for (let i = 0; i < 30 && !audioTracks.length; i++) {
          await sleep(100);
          audioTracks = stream?.getAudioTracks?.() || [];
        }
        media.pause();
        await seekAndWait(0);
      }
      if (!audioTracks.length) throw new Error('captureStream не предоставил аудиодорожку');

      const audioStream = new MediaStream(audioTracks);
      recorder = new MediaRecorder(audioStream, {
        ...(recorderMime ? { mimeType: recorderMime } : {}),
        audioBitsPerSecond: 192_000,
      });
      stopped = new Promise((resolve) => { stopResolve = resolve; });
      recorder.ondataavailable = (event) => {
        if (event.data?.size) parts.push(event.data);
      };
      recorder.onerror = (event) => {
        recorderError = event.error || new Error('MediaRecorder завершился с ошибкой');
      };
      recorder.onstop = () => stopResolve?.();

      media.playbackRate = captureRate;
      recorder.start(1_000);
      await playWithTimeout(media);
      log('rendered-audio', 'start; rate=', media.playbackRate, 'mime=', recorder.mimeType || recorderMime || 'default');
      onProgress(0.01);

      let lastMediaTime = media.currentTime;
      let lastAdvanceAt = Date.now();
      let pauseRequestedAt = 0;
      let resumeRequestedAt = 0;
      while (!media.ended && media.currentTime < targetEnd - 0.15) {
        throwIfDownloadCancelled();
        if (vidId() !== requestedVideoId) {
          const navigationError = new Error('страница YouTube перешла к другому видео во время захвата аудио');
          navigationError.novaFatal = true;
          throw navigationError;
        }
        if (recorderError) throw recorderError;
        if (media.paused) {
          if (recorder.state === 'recording' && !pauseRequestedAt) {
            pauseRequestedAt = Date.now();
            try { recorder.pause(); } catch (e) {}
          }
          if (recorder.state === 'recording' && Date.now() - pauseRequestedAt >= 2_000) {
            throw new Error('MediaRecorder не приостановил аудиозапись');
          }
          if (recorder.state === 'paused') pauseRequestedAt = 0;
          // A user pause is not a network stall. Keep the request alive and
          // exclude the paused wall-clock interval from the recorded file.
          lastAdvanceAt = Date.now();
          resumeRequestedAt = 0;
          onProgress(Math.min(0.99, media.currentTime / targetEnd), 'paused');
          await sleep(250);
          continue;
        }
        pauseRequestedAt = 0;
        if (recorder.state === 'paused' && !resumeRequestedAt) {
          resumeRequestedAt = Date.now();
          try { recorder.resume(); } catch (e) {}
        }
        if (recorder.state === 'paused' && Date.now() - resumeRequestedAt >= 2_000) {
          throw new Error('MediaRecorder не продолжил аудиозапись после паузы');
        }
        if (recorder.state === 'recording') resumeRequestedAt = 0;
        if (recorder.state === 'inactive') throw new Error('MediaRecorder преждевременно остановил аудиозапись');
        if (media.currentTime > lastMediaTime + 0.01) {
          lastMediaTime = media.currentTime;
          lastAdvanceAt = Date.now();
        }
        if (Date.now() - lastAdvanceAt >= 60_000) {
          throw new Error('плеер не выдавал аудиоданные более 60 секунд');
        }
        onProgress(Math.min(0.99, media.currentTime / targetEnd));
        await sleep(250);
      }

      media.pause();
      if (recorder.state !== 'inactive') recorder.stop();
      await Promise.race([
        stopped,
        sleep(5_000).then(() => { throw new Error('MediaRecorder не завершил аудиофайл'); }),
      ]);
      if (recorderError) throw recorderError;
      if (!parts.length) throw new Error('MediaRecorder не записал аудиоданные');

      const mime = recorder.mimeType || recorderMime || parts[0].type || 'audio/webm';
      const blob = new Blob(parts, { type: mime });
      if (!blob.size || blob.size > 750_000_000) throw new Error('размер записанной аудиодорожки недопустим');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      onProgress(1);
      log('rendered-audio', 'complete; bytes=', bytes.length, 'rate=', captureRate, 'parts=', parts.length);
      return { bytes, mime, duration: targetEnd, captureRate };
    } finally {
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch (e) {}
      try { stream?.getTracks?.().forEach((track) => track.stop()); } catch (e) {}
      try { media.playbackRate = previous.rate; } catch (e) {}
      try { media.loop = previous.loop; } catch (e) {}
      restoreMediaMuted(media, previous.muted);
      try { if ('preservesPitch' in media) media.preservesPitch = previous.preservesPitch; } catch (e) {}
      try { if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = previous.webkitPreservesPitch; } catch (e) {}
      try { media.currentTime = previous.time; } catch (e) {}
      if (previous.paused) media.pause();
      else media.play().catch(() => {});
    }
  }

  async function captureRenderedVideo(opts, onProgress) {
    const media = video();
    const captureStream = media && (media.captureStream || media.mozCaptureStream);
    if (!media || typeof captureStream !== 'function' || typeof MediaRecorder !== 'function') {
      throw new Error('браузер не поддерживает резервную запись видео плеера');
    }

    const previous = {
      paused: media.paused,
      time: media.currentTime,
      rate: media.playbackRate,
      muted: media.muted,
      loop: media.loop,
      preservesPitch: media.preservesPitch,
      webkitPreservesPitch: media.webkitPreservesPitch,
    };
    const restorePreviousMediaState = () => {
      try { media.playbackRate = previous.rate; } catch (e) {}
      try { media.loop = previous.loop; } catch (e) {}
      restoreMediaMuted(media, previous.muted);
      try { if ('preservesPitch' in media) media.preservesPitch = previous.preservesPitch; } catch (e) {}
      try { if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = previous.webkitPreservesPitch; } catch (e) {}
      try { media.currentTime = previous.time; } catch (e) {}
      if (previous.paused) media.pause();
      else media.play().catch(() => {});
    };
    const requestedEnd = Number(opts.end) > 0 ? Number(opts.end) : 0;
    const readPlayerDuration = () => {
      const mediaDuration = Number(media.duration);
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
      try {
        const playerDuration = Number(player()?.getDuration?.());
        if (Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
      } catch (e) {}
      return 0;
    };
    let duration = readPlayerDuration();
    if (!duration) {
      // loadVideoById temporarily resets HTMLMediaElement.duration to NaN/0.
      // Give YouTube a bounded metadata recovery window before falling back to
      // the duration already supplied by the UI for this exact video.
      onProgress(0.001);
      const metadataDeadline = Date.now() + 8_000;
      try { media.muted = true; } catch (e) {}
      try { player()?.seekTo?.(0, true); } catch (e) {}
      try { media.play()?.catch?.(() => {}); } catch (e) {}
      while (!duration && Date.now() < metadataDeadline) {
        await sleep(100);
        duration = readPlayerDuration();
      }
      try { media.pause(); } catch (e) {}
      if (!duration && requestedEnd) {
        duration = requestedEnd;
        log('rendered-video', 'using requested duration while player metadata recovers; end=', requestedEnd);
      }
    }
    const targetEnd = requestedEnd ? Math.min(requestedEnd, duration || requestedEnd) : duration;
    if (!targetEnd) {
      restorePreviousMediaState();
      throw new Error('длительность видео неизвестна после ожидания метаданных');
    }

    const requestedVideoId = vidId();
    const videoMime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    const audioMime = ['audio/webm;codecs=opus', 'audio/webm', 'video/webm;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    const bitrateByHeight = {
      144: 500_000, 240: 800_000, 360: 1_500_000, 480: 2_500_000,
      720: 5_000_000, 1080: 8_000_000, 1440: 14_000_000, 2160: 25_000_000,
    };
    let stream;
    let videoRecorder;
    let audioRecorder;
    let recorderError;
    const videoParts = [];
    const audioParts = [];

    const seekAndWait = async (time) => {
      const startedAt = Date.now();
      const deadline = startedAt + 15_000;
      let primedPlayback = false;
      try { player()?.seekTo?.(time, true); } catch (e) {}
      try { media.currentTime = time; } catch (e) {}
      while (Date.now() < deadline) {
        const closeEnough = Math.abs((Number(media.currentTime) || 0) - time) <= 0.35;
        if (!media.seeking && closeEnough) break;
        if (!primedPlayback && Date.now() - startedAt >= 300) {
          primedPlayback = true;
          try { await playWithTimeout(media); } catch (e) {}
        }
        await sleep(50);
      }
      if (primedPlayback) media.pause();
      if (media.seeking || Math.abs((Number(media.currentTime) || 0) - time) > 0.35) {
        throw new Error('плеер не завершил переход к началу видео');
      }
    };
    const stopRecorder = (recorder) => new Promise((resolve, reject) => {
      if (!recorder || recorder.state === 'inactive') { resolve(); return; }
      const timeout = setTimeout(() => reject(new Error('MediaRecorder не завершил видеозапись')), 5_000);
      recorder.addEventListener('stop', () => { clearTimeout(timeout); resolve(); }, { once: true });
      recorder.stop();
    });

    try {
      media.loop = false;
      media.muted = true;
      media.playbackRate = 1;
      if ('preservesPitch' in media) media.preservesPitch = true;
      if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
      setQualityRaw(opts.targetQ);
      await seekAndWait(0);
      await playWithTimeout(media);
      for (let i = 0; i < 30 && currentQuality() !== opts.height; i++) await sleep(200);
      media.pause();
      await seekAndWait(0);

      stream = captureStream.call(media);
      const videoTracks = stream?.getVideoTracks?.() || [];
      const audioTracks = stream?.getAudioTracks?.() || [];
      if (!videoTracks.length || !audioTracks.length) {
        throw new Error(`captureStream не предоставил все дорожки (video=${videoTracks.length}, audio=${audioTracks.length})`);
      }

      const trackHeight = Number(videoTracks[0].getSettings?.().height) || 0;
      const actualHeight = trackHeight || currentQuality() || Number(opts.height) || 0;
      videoRecorder = new MediaRecorder(new MediaStream(videoTracks), {
        ...(videoMime ? { mimeType: videoMime } : {}),
        videoBitsPerSecond: bitrateByHeight[Number(opts.height)] || 5_000_000,
      });
      audioRecorder = new MediaRecorder(new MediaStream(audioTracks), {
        ...(audioMime ? { mimeType: audioMime } : {}),
        audioBitsPerSecond: 192_000,
      });
      videoRecorder.ondataavailable = (event) => { if (event.data?.size) videoParts.push(event.data); };
      audioRecorder.ondataavailable = (event) => { if (event.data?.size) audioParts.push(event.data); };
      videoRecorder.onerror = (event) => { recorderError = event.error || new Error('ошибка записи видеодорожки'); };
      audioRecorder.onerror = (event) => { recorderError = event.error || new Error('ошибка записи аудиодорожки'); };

      videoRecorder.start(1_000);
      audioRecorder.start(1_000);
      await playWithTimeout(media);
      log('rendered-video', 'start; rate= 1 videoMime=', videoRecorder.mimeType || videoMime || 'default',
        'audioMime=', audioRecorder.mimeType || audioMime || 'default', 'height=', actualHeight);
      onProgress(0.01);

      let lastMediaTime = media.currentTime;
      let lastAdvanceAt = Date.now();
      let pauseRequestedAt = 0;
      let resumeRequestedAt = 0;
      while (!media.ended && media.currentTime < targetEnd - 0.15) {
        throwIfDownloadCancelled();
        if (vidId() !== requestedVideoId) {
          const navigationError = new Error('страница YouTube перешла к другому видео во время записи видео');
          navigationError.novaFatal = true;
          throw navigationError;
        }
        if (recorderError) throw recorderError;
        if (media.paused) {
          if ((videoRecorder.state === 'recording' || audioRecorder.state === 'recording') && !pauseRequestedAt) {
            pauseRequestedAt = Date.now();
            try { if (videoRecorder.state === 'recording') videoRecorder.pause(); } catch (e) {}
            try { if (audioRecorder.state === 'recording') audioRecorder.pause(); } catch (e) {}
          }
          if ((videoRecorder.state === 'recording' || audioRecorder.state === 'recording')
            && Date.now() - pauseRequestedAt >= 2_000) {
            throw new Error('MediaRecorder не приостановил дорожки');
          }
          if (videoRecorder.state === 'paused' && audioRecorder.state === 'paused') pauseRequestedAt = 0;
          lastAdvanceAt = Date.now();
          resumeRequestedAt = 0;
          onProgress(Math.min(0.99, media.currentTime / targetEnd), 'paused');
          await sleep(250);
          continue;
        }
        pauseRequestedAt = 0;
        if ((videoRecorder.state === 'paused' || audioRecorder.state === 'paused') && !resumeRequestedAt) {
          resumeRequestedAt = Date.now();
          try { if (videoRecorder.state === 'paused') videoRecorder.resume(); } catch (e) {}
          try { if (audioRecorder.state === 'paused') audioRecorder.resume(); } catch (e) {}
        }
        if ((videoRecorder.state === 'paused' || audioRecorder.state === 'paused')
          && Date.now() - resumeRequestedAt >= 2_000) {
          throw new Error('MediaRecorder не продолжил дорожки после паузы');
        }
        if (videoRecorder.state === 'recording' && audioRecorder.state === 'recording') resumeRequestedAt = 0;
        if (videoRecorder.state === 'inactive' || audioRecorder.state === 'inactive') {
          throw new Error('MediaRecorder преждевременно остановил одну из дорожек');
        }
        if (media.currentTime > lastMediaTime + 0.01) {
          lastMediaTime = media.currentTime;
          lastAdvanceAt = Date.now();
        }
        if (Date.now() - lastAdvanceAt >= 60_000) throw new Error('плеер не выдавал видеоданные более 60 секунд');
        onProgress(Math.min(0.99, media.currentTime / targetEnd));
        await sleep(250);
      }

      media.pause();
      await Promise.all([stopRecorder(videoRecorder), stopRecorder(audioRecorder)]);
      if (recorderError) throw recorderError;
      if (!videoParts.length || !audioParts.length) throw new Error('MediaRecorder не записал все дорожки видео');

      const recordedVideoMime = videoRecorder.mimeType || videoMime || videoParts[0].type || 'video/webm';
      const recordedAudioMime = audioRecorder.mimeType || audioMime || audioParts[0].type || 'audio/webm';
      const videoBlob = new Blob(videoParts, { type: recordedVideoMime });
      const audioBlob = new Blob(audioParts, { type: recordedAudioMime });
      if (!videoBlob.size || videoBlob.size > 750_000_000 || !audioBlob.size || audioBlob.size > 750_000_000) {
        throw new Error('размер записанных дорожек видео недопустим');
      }
      const videoBytes = new Uint8Array(await videoBlob.arrayBuffer());
      const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
      onProgress(1);
      log('rendered-video', 'complete; videoBytes=', videoBytes.length, 'audioBytes=', audioBytes.length,
        'height=', actualHeight, 'videoParts=', videoParts.length, 'audioParts=', audioParts.length);
      return {
        video: { bytes: videoBytes, mime: recordedVideoMime, height: actualHeight },
        audio: { bytes: audioBytes, mime: recordedAudioMime, captureRate: 1 },
        actualHeight,
        duration: targetEnd,
        // Both tracks are already WebM (VP9/VP8 + Opus): a stream-copy remux
        // rebuilds cues/duration in seconds. Forcing libx264 here made a
        // single-threaded wasm re-encode of a 1440p recording run for hours.
      };
    } finally {
      try { if (videoRecorder && videoRecorder.state !== 'inactive') videoRecorder.stop(); } catch (e) {}
      try { if (audioRecorder && audioRecorder.state !== 'inactive') audioRecorder.stop(); } catch (e) {}
      try { stream?.getTracks?.().forEach((track) => track.stop()); } catch (e) {}
      restorePreviousMediaState();
    }
  }

  // ---- capture ---------------------------------------------------------------
  // Strategy: the appendBuffer hook captures bytes as the YouTube player buffers.
  // MP3 may reuse a continuous passive audio buffer. Video always starts a fresh
  // sequential pass because previously watched/searched MSE ranges do not prove
  // that every video fragment from zero is present in the captured byte stream.
  function capturedTrackHasMedia(kind) {
    const track = store.tracks[kind];
    return Boolean(track?.parts?.length
      && (track.parts.length > 1 || Number.isFinite(track.firstMediaTime)));
  }

  function capturedTrackStartSeconds(kind) {
    const track = store.tracks[kind];
    if (!track?.parts?.length) return 0;
    const observedMediaTime = Number(track.firstMediaTime);
    const fallbackStart = Number.isFinite(observedMediaTime) && observedMediaTime > 0
      ? observedMediaTime : 0;
    const isWebmTrack = /webm/i.test(track.mime || '')
      || track.parts.some((part) => part.length >= 4
        && part[0] === 0x1a && part[1] === 0x45 && part[2] === 0xdf && part[3] === 0xa3);
    if (!isWebmTrack) return fallbackStart;
    let firstWebmTimecode = Infinity;
    for (const part of track.parts) {
      // Media segments start with (or very close to) Cluster. Limit inspection
      // so MP4-sized tracks can never add a new startup pause.
      const inspectionEnd = Math.min(part.length, 64 * 1024);
      for (let offset = 0; offset + 4 <= inspectionEnd; offset++) {
        if (part[offset] !== 0x1f || part[offset + 1] !== 0x43
          || part[offset + 2] !== 0xb6 || part[offset + 3] !== 0x75) continue;
        const timecode = webmClusterTimecode(part, offset);
        if (Number.isFinite(timecode)) firstWebmTimecode = Math.min(firstWebmTimecode, timecode);
        break;
      }
      if (firstWebmTimecode <= 5_000) break;
    }
    if (Number.isFinite(firstWebmTimecode)) return firstWebmTimecode / 1000;
    return fallbackStart;
  }

  async function preparePlayerForRenderedCapture(videoId, targetQ) {
    const activePlayer = player();
    if (!videoId || typeof activePlayer?.loadVideoById !== 'function') return false;

    // A failed MSE prefix refill may have opened holes in the attached
    // SourceBuffers. Recreate them through the player API before MediaRecorder
    // tries to seek to zero; otherwise the rendered fallback inherits the
    // poisoned buffer and fails with "player did not complete seek".
    store.capturing = false;
    try { activePlayer.stopVideo?.(); } catch (e) {}
    await sleep(100);
    setQualityRaw(targetQ);
    activePlayer.loadVideoById(videoId, 0, targetQ);

    const deadline = Date.now() + 15_000;
    let media = video();
    while (Date.now() < deadline) {
      await sleep(100);
      if (vidId() !== videoId) {
        const error = new Error('видео переключилось во время подготовки резервной записи');
        error.novaFatal = true;
        throw error;
      }
      media = video() || media;
      if (!media) continue;
      try { media.muted = true; } catch (e) {}
      setQualityRaw(targetQ);
      try { media.play()?.catch?.(() => {}); } catch (e) {}
      const currentTime = Number(media.currentTime) || 0;
      const duration = Number(media.duration) || Number(activePlayer.getDuration?.()) || 0;
      if (duration > 0 && currentTime <= 1 && media.readyState >= 2) {
        try { media.pause(); } catch (e) {}
        log('rendered-video', 'player reloaded at start before fallback; q=', targetQ,
          'readyState=', media.readyState);
        return true;
      }
    }
    log('rendered-video', 'player reload before fallback timed out; q=', targetQ,
      'time=', Number(media?.currentTime) || 0, 'readyState=', media?.readyState);
    return false;
  }

  function bufferedEdgeForTrack(kind, position) {
    let buffers = liveSourceBuffers(kind);
    if (!buffers.length && liveSourceBuffers(kind, false).length === 1) {
      buffers = liveSourceBuffers(kind, false);
    }
    let bestEdge = Math.max(0, Number(position) || 0);
    for (const sourceBuffer of buffers) {
      let edge = Math.max(0, Number(position) || 0);
      try {
        for (let index = 0; index < sourceBuffer.buffered.length; index++) {
          if (sourceBuffer.buffered.start(index) <= edge + 0.75
            && sourceBuffer.buffered.end(index) > edge) {
            edge = sourceBuffer.buffered.end(index);
          }
        }
      } catch (e) {}
      bestEdge = Math.max(bestEdge, edge);
    }
    return bestEdge;
  }

  async function captureBackground(opts, onProgress) {
    const isMp3 = opts.isMp3;
    const targetQ = opts.targetQ;
    const needVideo = !isMp3;
    const forceFreshVideo = needVideo && Boolean(opts.forceFreshVideo);
    const mp3FillerHeight = Number(opts.mp3FillerHeight) || null;
    const capId = vidId();
    log('capture', 'start; mp3=', isMp3, 'q=', targetQ, 'ctx=', (isShortsPage() ? 'shorts'
      : (location.pathname.indexOf('/embed/') === 0 ? 'embed' : 'page')));
    let v = video();
    if (!v) throw new Error('video element not found');
    // Where the player stands when capture begins. Without this a track that
    // starts at 26 s is unexplainable after the fact: it could be the playhead
    // we started from, a buffer YouTube had already evicted, or a looping
    // Short that wrapped. Cheap to log, and it decides which of those it was.
    try {
      const spans = [];
      for (let index = 0; index < v.buffered.length; index++) {
        spans.push(`${v.buffered.start(index).toFixed(1)}-${v.buffered.end(index).toFixed(1)}`);
      }
      log('capture', 'player position at start; currentTime=', Number(v.currentTime.toFixed(2)),
        'duration=', Number((v.duration || 0).toFixed(2)), 'loop=', Boolean(v.loop),
        'paused=', Boolean(v.paused), 'readyState=', v.readyState,
        'buffered=', spans.join(',') || 'empty');
    } catch (e) {}
    let dur = v.duration;
    if (!isFinite(dur) || dur <= 0) {
      await new Promise((res) => {
        const done = () => { if (v) { v.removeEventListener('loadedmetadata', done); v.removeEventListener('durationchange', done); } res(); };
        if (v) { v.addEventListener('loadedmetadata', done, { once: true }); v.addEventListener('durationchange', done, { once: true }); }
        setTimeout(res, 4000);
      });
      dur = v && v.duration;
    }
    if (!isFinite(dur) || dur <= 0) throw new Error('duration unknown');
    const capEnd = Math.min(opts.end && opts.end > 0 ? opts.end : dur, dur);
    const requiredKinds = needVideo ? ['audio', 'video'] : ['audio'];
    const initialMissingPrefix = Math.min(capEnd, requiredKinds.reduce((start, kind) => {
      return Math.max(start, capturedTrackStartSeconds(kind));
    }, 0));
    const reportCaptureProgress = (edge) => {
      // If passive capture began after zero, reserve that exact fraction of the
      // bar for the targeted prefix refill. A pass from 10% to 100% therefore
      // fills 90% of the bar instead of reaching 100% prematurely.
      const coveredAfterPrefix = Math.max(0, Math.min(capEnd, Number(edge) || 0) - initialMissingPrefix);
      onProgress(Math.min(0.99, coveredAfterPrefix / capEnd));
    };

    if (store.captureError) throw store.captureError;
    store.capturing = true; // passive + active capture via appendBuffer hook
    keepAutoplayOff();
    const previousHeight = currentQuality();
    let qualityRestarted = false;
    let freshMseRestarted = false;
    // Do not reload a page merely because the opening video cluster was not
    // observable. Assembly first tries MSE refill and then records only that
    // short missing prefix, preserving the already downloaded tail.
    let freshPrefixPreflightDone = true;
    const prev = { paused: v.paused, rate: v.playbackRate, time: v.currentTime, muted: v.muted };
    // Hold the element paused for this pass. The download command normally owns
    // the hold (so assembly-time refills are protected too); create a local one
    // only when this function is entered on its own.
    const ownsPlaybackHold = store.playbackHold?.media !== v;
    if (ownsPlaybackHold) {
      store.playbackHold?.release();
      store.playbackHold = holdPlaybackPaused(v);
    }
    const playbackHold = store.playbackHold;
    const releasePlaybackHold = () => {
      if (!ownsPlaybackHold) return;
      playbackHold.release();
      store.playbackHold = null;
    };
    playbackHold.enforce();
    const seekTo = (sec) => { try { const p = player(); if (p && p.seekTo) { p.seekTo(sec, true); return; } } catch (e) {} try { v.currentTime = sec; } catch (e) {} };
    const restoreMediaState = () => {
      try { v.playbackRate = prev.rate; } catch (e) {}
      seekTo(prev.time);
      try { v.muted = prev.muted; } catch (e) {}
      if (prev.paused) {
        try { v.pause(); } catch (e) {}
      } else {
        try { v.play()?.catch?.(() => {}); } catch (e) {}
      }
    };
    const preflightFreshWebmPrefixes = async () => {
      if (freshPrefixPreflightDone) return;
      if (!capturedTrackHasMedia('audio') || !capturedTrackHasMedia('video')) return;
      const starts = ['audio', 'video'].map((kind) => ({
        kind,
        timecode: firstCapturedWebmTimecode(kind),
      }));
      // Unknown/non-WebM streams keep their normal container validation path.
      // For WebM, a known non-zero first cluster can be repaired immediately,
      // before the expensive tail pass downloads the whole file.
      const missingVideo = starts.find(({ kind, timecode }) => (
        kind === 'video' && Number(timecode) > 5_000
      ));
      if (missingVideo) {
        // Removing a video prefix while the tail is still loading can stall
        // SABR. Keep the captured tail and repair only this bounded prefix after
        // validation, without discarding the page or restarting the full pass.
        log('capture', 'deferring video prefix repair until local assembly recovery',
          'firstMs=', missingVideo.timecode);
      }
      const missingAudio = starts.filter(({ kind, timecode }) => (
        kind === 'audio' && Number(timecode) > 5_000
      ));
      for (const { kind, timecode } of missingAudio) {
        log('capture', 'early fresh-page WebM prefix recovery; kind=', kind,
          'firstMs=', timecode, 'reloadCount=', Number(opts.reloadCount) || 0);
        try {
          await refillMissingWebmPrefix(kind, timecode, (pct) => {
            onProgress(Math.min(0.08, Math.max(0, Number(pct) || 0) * 0.08));
          });
        } catch (cause) {
          log('capture', 'early audio prefix refill unavailable; deferring bounded repair:',
            cause?.message || cause);
        }
      }
      const unrepaired = ['audio', 'video']
        .map((kind) => ({ kind, timecode: firstCapturedWebmTimecode(kind) }))
        .find(({ kind, timecode }) => kind === 'audio' && Number(timecode) > 5_000);
      if (unrepaired) {
        log('capture', 'audio prefix remains incomplete after preflight; assembly will refill it locally',
          'firstMs=', unrepaired.timecode);
      }
      freshPrefixPreflightDone = true;
    };
    // An audio-only seek pass also makes YouTube buffer a video representation.
    // Keep that disposable buffer at the lowest quality so a later 1080p/720p
    // download must request fresh video segments instead of reading a complete
    // same-quality SourceBuffer that our hook can no longer reconstruct.
    // Not on Music: there the audio bitrate follows the video tier, so pinning
    // 144p makes the player fall back from Opus 251 (~150 kbit/s) to 250
    // (~70 kbit/s) — the download would silently lose half its quality.
    if (isMp3 && !MUSIC_HOST) {
      const lowestHeight = await lowestAvailableHeight();
      const lowestQuality = QUALITY_BY_HEIGHT[lowestHeight] || null;
      if (lowestQuality) {
        try { if (!v.paused) v.pause(); } catch (e) {}
        setQualityRaw(lowestQuality);
        for (let attempt = 0; attempt < 20; attempt++) {
          if (currentQuality() === lowestHeight) break;
          await sleep(100);
        }
        store.mp3Isolation = {
          videoId: capId,
          fillerHeight: lowestHeight,
          createdAt: Date.now(),
        };
        log('capture', 'audio-only pass isolated from later video quality; filler=',
          lowestHeight + 'p', 'available=', availableHeights().sort((left, right) => left - right).join(','),
          'current=', currentQuality());
      } else {
        log('capture', 'audio-only pass: available quality list unavailable; keeping current quality=',
          currentQuality());
      }
    }

    // Request target quality so the captured track is the desired one.
    if (needVideo) {
      try { if (!v.paused) v.pause(); } catch (e) {}
      const requestedHeight = Number(opts.height) || 0;
      if (requestedHeight > 0 && (forceFreshVideo
        || (previousHeight && previousHeight !== requestedHeight))) {
        // Discard only our bytes from the disposable MP3 video representation.
        // Do not touch SourceBuffer: the quality switch below will naturally
        // fetch the requested representation and append it through the hook.
        delete store.tracks.video;
        delete store._pendingInit.video;
        store.lastAppendAt.video = 0;
      }
      if (forceFreshVideo && requestedHeight > 0) {
        const heights = availableHeights().sort((left, right) => left - right);
        const alternateHeight = mp3FillerHeight !== requestedHeight
          && QUALITY_BY_HEIGHT[mp3FillerHeight]
          ? mp3FillerHeight
          : (heights.find((candidate) => candidate !== requestedHeight) || null);
        const alternateQuality = QUALITY_BY_HEIGHT[alternateHeight] || null;
        if (alternateQuality) {
          setQualityRaw(alternateQuality);
          for (let attempt = 0; attempt < 20; attempt++) {
            if (currentQuality() === alternateHeight) break;
            await sleep(100);
          }
          log('capture', 'cycling away from restored quality after MP3; alternate=',
            alternateHeight + 'p', 'requested=', requestedHeight + 'p');
        }
      }
      setQualityRaw(targetQ);
    }
    // SABR often ignores setPlaybackQuality; wait (up to ~6s) for the player to
    // actually switch to the requested quality before we start capturing.
    const wantQ = QUALITY_BY_HEIGHT[opts.height] || null;
    if (wantQ && needVideo) {
      for (let i = 0; i < 30; i++) {
        if (currentQuality() === opts.height) break;
        await sleep(200);
      }
      const got = currentQuality();
      if (got && got !== opts.height) {
        log('capture', 'requested ' + opts.height + 'p but player is on ' + got + 'p (SABR ignored request)');
      }
      if (got && (got !== previousHeight || forceFreshVideo)) {
        // Ask the new representation for its first segment without removing the
        // attached SourceBuffer. Current YouTube SABR sessions often never
        // recover after SourceBuffer.remove().
        qualityRestarted = true;
        seekTo(0);
      }
    }
    // Primary path: reuse bytes captured passively since the current video
    // started, then seek-fill only its missing tail. This is the fast v1.0
    // strategy; rendered capture remains a final fallback outside this method.
    if (needVideo) {
      const currentAudioBufferCount = liveSourceBuffers('audio').length;
      const currentVideoBufferCount = liveSourceBuffers('video').length;
      const allAudioBuffers = liveSourceBuffers('audio', false);
      const allVideoBuffers = liveSourceBuffers('video', false);
      const allAudioBufferCount = allAudioBuffers.length;
      const allVideoBufferCount = allVideoBuffers.length;
      log('capture', 'source buffer scan; currentAudio=', currentAudioBufferCount, 'currentVideo=', currentVideoBufferCount,
        'allAudio=', allAudioBufferCount, 'allVideo=', allVideoBufferCount);
      if (!store._lastInit.audio && allAudioBufferCount) {
        adoptAttachedInitForCapture('audio', allAudioBuffers, capId);
      }
      if (!store._lastInit.video && allVideoBufferCount) {
        adoptAttachedInitForCapture('video', allVideoBuffers, capId);
      }
      log('capture', 'fast passive MSE pass; audioParts=', store.tracks.audio?.parts?.length || 0,
        'videoParts=', store.tracks.video?.parts?.length || 0);
    }
    // If passive capture has no bytes yet (common immediately after an extension
    // reload), keep the attached buffers intact and let the proven v1.0 paused-
    // seek loop continue from their buffered edge. Clearing both tracks leaves
    // current YouTube SABR sessions unable to resume the video SourceBuffer.
    if (!capturedTrackHasMedia('audio') || (needVideo && !capturedTrackHasMedia('video'))) {
      const missingAudio = !capturedTrackHasMedia('audio');
      const missingVideo = needVideo && !capturedTrackHasMedia('video');
      const audioBuffers = liveSourceBuffers('audio', false);
      const videoBuffers = liveSourceBuffers('video', false);
      if (missingAudio && !store._lastInit.audio) adoptAttachedInitForCapture('audio', audioBuffers, capId);
      if (missingVideo && !store._lastInit.video) adoptAttachedInitForCapture('video', videoBuffers, capId);
      log('capture', 'fast v1 MSE seek bootstrap; missingAudio=', missingAudio, 'missingVideo=', missingVideo,
        'audioBuffers=', audioBuffers.length, 'videoBuffers=', videoBuffers.length,
        'workerAudio=', store.workerTransports.audio.size,
        'workerVideo=', store.workerTransports.video.size,
        'initFallback=', Object.keys(store.initFallback).join(',') || 'none');
      // Music tracks are typically fully buffered already (they just played),
      // so SABR serves nothing for the paused seeks, and the playback rescue
      // only pulls in the NEXT track's gapless preload ("видео переключилось"
      // reload loops). Drop the buffered ranges the capture never observed —
      // SABR then re-serves the whole track from zero. Both kinds go together:
      // SABR keeps a range alive while its companion buffer still covers it.
      if (MUSIC_HOST && (missingAudio || missingVideo)) {
        const flushEnd = (Number(v.duration) || capEnd || 0) + 5;
        for (const kind of ['audio', 'video']) {
          try {
            const removed = await removeTrackPrefixForCapture(kind, flushEnd, true);
            if (removed) log('capture', 'flushed pre-buffered range; kind=', kind, 'end=', flushEnd);
          } catch (e) {}
        }
        // Freshly opened Music tracks often run their MSE in a worker: the
        // page hook sees zero SourceBuffers and zero bytes, primers cannot
        // help, and ~40 wasted seconds later the escalation trips ytmusic
        // into the next track. After a page reload the session reliably
        // lands in the page again — so reload immediately instead.
        const workerBridged = store.workerTransports.audio.size || store.workerTransports.video.size;
        if (!audioBuffers.length && !videoBuffers.length && !workerBridged) {
          // Nothing to observe yet: on Music that means the track has never
          // played, so build its media session before deciding anything.
          await primeMusicMediaSession(v, capEnd);
          const graceDeadline = Date.now() + 3_000;
          let pageBuffersAppeared = false;
          while (Date.now() < graceDeadline) {
            await sleep(250);
            throwIfDownloadCancelled();
            if (liveSourceBuffers('audio', false).length
              || liveSourceBuffers('video', false).length
              || store.workerTransports.audio.size
              || capturedTrackHasMedia('audio')) {
              pageBuffersAppeared = true;
              break;
            }
          }
          if (!pageBuffersAppeared) {
            log('capture', 'no page-visible SourceBuffers (worker MSE); requesting reload without waiting');
            throw new Error('плеер обслуживает медиапоток в фоновом потоке — нужна перезагрузка страницы');
          }
          // Buffers materialized after the flush above already ran — flush
          // again, or their pre-filled ranges starve the seek pass anyway.
          for (const kind of ['audio', 'video']) {
            try {
              const removed = await removeTrackPrefixForCapture(kind, flushEnd, true);
              if (removed) log('capture', 'flushed late-appearing buffered range; kind=', kind);
            } catch (e) {}
          }
        }
      }
    }

    // Do not reload the current video through loadVideoById here. On current
    // YouTube builds that can move subsequent MSE work into a worker: the media
    // element buffers normally, but the page SourceBuffer hook sees no bytes.
    // The paused-seek pass below remains attached to the observable stream.

    // Extend from the current capture cursor through any touching buffered
    // ranges. YouTube evicts old ranges on long videos, so measuring strictly
    // from zero would make progress jump back to 0 and restart the seek pass.
    const bufferedEndFrom = (position) => {
      let end = Math.max(0, Number(position) || 0);
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= end + 0.75 && v.buffered.end(i) > end) {
          end = v.buffered.end(i);
        }
      }
      return end;
    };

    // Already fully buffered up to the capture end? Nothing to fetch -> no seek.
    const initialBufferedEnd = bufferedEndFrom(0);
    // Do not declare completion one whole YouTube segment early. The previous
    // tolerance reached almost six seconds on ordinary videos, so assembly
    // correctly rejected the absent tail at 99% and forced a full second pass.
    const endTolerance = Math.min(0.15, capEnd * 0.001);
    const reachedCaptureEnd = (edge) => edge >= capEnd - endTolerance;
    if (!qualityRestarted && capturedTrackHasMedia('audio')
      && (!needVideo || capturedTrackHasMedia('video'))
      && reachedCaptureEnd(initialBufferedEnd)) {
      reportCaptureProgress(capEnd);
      store.capturing = false;
      releasePlaybackHold();
      restoreMediaState();
      log('capture', 'complete from existing buffer; end=', initialBufferedEnd, 'target=', capEnd,
        'tolerance=', endTolerance);
      return { actualHeight: store.tracks.video?.height || currentQuality(), duration: capEnd };
    }

    // Only seek-fill the NOT-yet-buffered tail (from the buffered edge to the
    // end). Everything already buffered was captured passively and is kept in
    // store.tracks, so we never re-fetch the beginning. This keeps the seek
    // pass as short as possible.
    let cursor = qualityRestarted ? 0 : initialBufferedEnd;
    let initialAudioRevision = store.trackRevision.audio;
    let initialVideoRevision = store.trackRevision.video;
    let lastAdvanceAt = Date.now();
    let lastMediaAt = Date.now();
    let observedAppendAt = Math.max(store.lastAppendAt.audio || 0, needVideo ? (store.lastAppendAt.video || 0) : 0);
    // The primer is what makes SABR answer immediately instead of leaving a
    // paused seek in its queue. It used to run exactly once: when that single
    // attempt produced nothing, the pass sat on paused seeks until the 60 s
    // stall guard fired. Previously an autoplaying player accidentally kept
    // re-priming; now that playback is pinned, Nova re-primes on purpose.
    let primerCount = 0;
    let lastPrimeAt = 0;
    const maxPrimers = 6;
    // Rescue mode: if SABR stops answering paused seeks entirely, fall back to
    // ordinary muted playback. The player then prefetches ahead on its own and
    // the appendBuffer hook keeps capturing the same original segments, so this
    // stays lossless — unlike the rendered 1x MediaRecorder fallback.
    let playbackDriven = false;
    let musicStallFlushed = false;
    try { v.muted = true; } catch (e) {}

    try {
      while (true) {
        // Keep the proven v1.0 cadence. YouTube coalesces these paused seeks
        // into SABR range requests more reliably than active playback or a
        // multi-second retry backoff.
        await sleep(350);
        if (store.captureError) throw store.captureError;
        throwIfDownloadCancelled();
        if (vidId() !== capId) throw new Error('видео переключилось');
        if (!v.paused && !playbackDriven) pauseForCapture(v);
        let now = Date.now();
        if (store.trackRevision.audio !== initialAudioRevision
          || (needVideo && store.trackRevision.video !== initialVideoRevision)) {
          const error = new Error('YouTube сменил медиапоток во время загрузки; файл не сохранён во избежание повреждения');
          if (freshMseRestarted) error.novaSkipSequential = true;
          error.details = {
            audioRevisionBefore: initialAudioRevision,
            audioRevisionAfter: store.trackRevision.audio,
            videoRevisionBefore: initialVideoRevision,
            videoRevisionAfter: store.trackRevision.video,
            cursor,
            target: capEnd,
          };
          throw error;
        }
        const appendAt = Math.max(store.lastAppendAt.audio || 0, needVideo ? (store.lastAppendAt.video || 0) : 0);
        if (appendAt > observedAppendAt) {
          observedAppendAt = appendAt;
          lastMediaAt = now;
        }
        let edge = bufferedEndFrom(cursor);
        let tracksReady = capturedTrackHasMedia('audio')
          && (!needVideo || capturedTrackHasMedia('video'));
        if (tracksReady && !freshPrefixPreflightDone) {
          await preflightFreshWebmPrefixes();
          now = Date.now();
          edge = bufferedEndFrom(cursor);
          tracksReady = capturedTrackHasMedia('audio')
            && (!needVideo || capturedTrackHasMedia('video'));
        }
        reportCaptureProgress(tracksReady ? Math.max(cursor, edge) : cursor);
        if (tracksReady && reachedCaptureEnd(edge)) break;
        const needsPrimer = !playbackDriven && primerCount < maxPrimers && (!tracksReady
          ? (primerCount === 0 ? now - lastMediaAt >= 250 : now - lastPrimeAt >= 6_000)
          : (now - lastMediaAt >= 8_000 && now - lastPrimeAt >= 8_000));
        if (needsPrimer) {
          // A paused seek can sit in SABR's queue for many seconds before the
          // first append. Brief muted playback asks for it immediately and is
          // stopped as soon as either required track appends.
          primerCount += 1;
          lastPrimeAt = now;
          const appendBeforePrime = observedAppendAt;
          seekTo(Math.min(cursor + 0.05, capEnd - 0.1));
          try { await playWithTimeout(v, 750); } catch (e) {}
          const primeDeadline = Date.now() + 1_500;
          while (Date.now() < primeDeadline) {
            const requiredTracksReady = capturedTrackHasMedia('audio')
              && (!needVideo || capturedTrackHasMedia('video'));
            // A re-primer runs with both tracks already present, so readiness
            // alone would end the playback window before SABR emitted anything.
            // Hold it open until this primer actually produced an append.
            const appendedDuringPrime = Math.max(store.lastAppendAt.audio || 0,
              needVideo ? (store.lastAppendAt.video || 0) : 0) > appendBeforePrime;
            if (requiredTracksReady && appendedDuringPrime) break;
            await sleep(75);
          }
          pauseForCapture(v);
          const latestAppend = Math.max(store.lastAppendAt.audio || 0,
            needVideo ? (store.lastAppendAt.video || 0) : 0);
          if (latestAppend > observedAppendAt) {
            observedAppendAt = latestAppend;
            lastMediaAt = Date.now();
          }
          log('capture', 'MSE request primer', primerCount, 'of', maxPrimers,
            '; appendObserved=', latestAppend > appendBeforePrime,
            'tracksReady=', tracksReady,
            'audioParts=', store.tracks.audio?.parts?.length || 0,
            'videoParts=', store.tracks.video?.parts?.length || 0);
          continue;
        }
        if (playbackDriven) {
          if (edge > cursor + 0.3) {
            cursor = edge;
            lastAdvanceAt = now;
          }
          if (v.paused && !v.ended) {
            try { await playWithTimeout(v, 2_000); } catch (e) {}
          }
          // Skip through already captured ranges so playback time is spent only
          // where segments are still missing; YouTube keeps prefetching ahead.
          const skipTarget = Math.min(edge - 1, capEnd - 0.1);
          if (Number.isFinite(skipTarget) && skipTarget > (Number(v.currentTime) || 0) + 6) {
            seekTo(skipTarget);
          }
        }
        else if (!tracksReady) {
          // v1.0 only advances cursor after buffered data actually grows.
          // Repeating the same small seek prevents requests from racing ahead
          // while YouTube is still creating the first audio/video fragments.
          seekTo(Math.min(cursor + 0.5, capEnd - 0.1));
        }
        else if (edge > cursor + 0.3) {
          cursor = edge;
          lastAdvanceAt = now;
          seekTo(Math.min(cursor, capEnd - 0.1));
        }
        else if (cursor < capEnd - 0.5) seekTo(Math.min(cursor + 0.5, capEnd - 0.1));
        else break;

        const stalledForMs = now - Math.max(lastAdvanceAt, lastMediaAt);
        // Nothing has arrived at all: the paused-seek pattern is not being
        // served, and every extra second of primers is pure waiting. Once even
        // one fragment exists the pattern demonstrably works, so a lull there
        // keeps the full grace period instead of jumping to playback.
        // One empty track is enough: in the 09:47 log video had two fragments
        // while audio had none, so the "both empty" test never fired and the
        // pass sat through the full twenty seconds before escalating.
        const nothingCaptured = !(store.tracks.audio?.parts?.length)
          || (needVideo && !(store.tracks.video?.parts?.length));
        const escalateAfterMs = nothingCaptured && !MUSIC_HOST
          ? Math.min(CAPTURE_IDLE_ESCALATION_MS, 5_000) : CAPTURE_IDLE_ESCALATION_MS;
        if (!playbackDriven && stalledForMs >= escalateAfterMs) {
          if (MUSIC_HOST) {
            // Music buffers often materialize seconds AFTER the bootstrap
            // flush ran, already pre-filled — SABR then serves nothing. Flush
            // once more mid-loop; if it stays dry, request the page reload
            // right away. Playback escalation is never used here: it makes
            // ytmusic advance to the next track mid-capture.
            if (!musicStallFlushed) {
              musicStallFlushed = true;
              let flushedAny = false;
              for (const kind of ['audio', 'video']) {
                try {
                  const removed = await removeTrackPrefixForCapture(kind, capEnd + 5, true);
                  flushedAny = flushedAny || removed;
                } catch (e) {}
              }
              log('capture', 'stall on music; mid-loop buffered flush; removedAny=', flushedAny,
                'cursor=', Number(cursor.toFixed(2)));
              // Nothing to flush means the media session still does not exist:
              // wake it up with a short muted play instead of giving up.
              if (!flushedAny) await primeMusicMediaSession(v, capEnd);
              lastAdvanceAt = Date.now();
              lastMediaAt = Date.now();
              continue;
            }
            throw new Error('SABR не отвечает на запросы сегментов — нужна перезагрузка страницы');
          }
          // SABR sometimes stops serving the paused-seek pattern altogether.
          // Real muted playback is indistinguishable from normal viewing, so it
          // reliably restarts segment delivery while capture continues.
          playbackDriven = true;
          deliberatePlaybackDepth += 1;
          log('capture', `paused seeks idle for ${Math.round(stalledForMs / 1000)}s`
            + ` (threshold ${Math.round(escalateAfterMs / 1000)}s, captured=${nothingCaptured ? 'nothing' : 'partial'});`
            + ' escalating to muted playback-driven capture; cursor=',
            Number(cursor.toFixed(2)), 'target=', Number(capEnd.toFixed(2)));
          seekTo(Math.max(0, Math.min(cursor, capEnd - 1)));
          try { await playWithTimeout(v, 2_000); } catch (e) {}
          lastAdvanceAt = Date.now();
          lastMediaAt = Date.now();
          continue;
        }
        if (stalledForMs >= 60_000) {
          const ranges = [];
          for (let i = 0; i < v.buffered.length; i++) {
            ranges.push([Number(v.buffered.start(i).toFixed(3)), Number(v.buffered.end(i).toFixed(3))]);
          }
          const stallDetails = {
            videoId: capId,
            format: isMp3 ? 'mp3' : 'video',
            cursor: Number(cursor.toFixed(3)),
            target: Number(capEnd.toFixed(3)),
            currentTime: Number(v.currentTime.toFixed(3)),
            readyState: v.readyState,
            networkState: v.networkState,
            buffered: ranges,
            audioSourceBuffers: liveSourceBuffers('audio').length,
            videoSourceBuffers: liveSourceBuffers('video').length,
            audioParts: store.tracks.audio?.parts?.length || 0,
            videoParts: store.tracks.video?.parts?.length || 0,
            lastAudioAppendAgoMs: store.lastAppendAt.audio ? now - store.lastAppendAt.audio : null,
            lastVideoAppendAgoMs: store.lastAppendAt.video ? now - store.lastAppendAt.video : null,
          };
          log('capture-stall', JSON.stringify(stallDetails));
          const error = new Error(`нет новых медиаданных более 60 секунд (${cursor.toFixed(1)} из ${capEnd.toFixed(1)} сек)`);
          if (freshMseRestarted) error.novaSkipSequential = true;
          error.details = stallDetails;
          throw error;
        }
      }
    } finally {
      if (playbackDriven) {
        deliberatePlaybackDepth = Math.max(0, deliberatePlaybackDepth - 1);
        try { v.pause(); } catch (e) {}
      }
      // Restore the user's exact position and play state immediately.
      store.capturing = false;
      releasePlaybackHold();
      restoreMediaState();
    }
    if (!capturedTrackHasMedia('audio')) throw new Error('не удалось захватить аудио; обновите вкладку и повторите загрузку');
    if (needVideo && !capturedTrackHasMedia('video')) throw new Error('не удалось захватить видео; обновите вкладку и повторите загрузку');
    const trackStats = Object.fromEntries(['audio', 'video'].map((kind) => {
      const track = store.tracks[kind];
      return [kind, track ? {
        parts: track.parts.length,
        bytes: track.parts.reduce((total, part) => total + part.length, 0),
        duplicatesSkipped: track.duplicates || 0,
        revision: store.trackRevision[kind],
        firstMediaTime: Number.isFinite(track.firstMediaTime) ? Number(track.firstMediaTime.toFixed(3)) : null,
        lastMediaTime: Number.isFinite(track.lastMediaTime) ? Number(track.lastMediaTime.toFixed(3)) : null,
      } : null];
    }));
    if (needVideo && trackStats.video.bytes * 8 < trackStats.audio.bytes) {
      const error = new Error('видеодорожка подозрительно мала относительно аудио; файл не сохранён во избежание зависших кадров');
      if (freshMseRestarted) error.novaSkipSequential = true;
      error.details = { duration: capEnd, tracks: trackStats };
      throw error;
    }
    if (needVideo) {
      const firstVideoTime = Number(trackStats.video.firstMediaTime) || 0;
      const lastVideoTime = Number(trackStats.video.lastMediaTime) || 0;
      if (firstVideoTime > 5 && lastVideoTime - firstVideoTime < capEnd * 0.5) {
        const error = new Error('получен только конечный фрагмент видеодорожки; требуется повторный MSE-проход от начала');
        if (freshMseRestarted) error.novaSkipSequential = true;
        error.details = { duration: capEnd, tracks: trackStats };
        throw error;
      }
    }
    reportCaptureProgress(capEnd);
    log('capture', 'complete', JSON.stringify({ end: cursor, target: capEnd, tracks: trackStats }));
    return { actualHeight: store.tracks.video?.height || currentQuality(), duration: capEnd };
  }

  async function refillMissingWebmPrefix(kind, firstTimecode, onProgress, options = {}) {
    const media = video();
    if (!media) throw new Error('video element not found');
    const requestedVideoId = vidId();
    const pairCompanion = Boolean(options.pairCompanion);
    // With options.mp4Track set, the same removal/prime/nudge machinery runs
    // for an fMP4 track; only the success check differs (tfdt decode times
    // instead of WebM cluster coverage).
    const mp4Track = options.mp4Track || null;
    const companionKind = kind === 'audio' ? 'video' : 'audio';
    const duration = Number(media.duration) || Number(player()?.getDuration?.()) || 0;
    const missingPrefixSeconds = firstTimecode / 1000;
    const prefixEnd = Math.min(duration || Infinity, Math.max(8, missingPrefixSeconds + 5));
    const completedTailShare = duration > 0
      ? Math.max(0, Math.min(0.999, (duration - missingPrefixSeconds) / duration))
      : 0.9;
    const previousCapturing = store.capturing;
    const previous = {
      paused: media.paused,
      time: Number(media.currentTime) || 0,
      muted: media.muted,
      rate: media.playbackRate,
    };
    const seekTo = (seconds) => {
      try {
        const p = player();
        if (p?.seekTo) {
          p.seekTo(seconds, true);
          return;
        }
      } catch (e) {}
      try { media.currentTime = seconds; } catch (e) {}
    };
    const targetBufferedEndFromZero = () => {
      let bestEdge = 0;
      let buffers = liveSourceBuffers(kind);
      if (!buffers.length && liveSourceBuffers(kind, false).length === 1) {
        buffers = liveSourceBuffers(kind, false);
      }
      for (const sourceBuffer of buffers) {
        let edge = 0;
        try {
          for (let index = 0; index < sourceBuffer.buffered.length; index++) {
            if (sourceBuffer.buffered.start(index) <= edge + 0.75
              && sourceBuffer.buffered.end(index) > edge) {
              edge = sourceBuffer.buffered.end(index);
            }
          }
        } catch (e) {}
        bestEdge = Math.max(bestEdge, edge);
      }
      return bestEdge;
    };

    const partCountBefore = store.tracks[kind]?.parts?.length || 0;
    let removed = false;
    let companionRemoved = false;
    store.capturing = false;
    try {
      removed = await removeTrackPrefixForCapture(kind, prefixEnd);
      if (!removed && liveSourceBuffers(kind, false).length === 1) {
        removed = await removeTrackPrefixForCapture(kind, prefixEnd, false);
      }
      if (pairCompanion) {
        companionRemoved = await removeTrackPrefixForCapture(companionKind, prefixEnd);
        if (!companionRemoved && liveSourceBuffers(companionKind, false).length === 1) {
          companionRemoved = await removeTrackPrefixForCapture(
            companionKind, prefixEnd, false,
          );
        }
      }
    } finally {
      store.capturing = true;
    }

    const appendBefore = store.lastAppendAt[kind] || 0;
    let observedAppendAt = appendBefore;
    let cursor = 0;
    let lastActivityAt = Date.now();
    let companionNudged = pairCompanion && companionRemoved;
    const deadline = Date.now() + 45_000;
    const primePrefixRequest = async (label, position = 0) => {
      seekTo(Math.max(0, Math.min(position, prefixEnd - 0.1)));
      try { media.playbackRate = 1; } catch (e) {}
      const primeDeadline = Date.now() + 3_000;
      try { await playWithTimeout(media, 1_500); } catch (e) {}
      while ((store.lastAppendAt[kind] || 0) <= observedAppendAt
        && Date.now() < primeDeadline) {
        await sleep(75);
      }
      try { media.pause(); } catch (e) {}
      const appendObserved = (store.lastAppendAt[kind] || 0) > observedAppendAt;
      if (appendObserved) {
        observedAppendAt = store.lastAppendAt[kind];
        lastActivityAt = Date.now();
      }
      log('capture', 'targeted WebM request primer; kind=', kind,
        'stage=', label, 'appendObserved=', appendObserved);
      return appendObserved;
    };
    try {
      try { media.muted = true; } catch (e) {}
      seekTo(Math.min(prefixEnd + 1, Math.max(0, duration - 0.1)));
      await sleep(120);
      seekTo(0);
      log('capture', 'targeted WebM prefix refill; kind=', kind, 'firstMs=', firstTimecode,
        'prefixEnd=', prefixEnd, 'removed=', removed,
        'paired=', pairCompanion, 'companionRemoved=', companionRemoved);
      await primePrefixRequest('target');
      while (Date.now() < deadline) {
        await sleep(350);
        throwIfDownloadCancelled();
        if (vidId() !== requestedVideoId) throw new Error('видео переключилось');
        if (store.captureError) throw store.captureError;
        try { if (!media.paused) media.pause(); } catch (e) {}

        const appendAt = store.lastAppendAt[kind] || 0;
        if (appendAt > observedAppendAt) {
          observedAppendAt = appendAt;
          lastActivityAt = Date.now();
        }
        const edge = targetBufferedEndFromZero();
        const newParts = store.tracks[kind]?.parts?.slice(partCountBefore) || [];
        let covered = false;
        let capturedEdgeSeconds = 0;
        let coverageInfo = null;
        if (mp4Track) {
          let minDecode = null;
          let maxDecode = null;
          for (const part of newParts) {
            const decodeTime = mp4FragmentDecodeTime(part, 0, part.length);
            if (decodeTime !== null && Number.isFinite(decodeTime)) {
              minDecode = minDecode === null ? decodeTime : Math.min(minDecode, decodeTime);
              maxDecode = maxDecode === null ? decodeTime : Math.max(maxDecode, decodeTime);
            }
          }
          covered = minDecode !== null && minDecode <= 0;
          const unitsPerSecond = missingPrefixSeconds > 0
            ? Number(mp4Track.firstDecodeTime) / missingPrefixSeconds
            : 0;
          capturedEdgeSeconds = maxDecode !== null && unitsPerSecond > 0
            ? Math.min(missingPrefixSeconds, maxDecode / unitsPerSecond)
            : 0;
          coverageInfo = { minDecode, maxDecode, newParts: newParts.length };
        } else {
          const coverageToleranceMs = kind === 'audio' ? 500 : 2_500;
          const coverage = webmPartsCoverage(newParts, 0, firstTimecode, coverageToleranceMs);
          covered = coverage.covered;
          capturedEdgeSeconds = Math.max(0, Number(coverage.lastBlockMs) || 0) / 1000;
          coverageInfo = coverage;
        }
        const repairedPrefixShare = Math.min(
          1,
          capturedEdgeSeconds / Math.max(0.001, missingPrefixSeconds),
        );
        onProgress?.(Math.min(0.999,
          completedTailShare + ((1 - completedTailShare) * repairedPrefixShare)));
        if (appendAt > appendBefore && covered) {
          log('capture', 'targeted prefix refill complete; kind=', kind,
            'container=', mp4Track ? 'mp4' : 'webm',
            'sourceBufferEdge=', edge, 'coverage=', JSON.stringify(coverageInfo));
          return;
        }
        if (capturedEdgeSeconds > cursor + 0.1) {
          // Real captured progress: follow the verified edge and keep the
          // request alive.
          cursor = Math.min(prefixEnd - 0.1, capturedEdgeSeconds);
          lastActivityAt = Date.now();
          seekTo(Math.max(0, Math.min(cursor, prefixEnd - 0.1)));
        } else {
          // Nothing new was captured yet. Nudge the player slightly ahead but
          // do NOT commit the cursor: committing it on every idle iteration
          // walked the seek position across the whole missing prefix in a few
          // seconds, so YouTube was asked for segments after the hole and the
          // prefix was replaced by partial/aborted segments instead.
          seekTo(Math.max(0, Math.min(cursor + 0.5, prefixEnd - 0.1)));
        }
        if (!companionNudged && Date.now() - lastActivityAt >= 3_000) {
          // Some SABR sessions do not request a missing audio-only/video-only
          // range while the companion SourceBuffer still covers that position.
          // Open the same small hole in the companion buffer to make the player
          // request a paired segment. Captured bytes remain untouched.
          const companionKind = kind === 'audio' ? 'video' : 'audio';
          store.capturing = false;
          let companionRemoved = false;
          try {
            companionRemoved = await removeTrackPrefixForCapture(companionKind, prefixEnd);
            if (!companionRemoved && liveSourceBuffers(companionKind, false).length === 1) {
              companionRemoved = await removeTrackPrefixForCapture(companionKind, prefixEnd, false);
            }
          } finally {
            store.capturing = true;
          }
          companionNudged = true;
          lastActivityAt = Date.now();
          seekTo(Math.min(prefixEnd + 1, Math.max(0, duration - 0.1)));
          await sleep(120);
          seekTo(0);
          log('capture', 'targeted WebM paired-prefix nudge; target=', kind,
            'companion=', companionKind, 'removed=', companionRemoved);
          await primePrefixRequest('paired');
          continue;
        }
        if (Date.now() - lastActivityAt >= 20_000) break;
      }
      throw new Error(`YouTube не отдал начало ${kind === 'audio' ? 'аудио' : 'видео'}дорожки`);
    } finally {
      store.capturing = previousCapturing;
      restoreMediaMuted(media, previous.muted);
      try { media.playbackRate = previous.rate; } catch (e) {}
      seekTo(previous.time);
      if (previous.paused) {
        try { media.pause(); } catch (e) {}
      } else {
        try { media.play()?.catch?.(() => {}); } catch (e) {}
      }
    }
  }

  async function refillMissingWebmTail(kind, details, onProgress, options = {}) {
    const media = video();
    if (!media) throw new Error('video element not found');
    const requestedVideoId = vidId();
    const duration = (Number(details?.expectedEndMs) || 0) / 1000
      || Number(media.duration) || Number(player()?.getDuration?.()) || 0;
    const lastTimecode = Number(details?.lastTimecode) || 0;
    const attempt = Math.max(0, Number(options.attempt) || 0);
    const clusterSeconds = Math.max(1, (Number(details?.typicalDelta) || 3_000) / 1000);
    const refillStart = Math.max(
      0,
      (lastTimecode / 1000) - Math.min(8, 1 + attempt * Math.max(1, clusterSeconds)),
    );
    const previousCapturing = store.capturing;
    const previous = {
      paused: media.paused,
      time: Number(media.currentTime) || 0,
      muted: media.muted,
      rate: media.playbackRate,
    };
    const seekTo = (seconds) => {
      try {
        const activePlayer = player();
        if (activePlayer?.seekTo) {
          activePlayer.seekTo(seconds, true);
          return;
        }
      } catch (e) {}
      try { media.currentTime = seconds; } catch (e) {}
    };

    let removed = false;
    store.capturing = false;
    try {
      removed = await removeTrackRangeForCapture(kind, refillStart, duration + 1);
      if (!removed && liveSourceBuffers(kind, false).length === 1) {
        removed = await removeTrackRangeForCapture(kind, refillStart, duration + 1, false);
      }
    } finally {
      store.capturing = true;
    }

    const appendBefore = store.lastAppendAt[kind] || 0;
    let observedAppendAt = appendBefore;
    let cursor = refillStart;
    let lastActivityAt = Date.now();
    let companionNudged = false;
    const deadline = Date.now() + 35_000 + Math.min(20_000, attempt * 10_000);
    const primeTailRequest = async (label) => {
      seekTo(Math.min(refillStart + 0.05, Math.max(0, duration - 0.1)));
      try { media.playbackRate = 1; } catch (e) {}
      const primeDeadline = Date.now() + 3_000;
      try { await playWithTimeout(media, 1_500); } catch (e) {}
      while ((store.lastAppendAt[kind] || 0) <= observedAppendAt
        && Date.now() < primeDeadline) {
        await sleep(75);
      }
      try { media.pause(); } catch (e) {}
      const appendObserved = (store.lastAppendAt[kind] || 0) > observedAppendAt;
      if (appendObserved) {
        observedAppendAt = store.lastAppendAt[kind];
        lastActivityAt = Date.now();
      }
      log('capture', 'targeted WebM tail primer; kind=', kind,
        'stage=', label, 'appendObserved=', appendObserved);
    };

    try {
      try { media.muted = true; } catch (e) {}
      log('capture', 'targeted WebM tail refill; kind=', kind,
        'lastMs=', lastTimecode, 'start=', refillStart, 'target=', duration,
        'attempt=', attempt + 1, 'removed=', removed);
      await primeTailRequest('target');
      while (Date.now() < deadline) {
        await sleep(250);
        throwIfDownloadCancelled();
        if (vidId() !== requestedVideoId) throw new Error('видео переключилось');
        if (store.captureError) throw store.captureError;
        try { if (!media.paused) media.pause(); } catch (e) {}

        const appendAt = store.lastAppendAt[kind] || 0;
        if (appendAt > observedAppendAt) {
          observedAppendAt = appendAt;
          lastActivityAt = Date.now();
        }
        const edge = bufferedEdgeForTrack(kind, refillStart);
        onProgress?.(Math.min(0.999, edge / Math.max(0.001, duration)));
        if (appendAt > appendBefore && edge >= duration - 1) {
          log('capture', 'targeted WebM tail complete; kind=', kind, 'edge=', edge);
          return;
        }
        if (edge > cursor + 0.3) {
          cursor = edge;
          lastActivityAt = Date.now();
          seekTo(Math.min(cursor, duration - 0.1));
        } else {
          seekTo(Math.min(cursor + 0.5, duration - 0.1));
        }

        if (!companionNudged && Date.now() - lastActivityAt >= 3_000) {
          const companionKind = kind === 'audio' ? 'video' : 'audio';
          store.capturing = false;
          let companionRemoved = false;
          try {
            companionRemoved = await removeTrackRangeForCapture(
              companionKind, refillStart, duration + 1,
            );
            if (!companionRemoved && liveSourceBuffers(companionKind, false).length === 1) {
              companionRemoved = await removeTrackRangeForCapture(
                companionKind, refillStart, duration + 1, false,
              );
            }
          } finally {
            store.capturing = true;
          }
          companionNudged = true;
          log('capture', 'targeted WebM paired-tail nudge; target=', kind,
            'companion=', companionKind, 'removed=', companionRemoved);
          await primeTailRequest('paired');
          continue;
        }
        if (Date.now() - lastActivityAt >= 15_000) break;
      }
      throw new Error(`YouTube не отдал конец ${kind === 'audio' ? 'аудио' : 'видео'}дорожки`);
    } finally {
      store.capturing = previousCapturing;
      restoreMediaMuted(media, previous.muted);
      try { media.playbackRate = previous.rate; } catch (e) {}
      seekTo(previous.time);
      if (previous.paused) {
        try { media.pause(); } catch (e) {}
      } else {
        try { media.play()?.catch?.(() => {}); } catch (e) {}
      }
    }
  }

  async function refillMissingWebmInterior(details, onProgress, options = {}) {
    const media = video();
    if (!media) throw new Error('video element not found');
    const requestedVideoId = vidId();
    const duration = (Number(details?.expectedEndMs) || 0) / 1000
      || Number(media.duration) || Number(player()?.getDuration?.()) || 0;
    const gapStart = (Number(details?.gapStartMs) || 0) / 1000;
    const gapEnd = (Number(details?.gapEndMs) || 0) / 1000;
    if (!(duration > 0 && gapStart >= 0 && gapEnd > gapStart && gapEnd <= duration + 1)) {
      // Deterministic: the same bounds will be rejected on every retry. Marked
      // so the caller can stop instead of burning its whole attempt budget.
      const boundsError = new Error('неверные границы пропущенного медиасегмента'
        + ` (${details?.gapStartMs} → ${details?.gapEndMs} мс при длительности ${duration.toFixed(1)} с)`);
      boundsError.novaUnrepairable = true;
      throw boundsError;
    }

    const attempt = Math.max(0, Number(options.attempt) || 0);
    const targetKind = details?.kind === 'video' ? 'video' : 'audio';
    // Include increasingly wide adjacent segment boundaries so SABR cannot
    // satisfy a retry from a partly cached fragment without re-emitting the
    // missing bytes. The first pass touches only the broken track; later passes
    // open the same bounded hole in its companion when YouTube couples them.
    const padding = Math.max(
      1 + attempt,
      Math.min(8, (gapEnd - gapStart) * (0.35 + attempt * 0.35)),
    );
    const refillStart = Math.max(0, gapStart - padding);
    const refillEnd = Math.min(duration, gapEnd + padding);
    const requiredKinds = [targetKind];
    const companionKind = targetKind === 'audio' ? 'video' : 'audio';
    const companionBuffers = liveSourceBuffers(companionKind);
    const allCompanionBuffers = liveSourceBuffers(companionKind, false);
    const hasUsableCompanionBuffer = companionBuffers.length > 0
      || allCompanionBuffers.length === 1;
    if (attempt > 0 && !options.targetOnly
      && hasUsableCompanionBuffer) {
      requiredKinds.push(companionKind);
    }
    const previousCapturing = store.capturing;
    const previous = {
      paused: media.paused,
      time: Number(media.currentTime) || 0,
      muted: media.muted,
      rate: media.playbackRate,
    };
    const seekTo = (seconds) => {
      try {
        const activePlayer = player();
        if (activePlayer?.seekTo) {
          activePlayer.seekTo(seconds, true);
          return;
        }
      } catch (e) {}
      try { media.currentTime = seconds; } catch (e) {}
    };
    const appendBefore = Object.fromEntries(requiredKinds.map(
      (kind) => [kind, store.lastAppendAt[kind] || 0],
    ));
    const capturedBytesFor = (kind) => {
      const track = store.tracks[kind];
      if (!track) return 0;
      return Number(track.capturedBytes)
        || track.parts?.reduce((total, part) => total + (part?.length || 0), 0)
        || 0;
    };
    const capturedBytesBefore = Object.fromEntries(requiredKinds.map(
      (kind) => [kind, capturedBytesFor(kind)],
    ));
    const partCountsBefore = Object.fromEntries(requiredKinds.map(
      (kind) => [kind, store.tracks[kind]?.parts?.length || 0],
    ));
    const removed = Object.create(null);
    if (store.gapRefillActive) throw new Error('докачка медиасегмента уже выполняется');
    store.gapRefillActive = true;
    const timeoutMs = Math.max(
      5_000,
      Number(options.timeoutMs) || (30_000 + Math.min(20_000, attempt * 10_000)),
    );
    const idleTimeoutMs = Math.max(3_000, Number(options.idleTimeoutMs) || 12_000);
    const deadline = Date.now() + timeoutMs;

    try {
      try { media.pause(); } catch (e) {}
      const safeTime = refillEnd + 2 < duration
        ? refillEnd + 2 : Math.max(0, refillStart - 2);
      seekTo(safeTime);
      await sleep(120);
      store.capturing = false;
      try {
        for (const kind of requiredKinds) {
          removed[kind] = await removeTrackRangeForCapture(kind, refillStart, refillEnd);
          if (!removed[kind] && liveSourceBuffers(kind, false).length === 1) {
            removed[kind] = await removeTrackRangeForCapture(
              kind, refillStart, refillEnd, false,
            );
          }
        }
      } finally {
        store.capturing = true;
      }
      if (Date.now() >= deadline) throw new Error('истёк тайм-аут подготовки докачки');

      let cursor = refillStart;
      let lastActivityAt = Date.now();
      let observedTargetBytes = capturedBytesBefore[targetKind];
      let primerCount = 0;
      const primeRequest = async () => {
        primerCount += 1;
        seekTo(Math.min(refillStart + 0.05, Math.max(0, duration - 0.1)));
        try { media.playbackRate = 1; } catch (e) {}
        try { await playWithTimeout(media, 1_500); } catch (e) {}
        const primeDeadline = Math.min(deadline, Date.now() + 2_500);
        while (Date.now() < primeDeadline
          && requiredKinds.every((kind) => (
            (store.lastAppendAt[kind] || 0) <= appendBefore[kind]
          ))) {
          await sleep(75);
        }
        try { media.pause(); } catch (e) {}
      };

      try { media.muted = true; } catch (e) {}
      log('capture', 'targeted WebM interior refill; gap=', [gapStart, gapEnd],
        'range=', [refillStart, refillEnd], 'attempt=', attempt + 1,
        'target=', targetKind, 'required=', requiredKinds,
        'removed=', JSON.stringify(removed));
      await primeRequest();
      while (Date.now() < deadline) {
        await sleep(250);
        throwIfDownloadCancelled();
        if (vidId() !== requestedVideoId) throw new Error('видео переключилось');
        if (store.captureError) throw store.captureError;
        try { if (!media.paused) media.pause(); } catch (e) {}

        const currentTargetBytes = capturedBytesFor(targetKind);
        if (currentTargetBytes > observedTargetBytes) {
          observedTargetBytes = currentTargetBytes;
          lastActivityAt = Date.now();
        }
        const edge = bufferedEdgeForTrack(targetKind, refillStart);
        const localProgress = Math.max(0, Math.min(
          1, (edge - refillStart) / Math.max(0.001, refillEnd - refillStart),
        ));
        onProgress?.(Math.min(0.994, 0.97 + (localProgress * 0.024)));
        const targetAppended = (store.lastAppendAt[targetKind] || 0) > appendBefore[targetKind];
        const targetBytesAdded = currentTargetBytes > capturedBytesBefore[targetKind];
        const coverage = webmPartsCoverage(
          store.tracks[targetKind]?.parts?.slice(partCountsBefore[targetKind]) || [],
          gapStart * 1000,
          gapEnd * 1000,
          500,
        );
        if (targetAppended && targetBytesAdded && coverage.covered) {
          log('capture', 'targeted WebM interior refill complete; edge=', edge,
            'coverage=', JSON.stringify(coverage),
            'appended=', JSON.stringify(Object.fromEntries(requiredKinds.map((kind) => [kind, {
              observed: (store.lastAppendAt[kind] || 0) > appendBefore[kind],
              bytesAdded: Math.max(0, capturedBytesFor(kind) - capturedBytesBefore[kind]),
            }]))));
          return;
        }

        const capturedEdgeSeconds = Number(coverage.lastBlockMs) / 1000;
        if (Number.isFinite(capturedEdgeSeconds)
          && capturedEdgeSeconds >= refillStart
          && capturedEdgeSeconds > cursor + 0.1) {
          cursor = Math.min(refillEnd - 0.1, capturedEdgeSeconds);
          lastActivityAt = Date.now();
        } else {
          cursor = Math.min(refillEnd - 0.1, cursor + 0.5);
        }
        seekTo(Math.max(refillStart, Math.min(cursor, refillEnd - 0.1)));
        if (primerCount < 2 && Date.now() - lastActivityAt >= 4_000) {
          await primeRequest();
          lastActivityAt = Date.now();
        }
        if (Date.now() - lastActivityAt >= idleTimeoutMs) break;
      }
      throw new Error('YouTube не отдал пропущенный внутренний медиасегмент');
    } finally {
      store.capturing = previousCapturing;
      store.gapRefillActive = false;
      restoreMediaMuted(media, previous.muted);
      try { media.playbackRate = previous.rate; } catch (e) {}
      seekTo(previous.time);
      if (previous.paused) {
        try { media.pause(); } catch (e) {}
      } else {
        try { media.play()?.catch?.(() => {}); } catch (e) {}
      }
    }
  }

  async function recoverVideoPrefixWithRenderedCapture(details, options, onProgress) {
    const track = store.tracks.video;
    const firstTimecode = Number(details?.firstTimecode);
    const duration = Number(video()?.duration) || Number(player()?.getDuration?.()) || 0;
    const prefixEnd = Math.min(duration || Infinity, Math.max(8, (firstTimecode / 1000) + 1.5));
    const targetHeight = Number(track?.height) || Number(options?.requestedHeight) || null;
    log('assembly', 'MSE video prefix unavailable; recording only missing prefix',
      'firstMs=', firstTimecode, 'prefixEnd=', prefixEnd, 'height=', targetHeight);
    const rendered = await withDeliberatePlayback(() => captureRenderedVideo({
      targetQ: options?.targetQ || QUALITY_BY_HEIGHT[targetHeight] || 'hd720',
      end: prefixEnd,
      height: targetHeight,
    }, (pct) => onProgress?.(
      Math.min(0.999, 0.9 + (Math.max(0, Math.min(1, pct)) * 0.099)),
      'rendered-prefix',
    )));
    const renderedVideo = rendered?.video;
    if (!renderedVideo?.bytes?.length || !/webm/i.test(renderedVideo.mime || '')) {
      throw new Error('резервная запись не создала WebM-префикс видеодорожки');
    }
    if (targetHeight && Number(rendered.actualHeight) && Number(rendered.actualHeight) !== targetHeight) {
      throw new Error(`префикс записан в ${rendered.actualHeight}p вместо ${targetHeight}p`);
    }
    const codecFamily = (mime) => {
      const codec = String(mime || '').match(/codecs?\s*=\s*"?([^";,\s]+)/i)?.[1]?.toLowerCase() || '';
      if (codec === 'vp09') return 'vp9';
      if (codec.startsWith('vp09.')) return 'vp9';
      return codec;
    };
    const targetCodec = codecFamily(track?.mime);
    const renderedCodec = codecFamily(renderedVideo.mime);
    if (targetCodec && renderedCodec && targetCodec !== renderedCodec) {
      throw new Error(`кодек префикса ${renderedCodec} не совпадает с дорожкой ${targetCodec}`);
    }
    const boundarySeconds = firstTimecode / 1000;
    log('assembly', 'rendered video prefix ready for FFmpeg concat; capturedSeconds=',
      prefixEnd, 'boundarySeconds=', boundarySeconds, 'bytes=', renderedVideo.bytes.length);
    return {
      videoPrefix: {
        bytes: renderedVideo.bytes,
        mime: renderedVideo.mime,
        height: Number(rendered.actualHeight) || targetHeight,
      },
      boundarySeconds,
    };
  }

  // Bounded head repair for fMP4 tracks. The missing length is estimated from
  // the fragment cadence (firstDecodeTime / normalDelta fragments of ~10 s
  // each); the removal + paired-nudge + primer machinery is shared with the
  // WebM prefix refill, which handles SABR reliably in the field.
  async function refillMissingMp4Prefix(kind, details, onProgress) {
    const normalDelta = Number(details.normalDelta) || 0;
    const firstDecodeTime = Number(details.firstDecodeTime) || 0;
    const missingFragments = normalDelta > 0
      ? Math.max(1, Math.round(firstDecodeTime / normalDelta))
      : 3;
    const firstTimecodeMs = missingFragments * 10_000;
    return refillMissingWebmPrefix(kind, firstTimecodeMs, onProgress, {
      pairCompanion: true,
      mp4Track: { firstDecodeTime },
    });
  }

  async function captureBackgroundSequentialReset(opts, onProgress) {
    const isMp3 = opts.isMp3;
    const needVideo = !isMp3;
    const targetQ = opts.targetQ;
    const capId = vidId();
    let v = video();
    if (!v) throw new Error('video element not found');

    let duration = Number(v.duration) || 0;
    if (!duration) {
      const deadline = Date.now() + 4_000;
      while (!duration && Date.now() < deadline) {
        await sleep(100);
        duration = Number(v.duration) || Number(player()?.getDuration?.()) || 0;
      }
    }
    if (!duration) throw new Error('duration unknown');
    const capEnd = Math.min(Number(opts.end) > 0 ? Number(opts.end) : duration, duration);
    const endTolerance = Math.min(0.15, capEnd * 0.001);

    if (store.captureError) throw store.captureError;
    store.capturing = true;
    keepAutoplayOff();
    const previousHeight = currentQuality();
    const previous = {
      paused: v.paused,
      rate: v.playbackRate,
      time: Number(v.currentTime) || 0,
      muted: v.muted,
    };
    const seekTo = (seconds) => {
      try {
        const p = player();
        if (p?.seekTo) {
          p.seekTo(seconds, true);
          return;
        }
      } catch (e) {}
      try { v.currentTime = seconds; } catch (e) {}
    };
    const restoreMediaState = () => {
      try { v.playbackRate = previous.rate; } catch (e) {}
      seekTo(previous.time);
      restoreMediaMuted(v, previous.muted);
      if (previous.paused) {
        try { v.pause(); } catch (e) {}
      } else {
        try { v.play()?.catch?.(() => {}); } catch (e) {}
      }
    };
    const bufferedEndFrom = (position) => {
      let edge = Math.max(0, Number(position) || 0);
      try {
        for (let index = 0; index < v.buffered.length; index++) {
          if (v.buffered.start(index) <= edge + 0.75 && v.buffered.end(index) > edge) {
            edge = v.buffered.end(index);
          }
        }
      } catch (e) {}
      return edge;
    };

    const captureSequentialTrack = async (kind, progressStart, progressSpan) => {
      if (store.captureError) throw store.captureError;
      if (vidId() !== capId) throw new Error('видео переключилось');
      try { v.pause(); } catch (e) {}
      try { v.muted = true; } catch (e) {}

      const allBuffers = liveSourceBuffers(kind, false);
      if (allBuffers.length) adoptAttachedInitForCapture(kind, allBuffers, capId);
      const currentBuffers = liveSourceBuffers(kind);
      const selectedBuffers = currentBuffers.length ? currentBuffers : allBuffers;
      if (!selectedBuffers.length) {
        throw new Error(`MSE-${kind === 'audio' ? 'аудио' : 'видео'}поток не найден`);
      }
      const hadBufferedData = selectedBuffers.some((sourceBuffer) => {
        try { return sourceBuffer.buffered?.length > 0; } catch (e) { return false; }
      });

      let cleared = false;
      store.capturing = false;
      try {
        cleared = await resetTrackBufferForCapture(kind);
        if (!cleared && allBuffers.length === 1) {
          cleared = await resetTrackBufferForCapture(kind, false);
        }
        if (hadBufferedData && !cleared) {
          throw new Error(`не удалось подготовить ${kind === 'audio' ? 'аудио' : 'видео'}буфер для прохода от начала`);
        }
        delete store.tracks[kind];
        delete store._pendingInit[kind];
        store.lastAppendAt[kind] = 0;
      } finally {
        store.capturing = true;
      }

      seekTo(0);
      // Everything below replays the video for this one track; the companion is
      // already captured and must not grow while it happens.
      store.singleTrackPass = kind;
      log('capture', 'sequential MSE track pass; kind=', kind, 'cleared=', cleared,
        'buffers=', selectedBuffers.length, 'target=', capEnd);

      let cursor = 0;
      let lastAdvanceAt = Date.now();
      let lastMediaAt = Date.now();
      let observedAppendAt = 0;
      let acceptedRevision = null;
      let playbackDriven = false;
      try {
      while (true) {
        await sleep(350);
        if (store.captureError) throw store.captureError;
        throwIfDownloadCancelled();
        if (vidId() !== capId) throw new Error('видео переключилось');
        try { if (!v.paused && !playbackDriven) v.pause(); } catch (e) {}

        const now = Date.now();
        const appendAt = store.lastAppendAt[kind] || 0;
        if (appendAt > observedAppendAt) {
          observedAppendAt = appendAt;
          lastMediaAt = now;
        }
        const track = store.tracks[kind];
        if (track && acceptedRevision === null) acceptedRevision = store.trackRevision[kind];
        if (track && acceptedRevision !== store.trackRevision[kind]) {
          const error = new Error(`YouTube сменил ${kind === 'audio' ? 'аудио' : 'видео'}поток во время загрузки`);
          error.details = { kind, before: acceptedRevision, after: store.trackRevision[kind] };
          throw error;
        }

        const edge = bufferedEndFrom(cursor);
        const fraction = Math.min(0.99, Math.max(cursor, edge) / capEnd);
        onProgress(progressStart + progressSpan * fraction);
        if (track?.parts?.length > 1 && edge >= capEnd - endTolerance) {
          track.sequentialFromZero = true;
          track.sequentialEnd = edge;
          break;
        }

        if (playbackDriven) {
          if (edge > cursor + 0.3) {
            cursor = edge;
            lastAdvanceAt = now;
          }
          if (v.paused && !v.ended) {
            try { await playWithTimeout(v, 2_000); } catch (e) {}
          }
          const skipTarget = Math.min(edge - 1, capEnd - 0.1);
          if (Number.isFinite(skipTarget) && skipTarget > (Number(v.currentTime) || 0) + 6) {
            seekTo(skipTarget);
          }
        } else if (edge > cursor + 0.3) {
          cursor = edge;
          lastAdvanceAt = now;
          seekTo(Math.min(cursor, capEnd - 0.1));
        } else {
          seekTo(Math.min(cursor + 0.5, capEnd - 0.1));
        }

        const stalledForMs = now - Math.max(lastAdvanceAt, lastMediaAt);
        if (!playbackDriven && stalledForMs >= CAPTURE_IDLE_ESCALATION_MS) {
          // Same rescue as the fast pass: real muted playback restarts SABR
          // delivery when the paused-seek pattern is being ignored.
          playbackDriven = true;
          deliberatePlaybackDepth += 1;
          log('capture', `sequential paused seeks idle for ${Math.round(stalledForMs / 1000)}s`
            + ` (threshold ${Math.round(CAPTURE_IDLE_ESCALATION_MS / 1000)}s);`
            + ' escalating to muted playback-driven capture; kind=',
            kind, 'cursor=', Number(cursor.toFixed(2)));
          seekTo(Math.max(0, Math.min(cursor, capEnd - 1)));
          try { await playWithTimeout(v, 2_000); } catch (e) {}
          lastAdvanceAt = Date.now();
          lastMediaAt = Date.now();
          continue;
        }
        if (stalledForMs >= 60_000) {
          const ranges = [];
          try {
            for (let index = 0; index < v.buffered.length; index++) {
              ranges.push([
                Number(v.buffered.start(index).toFixed(3)),
                Number(v.buffered.end(index).toFixed(3)),
              ]);
            }
          } catch (e) {}
          const details = {
            videoId: capId,
            kind,
            cursor: Number(cursor.toFixed(3)),
            target: Number(capEnd.toFixed(3)),
            currentTime: Number((Number(v.currentTime) || 0).toFixed(3)),
            buffered: ranges,
            parts: track?.parts?.length || 0,
            lastAppendAgoMs: appendAt ? now - appendAt : null,
          };
          const error = new Error(`${kind === 'audio' ? 'аудио' : 'видео'}поток не получал новых сегментов более 60 секунд`);
          error.details = details;
          throw error;
        }
      }
      } finally {
        store.singleTrackPass = null;
        if (playbackDriven) {
          deliberatePlaybackDepth = Math.max(0, deliberatePlaybackDepth - 1);
          try { v.pause(); } catch (e) {}
        }
      }

      const completedTrack = store.tracks[kind];
      if (!completedTrack?.sequentialFromZero || completedTrack.parts.length < 2) {
        throw new Error(`${kind === 'audio' ? 'аудио' : 'видео'}дорожка не собрана от начала`);
      }
      return completedTrack;
    };

    let reusedCompleteAudio = false;
    try {
      // After a completed MP3 pass, keep its verified audio bytes and rebuild
      // only video. This is substantially faster than downloading audio twice.
      reusedCompleteAudio = needVideo && store.tracks.audio
        && capturedTrackStartSeconds('audio') <= 5
        && (Number(store.tracks.audio.lastMediaTime) >= capEnd - endTolerance
          || bufferedEdgeForTrack('audio', 0) >= capEnd - endTolerance);
      const audioSpan = needVideo && !reusedCompleteAudio ? 0.12 : 0;
      if (!reusedCompleteAudio) {
        await captureSequentialTrack('audio', 0, needVideo ? audioSpan : 1);
      } else {
        log('capture', 'sequential video retry reusing complete audio track');
      }

      if (needVideo) {
        setQualityRaw(targetQ);
        const wantedHeight = Number(opts.height) || 0;
        if (wantedHeight) {
          for (let attempt = 0; attempt < 30; attempt++) {
            if (currentQuality() === wantedHeight) break;
            await sleep(200);
          }
          const actual = currentQuality();
          if (actual && actual !== wantedHeight) {
            log('capture', `requested ${wantedHeight}p but player is on ${actual}p (SABR ignored request)`);
          }
        }
        await captureSequentialTrack('video', audioSpan, 1 - audioSpan);
      }
    } finally {
      store.capturing = false;
      restoreMediaState();
    }

    const audioTrack = store.tracks.audio;
    const videoTrack = needVideo ? store.tracks.video : null;
    if (!audioTrack || (!audioTrack.sequentialFromZero && !reusedCompleteAudio)) {
      throw new Error('аудиодорожка не подтверждена от начала');
    }
    if (needVideo && !videoTrack?.sequentialFromZero) throw new Error('видеодорожка не подтверждена от начала');

    const trackStats = Object.fromEntries(['audio', 'video'].map((kind) => {
      const track = store.tracks[kind];
      return [kind, track ? {
        parts: track.parts.length,
        bytes: track.parts.reduce((total, part) => total + part.length, 0),
        duplicatesSkipped: track.duplicates || 0,
        revision: store.trackRevision[kind],
        sequentialFromZero: Boolean(track.sequentialFromZero),
        sequentialEnd: Number(track.sequentialEnd?.toFixed?.(3)) || null,
      } : null];
    }));
    if (needVideo && trackStats.video.bytes * 8 < trackStats.audio.bytes) {
      const error = new Error('видеодорожка подозрительно мала относительно аудио; файл не сохранён');
      error.details = { duration: capEnd, tracks: trackStats };
      throw error;
    }

    onProgress(1);
    log('capture', 'sequential complete', JSON.stringify({
      target: capEnd,
      tolerance: endTolerance,
      previousHeight,
      tracks: trackStats,
    }));
    return { actualHeight: videoTrack?.height || currentQuality(), duration: capEnd };
  }

  // ---- subtitles ------------------------------------------------------------
  // ---- live stream capture -------------------------------------------------
  // A live recording never accumulates media in page memory: every appended
  // fragment is forwarded through the UI bridge to the offscreen document,
  // which spools it to disk (OPFS). Backfill from the DVR start reuses the
  // playback-driven pattern: muted real playback plus skip-ahead seeks that
  // always stay inside the buffered region, so forwarded bytes stay continuous.
  function forwardLiveAppend(transport, data) {
    const session = store.liveSession;
    try {
      const kind = transport.__novaKind;
      if (!session || session.stopped || (kind !== 'audio' && kind !== 'video')) return;
      // After an SPA navigation the next video's fragments arrive before the
      // capture loop can stop the session; they must never reach the file.
      if (session.videoId && vidId() !== session.videoId) return;
      const u8 = u8of(data);
      if (!u8 || !u8.length) return;
      const track = session.tracks[kind] ||= {
        mime: transport.__novaMime || '',
        initKey: null,
        firstTimecode: null,
        lastTimecode: -Infinity,
        bytes: 0,
        fragments: 0,
      };
      const mime = transport.__novaMime || track.mime || '';
      track.mime ||= mime;
      if (startsWithInit(u8)) {
        const key = fragmentFingerprint(u8);
        if (track.initKey === key) return;
        if (track.initKey) {
          log('live', 'representation changed mid-recording; kind=', kind,
            '- players may need the file remuxed');
        }
        track.initKey = key;
        session.post(kind, u8, track.mime, true);
        return;
      }
      if (!track.initKey) {
        // YouTube reuses attached SourceBuffers without re-appending init when
        // the codec configuration is unchanged; adopt the remembered one — but
        // only if it belongs to the same container. A stale WebM init in front
        // of fMP4 fragments makes the whole track file unreadable.
        const savedInit = transport.__novaLastInit || store._lastInit[kind];
        const boxType = u8.length >= 8 ? String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) : '';
        const looksMp4Fragment = /^(?:ftyp|styp|moof|sidx|emsg|prft|mdat|moov|free|skip)$/.test(boxType);
        const looksWebmFragment = u8[0] === 0x1f && u8[1] === 0x43 && u8[2] === 0xb6 && u8[3] === 0x75;
        const fragmentContainer = looksMp4Fragment ? 'mp4'
          : (looksWebmFragment ? 'webm' : (/mp4/i.test(mime) ? 'mp4' : 'webm'));
        const savedContainer = savedInit?.bytes?.length
          ? (savedInit.bytes[0] === 0x1A ? 'webm' : 'mp4') : '';
        if (!savedInit?.bytes?.length || savedContainer !== fragmentContainer) {
          if (!track.droppedWithoutInit) {
            track.droppedWithoutInit = true;
            log('live', 'dropping fragments until an init segment arrives; kind=', kind,
              'mime=', mime || 'unknown', 'savedInitContainer=', savedContainer || 'none',
              'fragmentContainer=', fragmentContainer);
          }
          return;
        }
        track.initKey = savedInit.initKey || fragmentFingerprint(savedInit.bytes);
        session.post(kind, savedInit.bytes, savedInit.mime || track.mime, true);
      }
      // Keep the forwarded timeline monotonic: stall recovery and small back
      // seeks re-append ranges that are already on disk.
      let timecode = null;
      const looksWebm = /webm/i.test(track.mime)
        || (u8[0] === 0x1f && u8[1] === 0x43 && u8[2] === 0xb6 && u8[3] === 0x75);
      if (looksWebm) {
        for (let offset = 0; offset + 4 <= u8.length; offset++) {
          if (u8[offset] === 0x1f && u8[offset + 1] === 0x43
            && u8[offset + 2] === 0xb6 && u8[offset + 3] === 0x75) {
            timecode = webmClusterTimecode(u8, offset);
            break;
          }
        }
      } else {
        timecode = mp4FragmentDecodeTime(u8, 0, u8.length);
      }
      if (Number.isFinite(timecode) && timecode !== null) {
        if (timecode <= track.lastTimecode) return;
        if (track.firstTimecode == null) track.firstTimecode = timecode;
        track.lastTimecode = timecode;
        track.timecodesAreMs = looksWebm;
      }
      track.bytes += u8.length;
      track.fragments += 1;
      session.post(kind, u8, track.mime, false);
    } catch (e) {}
  }

  async function captureLiveStream({ from }, onProgress) {
    if (store.liveSession) throw new Error('запись эфира уже выполняется');
    const media = video();
    if (!media) throw new Error('плеер не найден');
    const session = {
      id: `live-${Date.now()}`,
      videoId: vidId(),
      tracks: Object.create(null),
      stopped: false,
      stopRequested: false,
      stopReason: '',
      postedBytes: 0,
      post(kind, bytes, mime, init) {
        const copy = bytes.slice();
        session.postedBytes += copy.length;
        window.postMessage({
          __nova_live_chunk: true,
          sessionId: session.id,
          kind,
          mime: mime || '',
          init: Boolean(init),
          buffer: copy.buffer,
        }, location.origin, [copy.buffer]);
      },
    };
    const previousMuted = media.muted;
    store.liveSession = session;
    // Passive VOD capture would duplicate every forwarded fragment in page
    // memory; a live recording has no bounded length, so it must stay off.
    store.capturing = false;
    resetCapture();
    deliberatePlaybackDepth += 1;
    // Pin the current representation: a mid-recording SABR quality switch
    // writes a second init segment into the track file, and stream copy of
    // such a file is broken in every container.
    const qualityBeforeLive = qualitySnapshot();
    try {
      const lockedQuality = currentQuality();
      if (lockedQuality && lockedQuality !== 'auto') {
        setQualityRaw(lockedQuality);
        log('live', 'quality pinned for recording:', lockedQuality);
      }
    } catch (e) {}
    let caughtUp = from !== 'start';
    const startedAt = Date.now();
    try {
      if (from === 'start') {
        media.muted = true;
        const seekable = media.seekable;
        const dvrStart = seekable?.length ? seekable.start(0) : 0;
        log('live', 'seeking to DVR start:', dvrStart);
        try { media.currentTime = Math.max(0, dvrStart + 0.25); } catch (e) {}
      } else {
        // The recording captures the fragments YouTube appends at the live
        // edge — a few seconds ahead of a lagging playhead. Jump the player to
        // the live edge so the viewer watches exactly what lands in the file.
        const seekable = media.seekable;
        if (seekable?.length) {
          const liveEdge = seekable.end(seekable.length - 1);
          const lag = liveEdge - (Number(media.currentTime) || 0);
          if (lag > 2) {
            log('live', 'seeking to live edge for recording; lag=', lag.toFixed(1));
            try { media.currentTime = Math.max(0, liveEdge - 0.75); } catch (e) {}
          }
        }
      }
      if (media.paused) {
        try { await playWithTimeout(media, 8_000); } catch (e) {}
      }
      let lastActivityAt = Date.now();
      let lastPostedBytes = 0;
      let lastEdge = 0;
      while (!session.stopRequested) {
        await sleep(500);
        // Compare against the session's own snapshot: store.videoId is
        // reassigned by the navigation handlers before this loop can notice.
        if (session.videoId && vidId() !== session.videoId) {
          session.stopReason = 'открыто другое видео';
          break;
        }
        if (media.ended) {
          session.stopReason = 'трансляция завершена';
          break;
        }
        const seekable = media.seekable;
        const liveEdge = seekable?.length ? seekable.end(seekable.length - 1) : 0;
        const position = Number(media.currentTime) || 0;
        const behind = Math.max(0, liveEdge - position);
        if (!caughtUp) {
          // Skip ahead only within the buffered region: those bytes were
          // already appended (and forwarded), so no captured gap can appear.
          let bufferedEnd = position;
          const buffered = media.buffered;
          for (let index = 0; index < buffered.length; index++) {
            if (buffered.start(index) <= position + 0.5 && buffered.end(index) > bufferedEnd) {
              bufferedEnd = buffered.end(index);
            }
          }
          if (bufferedEnd - 1 > position + 6) {
            try { media.currentTime = bufferedEnd - 1; } catch (e) {}
          }
          if (behind < 12) {
            caughtUp = true;
            restoreMediaMuted(media, previousMuted);
            log('live', 'backfill caught up with the live edge; behind=', behind.toFixed(1));
          }
        }
        if (media.paused && !media.ended && !session.stopRequested) {
          // The recording must survive YouTube's own hiccup-pauses.
          try { await playWithTimeout(media, 4_000); } catch (e) {}
        }
        if (session.postedBytes !== lastPostedBytes || Math.abs(liveEdge - lastEdge) > 0.75) {
          lastPostedBytes = session.postedBytes;
          lastEdge = liveEdge;
          lastActivityAt = Date.now();
        } else if (Date.now() - lastActivityAt > 120_000) {
          session.stopReason = 'поток не передаёт данные более 2 минут';
          break;
        }
        onProgress?.({
          seconds: (Date.now() - startedAt) / 1000,
          bytes: session.postedBytes,
          behind,
          caughtUp,
        });
      }
      if (!session.stopReason) session.stopReason = 'остановлено пользователем';
      const audioTrack = session.tracks.audio;
      const videoTrack = session.tracks.video;
      if (!videoTrack?.bytes && !audioTrack?.bytes) {
        throw new Error('не получено ни одного медиасегмента эфира');
      }
      const spanTrack = (videoTrack?.timecodesAreMs && videoTrack) || (audioTrack?.timecodesAreMs && audioTrack) || null;
      const durationSeconds = spanTrack && Number.isFinite(spanTrack.firstTimecode)
        && Number.isFinite(spanTrack.lastTimecode)
        ? Math.max(0, (spanTrack.lastTimecode - spanTrack.firstTimecode) / 1000)
        : 0;
      log('live', 'session finished:', JSON.stringify({
        reason: session.stopReason,
        bytes: session.postedBytes,
        durationSeconds: Math.round(durationSeconds),
        video: videoTrack ? { mime: videoTrack.mime, fragments: videoTrack.fragments, bytes: videoTrack.bytes } : null,
        audio: audioTrack ? { mime: audioTrack.mime, fragments: audioTrack.fragments, bytes: audioTrack.bytes } : null,
      }));
      return {
        reason: session.stopReason,
        bytes: session.postedBytes,
        videoMime: videoTrack?.mime || '',
        audioMime: audioTrack?.mime || '',
        durationSeconds,
      };
    } finally {
      session.stopped = true;
      store.liveSession = null;
      store.capturing = true;
      deliberatePlaybackDepth = Math.max(0, deliberatePlaybackDepth - 1);
      restoreMediaMuted(media, previousMuted);
      await restoreQuality(qualityBeforeLive).catch(() => {});
    }
  }

  function playerResponse() {
    try {
      const p = player();
      const r = p && p.getPlayerResponse && p.getPlayerResponse();
      if (r && r.captions) return r;  // live response with captions — best
      if (r && r.streamingData) return r;  // live response with streaming — ok
    } catch (e) {}
    return window.ytInitialPlayerResponse || null;
  }
  function captionTracks() {
    const pr = playerResponse();
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    if (tl && Array.isArray(tl.captionTracks) && tl.captionTracks.length) {
      return tl.captionTracks;
    }
    const initPr = window.ytInitialPlayerResponse;
    const initTl = initPr && initPr.captions && initPr.captions.playerCaptionsTracklistRenderer;
    if (initTl && Array.isArray(initTl.captionTracks) && initTl.captionTracks.length) {
      return initTl.captionTracks;
    }
    try {
      const p = player();
      if (p && p.getOption) {
        const list = p.getOption('captions', 'tracklist');
        if (Array.isArray(list) && list.length) return list;
      }
    } catch (e) {}
    return [];
  }
  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const matches = (t, code, asr) => {
      const l = getTrackLang(t).toLowerCase();
      const k = getTrackKind(t);
      const isAsr = k === 'asr';
      const langMatch = l === code.toLowerCase() || l.startsWith(code.toLowerCase() + '-');
      return langMatch && (asr === null || isAsr === asr);
    };

    return tracks.find(t => matches(t, 'ru', false)) ||
           tracks.find(t => matches(t, 'ru', true)) ||
           tracks.find(t => matches(t, 'en', false)) ||
           tracks.find(t => matches(t, 'en', true)) ||
           tracks.find(t => matches(t, 'ru', null)) ||
           tracks.find(t => matches(t, 'en', null)) ||
           tracks[0];
  }
  function parseJson3(j) {
    const lines = []; let buf = '';
    for (const ev of (j.events || [])) {
      if (!ev.segs) continue;
      const piece = ev.segs.map(s => s.utf8 || '').join(' ').replace(/\n/g, ' ').trim();
      if (!piece) { if (buf) { lines.push(buf); buf = ''; } continue; }
      buf = buf ? buf + ' ' + piece : piece;
    }
    if (buf) lines.push(buf);
    return lines.filter(Boolean);
  }
  // Parse json3 into timed cues (start/end in seconds, text). Returns [] if the
  // payload has no timing info. This is what lets us emit SRT/VTT.
  function parseJson3Cues(j) {
    const cues = [];
    for (const ev of (j.events || [])) {
      if (!ev.segs) continue;
      const piece = ev.segs.map(s => s.utf8 || '').join(' ').replace(/\n/g, ' ').trim();
      if (!piece) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;
      cues.push({ start, end, text: piece });
    }
    return cues;
  }
  function parseVttOrSrt(text) {
    if (!text || (!text.includes('-->') && !text.includes('WEBVTT'))) return null;
    const lines = text.split(/\r?\n/);
    const cues = [];
    const plainLines = [];
    let i = 0;
    const timeRe = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
    const toSec = (h, m, s, ms) => (parseInt(h || '0', 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10) + (parseInt(ms, 10) / 1000);

    while (i < lines.length) {
      const line = lines[i].trim();
      const m = timeRe.exec(line);
      if (m) {
        const start = toSec(m[1], m[2], m[3], m[4]);
        const end = toSec(m[5], m[6], m[7], m[8]);
        i++;
        const textParts = [];
        while (i < lines.length && lines[i].trim() !== '') {
          const t = lines[i].replace(/<[^>]+>/g, '').trim();
          if (t) textParts.push(t);
          i++;
        }
        if (textParts.length) {
          const cueText = textParts.join(' ');
          cues.push({ start, end, text: cueText });
          plainLines.push(cueText);
        }
      } else {
        i++;
      }
    }
    return cues.length ? { cues, lines: plainLines } : null;
  }

  function parseXmlCues(text) {
    if (!text || (!text.includes('<text') && !text.includes('<p') && !text.includes('<s '))) return null;
    const cues = [];
    const plainLines = [];

    const re = /<(text|p|s)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    const parseTimeAttr = (val) => {
      if (!val) return 0;
      if (val.includes(':')) {
        const parts = val.split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
      }
      const num = parseFloat(val.replace('s', ''));
      return Number.isNaN(num) ? 0 : num;
    };

    while ((m = re.exec(text)) !== null) {
      const attrs = m[2];
      const rawText = m[3].replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ').trim();
      if (!rawText) continue;

      let start = 0, end = 0;
      const startMatch = /start="([^"]+)"/i.exec(attrs) || /begin="([^"]+)"/i.exec(attrs) || /t="([^"]+)"/i.exec(attrs);
      const durMatch = /dur="([^"]+)"/i.exec(attrs) || /d="([^"]+)"/i.exec(attrs);
      const endMatch = /end="([^"]+)"/i.exec(attrs);

      if (startMatch) {
        start = parseTimeAttr(startMatch[1]);
        if (startMatch[0].startsWith('t=')) start = start / 1000;
      }
      if (durMatch) {
        let dur = parseTimeAttr(durMatch[1]);
        if (durMatch[0].startsWith('d=')) dur = dur / 1000;
        end = start + dur;
      } else if (endMatch) {
        end = parseTimeAttr(endMatch[1]);
      } else {
        end = start + 3.0;
      }

      cues.push({ start, end, text: rawText });
      plainLines.push(rawText);
    }
    return cues.length ? { cues, lines: plainLines } : null;
  }

  function tryParse(text, track) {
    if (!text || typeof text !== 'string') return null;
    const lang = getTrackLang(track);

    // 1. Try JSON3
    try {
      const j = JSON.parse(text);
      if (j && j.events) {
        const cues = parseJson3Cues(j);
        const lines = parseJson3(j);
        if (lines.length) return { cues, lines, lang };
      }
    } catch (e) {}

    // 2. Try WebVTT / SRT
    const vttRes = parseVttOrSrt(text);
    if (vttRes && vttRes.lines.length) {
      return { cues: vttRes.cues, lines: vttRes.lines, lang };
    }

    // 3. Try XML / TTML
    const xmlRes = parseXmlCues(text);
    if (xmlRes && xmlRes.lines.length) {
      return { cues: xmlRes.cues, lines: xmlRes.lines, lang };
    }

    return null;
  }

  // Helper: check if a base64-encoded protobuf params string contains the videoId
  function b64Contains(b64str, needle) {
    if (!b64str || !needle) return false;
    // Method 1: The videoId is stored as a protobuf length-prefixed string.
    // Encode it the same way and check for substring match in the base64.
    try {
      const encoded = btoa(String.fromCharCode(needle.length) + needle).replace(/=+$/, '');
      if (b64str.includes(encoded)) return true;
    } catch(e) {}
    // Method 2: Try to fully decode and search
    try {
      let s = b64str;
      try { s = decodeURIComponent(s); } catch(e) {}
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      if (atob(s).includes(needle)) return true;
    } catch(e) {}
    return false;
  }

  function getInnertubeCfg(key) {
    try { if (window.ytcfg && typeof window.ytcfg.get === 'function' && window.ytcfg.get(key)) return window.ytcfg.get(key); } catch(e) {}
    try { if (window.ytcfg && window.ytcfg.d && window.ytcfg.d[key]) return window.ytcfg.d[key]; } catch(e) {}
    try { if (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_[key]) return window.ytcfg.data_[key]; } catch(e) {}
    try { if (window.yt && window.yt.config_ && window.yt.config_[key]) return window.yt.config_[key]; } catch(e) {}
    try {
      const match = document.documentElement.innerHTML.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"'));
      if (match) return match[1];
    } catch(e) {}
    return null;
  }

  // ---- innertube transcript fetch (modern YouTube POST API) -----------------
  function encodeVarInt(value) {
    const bytes = [];
    while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
    bytes.push(value & 0x7f);
    return bytes;
  }
  function pbString(fieldNum, str) {
    const tag = (fieldNum << 3) | 2;
    const enc = new TextEncoder();
    const data = enc.encode(str);
    return [...encodeVarInt(tag), ...encodeVarInt(data.length), ...data];
  }
  function pbBytes(fieldNum, innerBytes) {
    const tag = (fieldNum << 3) | 2;
    return [...encodeVarInt(tag), ...encodeVarInt(innerBytes.length), ...innerBytes];
  }
  function encodeTranscriptParams(videoId, lang, kind) {
    let inner = pbString(1, videoId);
    if (lang) inner = [...inner, ...pbString(2, lang)];
    if (kind) inner = [...inner, ...pbString(3, kind)];

    const level2 = pbBytes(1, inner);
    const level3 = pbBytes(1, level2);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(level3)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function findTranscriptParams(vid) {
    let found = null;
    const seen = new Set();
    function walk(node) {
      if (found || !node || typeof node !== 'object') return;
      if (node instanceof Node) return; // ignore DOM nodes
      if (seen.has(node)) return;
      seen.add(node);
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        const p = node.getTranscriptEndpoint.params;
        if (typeof p === 'string' && b64Contains(p, vid)) {
          found = p;
          return;
        }
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
      } else {
        let keys = [];
        try { keys = Object.keys(node); } catch(e) {}
        for (const key of keys) walk(node[key]);
      }
    }
    
    // Check captured network responses first!
    if (window.__nova_next_params) {
      for (const p of window.__nova_next_params) {
        if (typeof p === 'string' && b64Contains(p, vid)) return p;
      }
    }

    try { walk(window.ytInitialData); } catch (e) {}
    try { walk(window.ytInitialPlayerResponse); } catch (e) {}
    try { walk(playerResponse()); } catch (e) {}
    if (!found) {
      try {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer, ytd-app, ytd-watch-flexy, ytd-browse, ytd-watch-next-secondary-results-renderer');
        for (const p of panels) {
          if (p.__data || p.data) walk(p.__data || p.data);
        }
      } catch(e) {}
    }
    
    // Bruteforce search through the entire DOM HTML
    if (!found) {
      try {
        const allText = document.documentElement.innerHTML;
        const re = /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(allText)) !== null) {
          if (b64Contains(m[1], vid)) { found = m[1]; break; }
        }
      } catch(e) {}
    }
    
    return found;
  }

  // Wrapper: try videoId-verified params first, fall back to first params found
  function getTranscriptParams(vid) {
    const verified = findTranscriptParams(vid);
    if (verified) return verified;
    // If videoId check fails (e.g. due to URL encoding), return first params found
    let firstFound = null;
    const seen = new Set();
    function walkFirst(node) {
      if (firstFound || !node || typeof node !== 'object') return;
      if (node instanceof Node) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        firstFound = node.getTranscriptEndpoint.params;
        return;
      }
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walkFirst(node[i]); }
      else { try { for (const k of Object.keys(node)) walkFirst(node[k]); } catch(e) {} }
    }
    try { walkFirst(window.ytInitialData); } catch(e) {}
    if (!firstFound) try { walkFirst(playerResponse()); } catch(e) {}
    if (!firstFound) {
      try {
        const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer, ytd-app, ytd-watch-flexy');
        for (const p of panels) { if (p.__data || p.data) walkFirst(p.__data || p.data); }
      } catch(e) {}
    }
    if (!firstFound && window.__nova_next_params && window.__nova_next_params.length) {
      firstFound = window.__nova_next_params[window.__nova_next_params.length - 1];
    }
    return firstFound;
  }

  async function fetchViaInnertube(videoId, lang, kind) {
    try {
      const foundParams = getTranscriptParams(videoId);
      const params = foundParams || encodeTranscriptParams(videoId, lang, kind);
      const pSrc = foundParams ? 'found' : 'encoded';

      // Use FULL INNERTUBE_CONTEXT as-is from YouTube — do NOT simplify or modify it
      const rawCtx = getInnertubeCfg('INNERTUBE_CONTEXT');
      let context;
      if (rawCtx && typeof rawCtx === 'object') {
        try { context = JSON.parse(JSON.stringify(rawCtx)); } catch(e) {}
      }
      if (!context) {
        context = {
          client: {
            hl: getInnertubeCfg('HL') || navigator.language || 'en',
            gl: getInnertubeCfg('GL') || 'US',
            clientName: 'WEB',
            clientVersion: getInnertubeCfg('INNERTUBE_CLIENT_VERSION') || '2.20240715.00.00'
          }
        };
      }

      const apiKey = getInnertubeCfg('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

      // Minimal headers — let cookies handle auth
      const headers = { 'Content-Type': 'application/json' };

      let r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=' + apiKey, {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({ context: context, params: params })
      });

      // Fallback: retry without cookies
      if (!r.ok && r.status === 400) {
        r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=' + apiKey, {
          method: 'POST',
          credentials: 'omit',
          headers: headers,
          body: JSON.stringify({ context: context, params: params })
        });
      }

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        const pVal = params ? String(params).slice(0, 80) : 'null';
        return { parsed: null, diag: 'innertube_http_' + r.status + '(pSrc=' + pSrc + ' pVal=' + JSON.stringify(pVal) + ' ctx=' + (rawCtx ? 'ytcfg' : 'fallback') + ' snip=' + JSON.stringify(errText.slice(0, 120)) + ')' };
      }

      const data = await r.json();
      const parsed = parseInnertubeTranscript(data, lang);
      if (parsed) {
        return { parsed, diag: 'innertube_ok' };
      }
      const keys = data ? Object.keys(data).join(',') : 'null';
      const snippet = JSON.stringify(data || {}).slice(0, 250);
      return { parsed: null, diag: 'innertube_empty(keys=[' + keys + '] snippet=' + snippet + ')' };
    } catch (e) {
      return { parsed: null, diag: 'innertube_exc=' + e.message };
    }
  }

  function extractText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (obj.simpleText) return obj.simpleText;
    if (obj.runs) return obj.runs.map(r => r.text || '').join('');
    return '';
  }

  function parseInnertubeTranscript(data, lang) {
    if (!data || typeof data !== 'object') return null;
    const cues = [];
    const lines = [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      if (node.transcriptCueRenderer) {
        const cr = node.transcriptCueRenderer;
        const text = extractText(cr.cue).trim();
        if (text) {
          const start = parseInt(cr.startOffsetMs || '0', 10) / 1000;
          const dur = parseInt(cr.durationMs || '0', 10) / 1000;
          cues.push({ start, end: start + dur, text });
          lines.push(text);
        }
      }

      if (node.transcriptSegmentRenderer) {
        const sr = node.transcriptSegmentRenderer;
        const text = extractText(sr.snippet).trim();
        if (text) {
          const start = parseInt(sr.startMs || '0', 10) / 1000;
          const end = parseInt(sr.endMs || '0', 10) / 1000;
          cues.push({ start, end, text });
          lines.push(text);
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== 'transcriptCueRenderer' && key !== 'transcriptSegmentRenderer') {
          walk(node[key]);
        }
      }
    }

    walk(data);

    if (lines.length) return { cues, lines, lang: lang || 'en' };
    return null;
  }

  async function fetchViaBackground(url) {
    try {
      const res = await sendToBackground({ t: 'nova-fetch-caption', url });
      if (!res || !res.ok) return { ok: false, len: 0, text: '', error: res ? res.error : 'bg proxy error' };
      return res;
    } catch (e) { return { ok: false, len: 0, text: '', error: e.message }; }
  }
  function getTrackLang(track) {
    if (!track) return 'en';
    if (track.languageCode) return track.languageCode;
    if (track.langCode) return track.langCode;
    if (track.language) return track.language;
    const vss = track.vssId || track.vss_id || '';
    if (vss) return vss.replace(/^a\./, '').replace(/^\./, '');
    return 'en';
  }
  function getTrackKind(track) {
    if (!track) return '';
    if (track.kind) return track.kind;
    const vss = track.vssId || track.vss_id || '';
    if (vss && vss.startsWith('a.')) return 'asr';
    return '';
  }
  async function triggerPlayerCaptions(track) {
    try {
      window.__nova_captured_timedtext = [];
      const p = player();
      if (!p) return null;
      if (typeof p.loadModule === 'function') p.loadModule('captions');
      const lang = getTrackLang(track);
      if (typeof p.setOption === 'function') {
        p.setOption('captions', 'track', { languageCode: lang });
      }
      if (typeof p.toggleSubtitlesOn === 'function') p.toggleSubtitlesOn();
    } catch (e) {}

    for (let i = 0; i < 15; i++) {
      await sleep(100);
      if (window.__nova_captured_timedtext && window.__nova_captured_timedtext.length) {
        for (const text of window.__nova_captured_timedtext) {
          const parsed = tryParse(text, track);
          if (parsed) return parsed;
        }
      }
    }
    return null;
  }

  async function fetchCaptionFromTrack(track) {
    const lang = getTrackLang(track);
    const kind = getTrackKind(track);
    const vid = vidId();
    const rawUrl = track.baseUrl || track.url || '';

    const candidates = [];
    if (rawUrl) {
      candidates.push(rawUrl); // PRESERVE EXACT RAW URL WITH SIGNATURE UNTOUCHED!
    }
    if (vid && lang) {
      const direct = 'https://www.youtube.com/api/timedtext?v=' + vid + '&lang=' + encodeURIComponent(lang) + (kind ? '&kind=' + encodeURIComponent(kind) : '') + '&fmt=json3';
      candidates.push(direct);
    }

    const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

    let failLog = [];
    // Strategy 0: use the signed timedtext URL immediately. Do not wait for the
    // player caption module unless every direct request fails.
    for (const u of uniqueCandidates) {
      try {
        const r = await fetch(u, { credentials: 'omit' });
        if (r.ok) {
          const text = await r.text();
          if (text && text.length > 5) {
            const parsed = tryParse(text, track);
            if (parsed) return { parsed, diag: 'main_omit len=' + text.length };
            else failLog.push('omit_parse_fail(len=' + text.length + ')');
          } else failLog.push('omit_empty');
        } else failLog.push('omit_http' + r.status);
      } catch (e) { failLog.push('omit_err'); }
    }

    // Strategy 1: Fetch from main world with credentials: 'include'
    for (const u of uniqueCandidates) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (r.ok) {
          const text = await r.text();
          if (text && text.length > 5) {
            const parsed = tryParse(text, track);
            if (parsed) return { parsed, diag: 'main_include len=' + text.length };
            else failLog.push('inc_parse_fail(len=' + text.length + ')');
          } else failLog.push('inc_empty');
        } else failLog.push('inc_http' + r.status);
      } catch (e) { failLog.push('inc_err'); }
    }

    // Strategy 2: Background proxy fetch
    for (const u of uniqueCandidates) {
      const bg = await fetchViaBackground(u);
      if (bg && bg.ok && bg.text && bg.text.length > 5) {
        const parsed = tryParse(bg.text, track);
        if (parsed) return { parsed, diag: 'bg len=' + bg.text.length };
        else failLog.push('bg_parse_fail(len=' + bg.text.length + ')');
      } else {
        failLog.push('bg_fail(' + (bg ? (bg.ok ? 'empty' : bg.error) : 'null') + ')');
      }
    }

    return { parsed: null, diag: 'all_failed[' + failLog.join(',') + ']' };
  }

  function transcriptPanels() {
    return [...querySelectorAllDeep('ytd-engagement-panel-section-list-renderer, [panel-target-id*="transcript"], [target-id*="transcript"]')]
      .filter(p => {
        const tid = (p.getAttribute('panel-target-id') || p.getAttribute('target-id') || p.getAttribute('id') || '').toLowerCase();
        return tid.includes('transcript');
      });
  }
  function expandedTranscriptPanel() {
    return transcriptPanels().find(p => p.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN')
      || transcriptPanels()[0];
  }
  function findTranscriptButton() {
    return [...document.querySelectorAll('button')].find(b => {
      const a = b.getAttribute('aria-label') || '';
      return /расшифровка видео|show transcript|транскрипт|transcript/i.test(a) && !/закрыть|close/i.test(a);
    });
  }
  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    function search(node) {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches && node.matches(selector)) {
          results.push(node);
        }
        if (node.shadowRoot) {
          search(node.shadowRoot);
        }
      }
      for (const child of node.childNodes || []) {
        search(child);
      }
    }
    search(root);
    return results;
  }

  function extractTranscriptCuesFromDOM() {
    const parseSec = (str) => {
      const parts = (str || '').trim().split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return 0;
    };

    const isTimestampLabel = (t) => {
      if (!t) return true;
      t = t.trim();
      if (/^\d+:\d{2}(?::\d{2})?$/.test(t)) return true;
      if (/^\d+\s*(?:сек|мин|час|секунд|секунды|секунда|минут|минуты|минута|часов|часа|час|seconds?|mins?|minutes?|hours?)/i.test(t)) return true;
      return false;
    };

    const cues = [];
    
    // 1. Search whole document (including all Shadow Roots) for transcript segment renderers
    const segs = querySelectorAllDeep('ytd-transcript-segment-renderer, ytm-transcript-segment-renderer, [class*="transcript-segment"], [class*="segmentRenderer"]');
    if (segs.length > 0) {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const timeEl = s.querySelector('.segment-timestamp, [class*="timestamp"]');
        const textEl = s.querySelector('.segment-text, [class*="segment-text"], [class*="segmentText"]');
        
        let start = 0;
        if (timeEl) {
          start = parseSec(timeEl.textContent);
        }
        
        let text = '';
        if (textEl) {
          text = textEl.textContent.trim();
        }
        
        if (!text || isTimestampLabel(text)) {
          const strings = [...s.querySelectorAll('yt-formatted-string, span, div')]
            .map(e => e.textContent.trim())
            .filter(t => t && !isTimestampLabel(t));
          if (strings.length) text = strings.join(' ');
        }

        if (text && !isTimestampLabel(text)) {
          cues.push({ start, text });
        }
      }
    }

    // 2. Fallback: search specifically inside engagement panels or structured description panels
    if (!cues.length) {
      const panels = querySelectorAllDeep('ytd-engagement-panel-section-list-renderer, ytd-structured-description-content-renderer, [panel-target-id*="transcript"], [target-id*="structured_description"], ytd-transcript-search-panel-renderer');
      for (const panel of panels) {
        if (panel.closest && panel.closest('ytd-watch-next-secondary-results-renderer, #secondary')) continue;
        
        const allElements = querySelectorAllDeep('yt-formatted-string, span, div', panel);
        const allStrings = allElements
          .map(e => (e.textContent || '').replace(/[\u200b\u200e\u200f]/g, '').trim())
          .filter(Boolean);
        
        for (let i = 0; i < allStrings.length; i++) {
          const str = allStrings[i];
          if (isTimestampLabel(str)) {
            let start = parseSec(str);
            let j = i + 1;
            while (j < allStrings.length && isTimestampLabel(allStrings[j])) {
              j++;
            }
            if (j < allStrings.length && !/Поиск|Search/i.test(allStrings[j])) {
              cues.push({ start, text: allStrings[j] });
              i = j;
            }
          }
        }
        if (cues.length > 0) break;
      }
    }

    if (!cues.length) return null;

    for (let i = 0; i < cues.length; i++) {
      if (i < cues.length - 1) {
        cues[i].end = cues[i + 1].start;
      } else {
        cues[i].end = cues[i].start + 4;
      }
    }
    return { cues, lines: cues.map(c => c.text) };
  }

  function closeTranscriptPanelIfOpen() {
    try {
      const app = document.querySelector('ytd-app') || document.body;

      // 1. Dispatch YouTube Polymer events to hide/close engagement panel
      const targetIds = ['PAmodern_transcript_view', 'engagement-panel-searchable-transcript', 'engagement-panel-transcript'];
      ['yt-hide-engagement-panel-section-action', 'yt-close-engagement-panel-section-action'].forEach((act) => {
        targetIds.forEach((targetId) => {
          try {
            app.dispatchEvent(new CustomEvent('yt-action', {
              detail: { actionName: act, args: [{ targetId: targetId }] },
              bubbles: true, composed: true
            }));
          } catch(e) {}
        });
      });

      // 2. Set visibility attribute & property on all transcript engagement panels
      const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
      for (const p of panels) {
        const tid = p.getAttribute('target-id') || '';
        if (tid.includes('transcript') || tid.includes('PAmodern') || p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
          try { p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'); } catch(e) {}
          try { p.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'; } catch(e) {}
          
          // 3. Find and click close button inside panel
          const closeBtn = p.querySelector('button[aria-label*="Закрыть"], button[aria-label*="Close"], #visibility-button button, #header button');
          if (closeBtn) {
            try { closeBtn.click(); } catch(e) {}
          }
        }
      }

      // 4. Click any global button with aria-label "Закрыть расшифровку видео" or "Close transcript"
      const globalCloseBtns = document.querySelectorAll('button[aria-label*="Закрыть расшифровку"], button[aria-label*="Close transcript"]');
      for (const b of globalCloseBtns) {
        try { b.click(); } catch(e) {}
      }
    } catch (e) {}
  }

  async function getSubtitlesViaPanel(diagSink) {
    let btn = findTranscriptButton();
    if (!btn) {
      const more = document.querySelector('ytd-text-inline-expander #expand, #description #expand, tp-yt-paper-button#expand');
      if (more) { try { more.click(); } catch (e) {} await sleep(400); btn = findTranscriptButton(); }
    }

    const triggerActions = () => {
      if (btn) {
        try { btn.click(); } catch (e) {}
        try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      }
      const app = document.querySelector('ytd-app') || document.body;
      ['yt-open-engagement-panel-section-action', 'yt-show-engagement-panel-section-action', 'yt-load-engagement-panel-section-action', 'yt-reload-engagement-panel-section-action'].forEach((act) => {
        try {
          app.dispatchEvent(new CustomEvent('yt-action', {
            detail: { actionName: act, args: [{ targetId: 'PAmodern_transcript_view' }] },
            bubbles: true, composed: true
          }));
        } catch (e) {}
      });

      // Try native resolveCommand if available
      try {
        const p = findTranscriptParams(vidId());
        if (p && app.resolveCommand) {
          app.resolveCommand({ getTranscriptEndpoint: { params: p } });
        }
      } catch (e) {}
    };

    triggerActions();

    const panel = () => expandedTranscriptPanel();
    const p = panel();
    if (p && p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') {
      try { p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); } catch (e) {}
    }

    await sleep(400);

    // Wait up to 10 seconds for transcript segments to render
    for (let i = 0; i < 30; i++) {
      const cuesData = extractTranscriptCuesFromDOM();
      if (cuesData && cuesData.lines && cuesData.lines.length) {
        closeTranscriptPanelIfOpen();
        return cuesData.lines;
      }
      
      // If stuck on spinner after 1.5s, trigger actions again
      if (i === 5 || i === 12) {
        triggerActions();
        const curP = panel();
        if (curP) {
          const spinner = curP.querySelector('yt-content-loading-renderer, tp-yt-paper-spinner');
          if (spinner) {
            try { curP.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'); } catch (e) {}
            try { if (curP.reload) curP.reload(); } catch (e) {}
          }
        }
      }

      await sleep(300);
    }

    if (diagSink) {
      const curP = panel();
      const c = curP && (curP.querySelector('#content') || curP);
      diagSink.push('panel: timeout. content=' + (c ? c.innerHTML.slice(0, 1500) : 'no panel'));
    }
    return null;
  }

  function buildCuesFromLines(lines) {
    if (!lines || !lines.length) return [];
    const cues = [];
    let cur = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] || '').trim();
      if (!line) continue;
      const m = line.match(/^(\d+:\d{2}(?::\d{2})?)\s+(.+)$/s);
      if (m) {
        const parts = m[1].split(':').map(Number);
        const start = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
        const text = m[2].trim();
        cues.push({ start: start, end: start + 4, text: text });
      } else {
        const dur = Math.max(2, Math.min(6, line.length * 0.1));
        cues.push({ start: cur, end: cur + dur, text: line });
        cur += dur;
      }
    }
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) {
        cues[i].end = cues[i + 1].start;
      }
    }
    return cues;
  }

  async function getSubtitles() {
    const tracks = captionTracks();
    if (!tracks.length) {
      const pr = playerResponse();
      const diag = 'no tracks. hasPR=' + !!pr + ' hasCaptions=' + !!(pr && pr.captions) + ' ytInit=' + !!window.ytInitialPlayerResponse;
      throw new Error('у этого видео нет субтитров (' + diag + ')');
    }
    const track = pickTrack(tracks);
    if (!track) throw new Error('субтитры недоступны');
    const lang = getTrackLang(track);
    let fetchDiag = '';

    // 0. Instant DOM check: if user already has transcript panel open in DOM
    const instantCues = extractTranscriptCuesFromDOM();
    if (instantCues && instantCues.lines && instantCues.lines.length) {
      log('subs', 'got ' + instantCues.lines.length + ' lines directly from open DOM panel');
      const cues = (instantCues.cues && instantCues.cues.length) ? instantCues.cues : buildCuesFromLines(instantCues.lines);
      closeTranscriptPanelIfOpen();
      return { text: instantCues.lines.join('\n'), cues: cues, lang: lang };
    }

    // 1. Primary: the caption track already contains a signed timedtext URL.
    // This is normally one small request and avoids scanning the full page data.
    try {
      const { parsed, diag: d } = await fetchCaptionFromTrack(track);
      if (d) fetchDiag += d;
      if (parsed && parsed.lines && parsed.lines.length) {
        closeTranscriptPanelIfOpen();
        return { text: parsed.lines.join('\n'), cues: parsed.cues || null, lang: parsed.lang || lang };
      }
    } catch (e) { fetchDiag += ' timedtext_err=' + (e && e.message); }

    // 2. Fallback: innertube get_transcript API (modern YouTube)
    const vid = vidId();
    const kind = getTrackKind(track);
    if (vid) {
      const itRes = await fetchViaInnertube(vid, lang, kind);
      if (itRes && itRes.parsed && itRes.parsed.lines && itRes.parsed.lines.length) {
        log('subs', 'got ' + itRes.parsed.lines.length + ' lines via innertube');
        closeTranscriptPanelIfOpen();
        return { text: itRes.parsed.lines.join('\n'), cues: itRes.parsed.cues || null, lang: itRes.parsed.lang || lang };
      }
      fetchDiag += (itRes && itRes.diag ? itRes.diag : 'innertube=empty') + ' ';
    }

    // Only failed network paths reach the player-driven fallback, which may
    // wait up to 1.5 seconds for YouTube to load its caption module.
    const playerResult = await triggerPlayerCaptions(track);
    if (playerResult) {
      closeTranscriptPanelIfOpen();
      return { text: playerResult.lines.join('\n'), cues: playerResult.cues || null, lang: playerResult.lang || lang };
    }

    // 3. Last resort: transcript panel scraping
    const diagSink = [];
    const panelLines = await getSubtitlesViaPanel(diagSink);
    if (panelLines && panelLines.length) {
      const cuesData = extractTranscriptCuesFromDOM();
      const cues = (cuesData && cuesData.cues && cuesData.cues.length) ? cuesData.cues : buildCuesFromLines(panelLines);
      closeTranscriptPanelIfOpen();
      return { text: panelLines.join('\n'), cues: cues, lang: lang };
    }

    // All methods failed — dump diagnostics
    let dump = '=== transcript buttons ===\n';
    try {
      const btns = [...document.querySelectorAll('button, a, tp-yt-paper-button')].filter(b => /transcript|расшифров|транскрипт/i.test((b.getAttribute && (b.getAttribute('aria-label') || '')) || b.textContent || ''));
      dump += btns.slice(0, 12).map(b => (b.outerHTML || '').slice(0, 300)).join('\n---\n') || '(none found)';
    } catch (e) { dump += 'err ' + e.message; }
    dump += '\n=== PAmodern_transcript_view #content (loaded) ===\n';
    try {
      const p = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')].find(x => (x.getAttribute('target-id') || '').includes('transcript'));
      const c = p && (p.querySelector('#content') || p);
      dump += c ? c.outerHTML.slice(0, 3500) : '(panel not found)';
    } catch (e) { dump += 'err ' + e.message; }
    const diag = 'track=' + (track.languageCode || '?') + ' kind=' + (track.kind || '?') +
      ' fetch=[' + fetchDiag + '] panelDiag=[' + diagSink.join(' || ') + ']\n' + dump.slice(0, 4000);
    throw new Error('не удалось получить субтитры (' + diag + ')');
  }

  function subsAvailable() {
    const tracks = captionTracks();
    const track = pickTrack(tracks);
    return { available: !!track, lang: track ? (track.languageCode || 'txt') : null };
  }

  // Codec/bitrate of the best source audio stream, so the UI can offer a true
  // passthrough option (.opus stays .opus) and hide pointless re-encodes.
  function bestAudioSource() {
    try {
      const formats = playerResponse()?.streamingData?.adaptiveFormats;
      const audio = (Array.isArray(formats) ? formats : [])
        .filter((format) => /^audio\//i.test(format?.mimeType || ''))
        .sort((left, right) => {
          const score = (format) => ((format.audioTrack?.audioIsDefault === false ? 0 : 1) * 1e12)
            + (format.isDrc ? 0 : 1e8)
            + (Number(format.bitrate) || 0);
          return score(right) - score(left);
        })[0];
      if (!audio) return null;
      const mime = audio.mimeType || '';
      const codec = /opus/i.test(mime) ? 'opus'
        : (/mp4a|aac/i.test(mime) ? 'aac' : (/vorbis/i.test(mime) ? 'vorbis' : ''));
      return { codec, bitrateKbps: Math.round((Number(audio.bitrate) || 0) / 1000) };
    } catch (e) { return null; }
  }

  // ---- bridge to the isolated-world UI script ------------------------------
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data[TO_HOOK] !== true) return;
    const {
      cmd, reqId, height, format, end, freshPageResume, reloadCount, from,
    } = ev.data;
    const reply = (payload, transfer) => {
      window.postMessage({ [FROM_HOOK]: true, reqId, ...payload }, location.origin, transfer || []);
    };
    try {
      if (cmd === 'info') {
        const p = player();
        const rawDuration = video() && video().duration;
        let dur = rawDuration;
        if (!isFinite(dur) || dur <= 0) dur = 0;
        let isLive = rawDuration === Infinity;
        try { isLive = isLive || Boolean(p?.getVideoData?.()?.isLive); } catch (e) {}
        let musicVideoType = '';
        try { musicVideoType = String(playerResponse()?.videoDetails?.musicVideoType || ''); } catch (e) {}
        const resp = { ok: true, videoId: vidId(), title: (p && p.getVideoData && p.getVideoData().title) || document.title.replace(/ - YouTube(?: Music)?$/, ''), duration: dur, heights: availableHeights(), isLive, liveRecording: Boolean(store.liveSession), audioSource: bestAudioSource(), musicVideoType };
        const ctx = isShortsPage() ? 'shorts'
          : (location.pathname.indexOf('/embed/') === 0 ? 'embed' : 'page');
        log('info', JSON.stringify({ ctx, dur, heights: resp.heights, hasPlayer: !!p, isLive }));
        reply(resp);
      } else if (cmd === 'live-start') {
        const result = await captureLiveStream({ from: from === 'start' ? 'start' : 'now' }, (progress) => {
          reply({ progress: 0.5, phase: 'live', live: progress });
        });
        reply({ ok: true, done: true, ...result });
      } else if (cmd === 'live-stop') {
        if (store.liveSession) {
          store.liveSession.stopRequested = true;
          reply({ ok: true, done: true });
        } else {
          reply({ ok: false, error: 'запись эфира не активна' });
        }
      } else if (cmd === 'download-cancel') {
        store.cancelRequested = true;
        log('capture', 'download cancel requested by user');
        reply({ ok: true, done: true });
      } else if (cmd === 'music-mute') {
        // App-level mute: ytmusic overrides element.muted with its own
        // stored volume state, so the queue silences the tab through the
        // player API instead.
        try {
          if (ev.data.mute) player()?.mute?.();
          else player()?.unMute?.();
        } catch (e) {}
        reply({ ok: true, done: true });
      } else if (cmd === 'download') {
        if (video()?.duration === Infinity) {
          throw new Error('это прямая трансляция — используйте пункт «Запись эфира» в меню');
        }
        store.cancelRequested = false;
        const isMp3 = format === 'mp3';
        const targetQ = isMp3 ? 'medium' : (QUALITY_BY_HEIGHT[height] || 'hd720');
        const previousQuality = qualitySnapshot();
        if (isMp3) store.mp3Isolation = null;
        // Own the playback hold for the entire command, not just the capture
        // pass: assembly-time refills seek the player too, and a video that
        // resumes between the passes makes YouTube prefetch instead of serving
        // the bounded ranges those refills ask for.
        const mediaAtStart = video();
        const videoIdAtStart = vidId();
        const wasPlayingAtStart = !!(mediaAtStart && !mediaAtStart.paused);
        store.playbackHold?.release();
        store.playbackHold = holdPlaybackPaused(mediaAtStart);
        // A Short loops and sits wherever the viewer left it. Measured on
        // nu2PED3e2LY: the playhead was at 48 s of a 100 s clip when the
        // download started, and the capture then began there — everything
        // before the playhead had to be back-filled afterwards, which is
        // exactly the prefix repair that keeps failing. Rewind to the start and
        // stop the wrap for the duration of the download.
        const loopedAtStart = Boolean(mediaAtStart?.loop);
        if (mediaAtStart) {
          if (loopedAtStart) try { mediaAtStart.loop = false; } catch (e) {}
          if ((Number(mediaAtStart.currentTime) || 0) > 0.5) {
            try { player()?.seekTo?.(0, true); } catch (e) {}
            try { mediaAtStart.currentTime = 0; } catch (e) {}
            log('download', 'rewound looping clip to the start before capture; wasAt=',
              Number((Number(mediaAtStart.currentTime) || 0).toFixed(2)), 'looped=', loopedAtStart);
          }
        }
        // The whole download runs silent: primers and refills really play the
        // media and their sound distracted users. Live recording is exempt on
        // purpose — people want to keep hearing the broadcast.
        // Muting the element once is not enough: a capture switches quality,
        // and YouTube reconfigures (or replaces) the media element and reapplies
        // its own volume state on top of element.muted. Hold the mute for the
        // whole command — through the player API too, which is the only thing
        // that reliably silences the tab — and re-assert it while work runs.
        let playerMutedBefore = null;
        try {
          playerMutedBefore = Boolean(player()?.isMuted?.());
          player()?.mute?.();
        } catch (e) {}
        // Polling alone left an audible burst after every seek: YouTube
        // restores its volume immediately and the next tick was up to half a
        // second away. `volumechange` fires the moment it happens, so the sound
        // never reaches the speakers; the timer stays only as a backstop and to
        // follow the element when the player swaps it.
        // Every media element on the page, not just video(): a watch page keeps
        // more than one around (miniplayer, ad slot, the next reel), and the one
        // the user hears during a seek is not always the one being captured.
        // Their original state is remembered so only what we silenced is undone.
        const silenced = new Map();
        const enforceSilence = () => {
          try { if (player()?.isMuted?.() === false) player().mute(); } catch (e) {}
          let elements;
          try { elements = document.querySelectorAll('video, audio'); } catch (e) { return; }
          for (const element of elements) {
            try {
              if (!silenced.has(element)) {
                silenced.set(element, element.muted);
                element.addEventListener('volumechange', enforceSilence);
              }
              if (!element.muted) element.muted = true;
            } catch (e) {}
          }
        };
        store.silenceHeld = true;
        const releaseSilenceClamp = installSilenceClamp();
        enforceSilence();
        const silenceTimer = setInterval(enforceSilence, 250);
        const musicHost = MUSIC_HOST;
        // ytmusic auto-advances to the next queue item when a *playing* track
        // ends, and capture seeks touch the end of the track. Pausing through
        // the player API (not just the element) records the paused state in
        // the app itself, so reaching the end never triggers the advance.
        let musicAppMuted = null;
        if (musicHost) {
          try { player()?.pauseVideo?.(); } catch (e) {}
          // ytmusic re-applies its own volume state on top of element.muted;
          // only the player API mute reliably silences the tab.
          try {
            musicAppMuted = Boolean(player()?.isMuted?.());
            player()?.mute?.();
          } catch (e) {}
          store.musicSeekClamp = true;
        }
        log('download', 'playback pinned for capture; wasPlaying=', wasPlayingAtStart,
          'paused=', !!mediaAtStart?.paused, 'format=', format);
        try {
          let cap;
          let result;
          let completedAudioForVideo = null;
          // Direct download is the fast path everywhere again: parallel range
          // requests defeat the ~1x throttle that made it useless on Music.
          if (isMp3) {
            if (musicHost) {
              requestBestMusicAudioTier();
              await ensureBestMusicAudioObserved(
                Number(video()?.duration) || Number(player()?.getDuration?.()) || 0);
            }
            try {
              const expectedDuration = Number(video()?.duration) || Number(player()?.getDuration?.()) || 0;
              const grabDirectAudio = async () => {
                // Several representations may have been observed for one track
                // (the player switches them as quality changes); a URL that no
                // longer serves data is retired inside fetchDirectAudio, so
                // simply asking again picks the next candidate.
                let lastError = null;
                for (let candidate = 0; candidate < 3; candidate++) {
                  try {
                    return await fetchDirectAudio((pct) => reply({ progress: pct, phase: 'direct-audio' }));
                  } catch (error) {
                    lastError = error;
                    if (error?.novaFatal || error?.novaNoFallback) throw error;
                    log('direct-audio', 'candidate', candidate + 1, 'failed:',
                      String(error?.message || error));
                  }
                }
                throw lastError;
              };
              let directAudio;
              try {
                directAudio = validateDirectAudioTrack(await grabDirectAudio(), expectedDuration);
              } catch (firstError) {
                // A Music track opened by the queue has never played, so no
                // media URL has been observed yet. One short muted play makes
                // the player request its first segments — and reveal the URL.
                if (!MUSIC_HOST || firstError?.novaFatal || firstError?.novaNoFallback) throw firstError;
                log('direct-audio', 'no usable direct URL yet; priming playback:',
                  String(firstError?.message || firstError));
                await primeMusicMediaSession(video(), expectedDuration);
                directAudio = validateDirectAudioTrack(await grabDirectAudio(), expectedDuration);
              }
              cap = { duration: Number(video()?.duration) || directAudio.duration || 0 };
              result = { audio: directAudio };
            } catch (error) {
              if (error?.novaFatal || error?.novaNoFallback) throw error;
              log('direct-audio', 'fallback to fast MSE:', error?.message || error);
              reply({ progress: 0.001, phase: 'mse-audio' });
            }
          } else {
            completedAudioForVideo = reusableCompletedAudio(
              Number(video()?.duration) || Number(player()?.getDuration?.()) || 0,
            );
            try {
              const directVideo = await fetchDirectVideo(height, (pct) => reply({
                progress: Math.min(0.84, pct * 0.84),
                phase: 'direct-video',
              }));
              let directAudio = completedAudioForVideo;
              if (directAudio) {
                log('direct-audio', 'reusing completed MP3 source audio; bytes=',
                  directAudio.bytes.length);
                reply({ progress: 0.99, phase: 'direct-audio' });
              } else {
                const expectedDuration = Number(video()?.duration)
                  || directVideo.duration || Number(player()?.getDuration?.()) || 0;
                directAudio = validateDirectAudioTrack(
                  await fetchDirectAudio((pct) => reply({
                    progress: 0.84 + (Math.min(1, pct) * 0.15),
                    phase: 'direct-audio',
                  })),
                  expectedDuration,
                );
              }
              cap = {
                actualHeight: directVideo.height || Number(height) || null,
                duration: Number(video()?.duration)
                  || directVideo.duration || directAudio.duration || 0,
              };
              result = { video: directVideo, audio: directAudio };
            } catch (error) {
              if (error?.novaFatal || error?.novaNoFallback) throw error;
              log('direct-video', 'fallback to fast MSE:', error?.message || error);
              reply({ progress: 0.001, phase: 'mse-video' });
            }
          }
          if (!result) {
            let mseCaptured = false;
            let usedSequentialMse = false;
            let mseProgress = 0;
            const reportMseProgress = (pct, phase) => {
              // Capture and prefix recovery are not complete-file validation.
              // Keep the UI below 100% until local validation/refill has
              // successfully produced both normalized tracks.
              const raw = Math.max(0, Math.min(1, Number(pct) || 0));
              const isRecovery = phase === 'buffering-prefix'
                || phase === 'buffering-gap'
                || phase === 'rendered-prefix'
                || phase === 'mse-sequential-video';
              // 99.5% rounds to a false 100% in the UI. Only the final response
              // may complete the capture stage; all validation/repair stays <=99%.
              const ceiling = isRecovery ? 0.994 : 0.97;
              const visual = phase === 'mse-sequential-video'
                ? 0.97 + (raw * 0.025)
                : raw;
              mseProgress = Math.max(mseProgress, Math.min(ceiling, visual));
              reply({ progress: mseProgress, phase });
            };
            const assembleForCurrentDownload = (options = {}) => {
              const assembled = assemble({
                ...options,
                skipAudio: Boolean(completedAudioForVideo),
                strictAudioEdges: isMp3,
              });
              if (completedAudioForVideo) assembled.audio = completedAudioForVideo;
              return assembled;
            };
            const repairCapturedWebmLocally = async (initialError, onRecoveryProgress) => {
              const attemptsByGap = new Map();
              let validationError = initialError;
              let lastRepairError = null;
              // One lost fragment is one repair. A pass that dropped several
              // fragments needs a matching budget, otherwise the first few holes
              // consume every attempt and the rest ship as frozen frames.
              const maxTotalAttempts = 16;
              const maxAttemptsPerGap = 3;

              // Prefix boundaries already attempted, per track. A prefix refill
              // that stops short leaves a gap ending exactly where the track
              // used to begin, and that gap is then reported as "interior".
              const attemptedPrefixEnds = new Map();

              for (let totalAttempt = 0; totalAttempt < maxTotalAttempts; totalAttempt++) {
                let details = validationError?.details;
                let mode = details?.missingInterior === true
                  ? 'interior'
                  : (details?.missingPrefix === true || Number(details?.firstTimecode) > 5_000
                    ? 'prefix' : (details?.missingTail === true ? 'tail' : null));
                // Two runs of the same video showed it exactly: the track began
                // at 20001 ms, the prefix refill reached 19361, and the leftover
                // 640 ms came back as an interior gap ending at 20001; next run,
                // 10001 / 6681 / gap ending at 10001. The interior refill cannot
                // fetch that region — three attempts, twenty seconds each, every
                // time — while the prefix refill demonstrably delivers most of
                // it. Send it back to the mechanism that works, under the same
                // attempt key so it still cannot loop forever.
                // ...but only while the track still lacks its *beginning*. On a
                // Shorts capture the first refill brought back 0-19981 ms and
                // left 19981-40001 missing: that gap no longer touches zero, so
                // re-running the prefix removed nothing and fetched nothing
                // three times over, where the interior refill at least aims at
                // the hole itself.
                if (mode === 'interior' && details && Number(details.gapStartMs) <= 2_000) {
                  const gapEnd = Math.round(Number(details.gapEndMs) || 0);
                  if (gapEnd > 0 && attemptedPrefixEnds.get(details.kind)?.has(gapEnd)) {
                    log('assembly', `webm ${details.kind}; interior gap ends at the former track`
                      + ` start (${gapEnd} ms) — continuing the prefix refill instead`);
                    mode = 'prefix';
                    details = {
                      ...details,
                      missingInterior: false,
                      missingPrefix: true,
                      firstTimecode: gapEnd,
                    };
                  }
                }
                if (mode === 'prefix' && details?.kind) {
                  const boundary = Math.round(Number(details.firstTimecode) || 0);
                  if (boundary > 0) {
                    if (!attemptedPrefixEnds.has(details.kind)) attemptedPrefixEnds.set(details.kind, new Set());
                    attemptedPrefixEnds.get(details.kind).add(boundary);
                  }
                }
                if (details?.container !== 'webm'
                  || (details?.kind !== 'audio' && details?.kind !== 'video')
                  || !mode) {
                  throw validationError;
                }

                const rangeKey = mode === 'interior'
                  ? `${Math.round(Number(details.gapStartMs) || 0)}:${Math.round(Number(details.gapEndMs) || 0)}`
                  : `${Math.round(Number(details.firstTimecode) || 0)}:${Math.round(Number(details.lastTimecode) || 0)}`;
                const repairKey = `${details.kind}:${mode}:${rangeKey}`;
                const attempt = attemptsByGap.get(repairKey) || 0;
                if (attempt >= maxAttemptsPerGap) {
                  if (mode === 'prefix' && details.kind === 'video' && !isMp3) {
                    const renderedPrefix = await recoverVideoPrefixWithRenderedCapture(details, {
                      targetQ,
                      requestedHeight: Number(height) || null,
                    }, onRecoveryProgress);
                    const assembled = assembleForCurrentDownload({ allowMissingVideoPrefix: true });
                    assembled.videoPrefix = renderedPrefix.videoPrefix;
                    assembled.videoPrefixBoundary = renderedPrefix.boundarySeconds;
                    assembled.forceTranscode = true;
                    return assembled;
                  }
                  break;
                }
                attemptsByGap.set(repairKey, attempt + 1);

                log('assembly', 'repairing WebM locally without page reload', {
                  format: isMp3 ? 'mp3' : 'video',
                  kind: details.kind,
                  mode,
                  attempt: attempt + 1,
                  gapStartMs: details.gapStartMs,
                  gapEndMs: details.gapEndMs,
                  firstTimecode: details.firstTimecode,
                  lastTimecode: details.lastTimecode,
                });

                try {
                  if (mode === 'interior') {
                    await refillMissingWebmInterior(details, (pct) => {
                      onRecoveryProgress?.(pct, 'buffering-gap');
                    }, { attempt });
                  } else if (mode === 'prefix') {
                    await refillMissingWebmPrefix(
                      details.kind,
                      Number(details.firstTimecode),
                      (pct) => onRecoveryProgress?.(pct, 'buffering-prefix'),
                      { pairCompanion: !isMp3 },
                    );
                  } else {
                    await refillMissingWebmTail(
                      details.kind,
                      details,
                      (pct) => onRecoveryProgress?.(pct, 'buffering-gap'),
                      { attempt },
                    );
                  }
                  lastRepairError = null;
                } catch (repairError) {
                  lastRepairError = repairError;
                  log('assembly', 'bounded WebM refill attempt failed:', repairError?.message || repairError);

                  // A request may have appended the needed fragment just before
                  // its buffered-range completion condition timed out. Validate
                  // the bytes before starting a wider network retry.
                  try {
                    return assembleForCurrentDownload();
                  } catch (nextValidationError) {
                    const nextDetails = nextValidationError?.details;
                    const repairable = nextDetails?.container === 'webm'
                      && (nextDetails?.kind === 'audio' || nextDetails?.kind === 'video')
                      && (nextDetails?.missingInterior === true
                        || nextDetails?.missingPrefix === true
                        || nextDetails?.missingTail === true
                        || Number(nextDetails?.firstTimecode) > 5_000);
                    if (!repairable) throw nextValidationError;
                    validationError = nextValidationError;
                  }

                  // If page MSE repeatedly refuses only the missing video
                  // prefix, record that bounded prefix and concatenate it with
                  // the already captured tail. This still avoids a full pass.
                  const remainingDetails = validationError?.details;
                  if (remainingDetails?.container === 'webm'
                    && remainingDetails.kind === 'video'
                    && Number(remainingDetails.firstTimecode) > 5_000
                    && remainingDetails.missingInterior !== true
                    && !isMp3
                    && attempt + 1 >= maxAttemptsPerGap) {
                    const renderedPrefix = await recoverVideoPrefixWithRenderedCapture(remainingDetails, {
                      targetQ,
                      requestedHeight: Number(height) || null,
                    }, onRecoveryProgress);
                    const assembled = assembleForCurrentDownload({ allowMissingVideoPrefix: true });
                    assembled.videoPrefix = renderedPrefix.videoPrefix;
                    assembled.videoPrefixBoundary = renderedPrefix.boundarySeconds;
                    assembled.forceTranscode = true;
                    return assembled;
                  }
                  continue;
                }

                try {
                  return assembleForCurrentDownload();
                } catch (nextValidationError) {
                  const nextDetails = nextValidationError?.details;
                  const repairable = nextDetails?.container === 'webm'
                    && (nextDetails?.kind === 'audio' || nextDetails?.kind === 'video')
                    && (nextDetails?.missingInterior === true
                      || nextDetails?.missingPrefix === true
                      || nextDetails?.missingTail === true
                      || Number(nextDetails?.firstTimecode) > 5_000);
                  if (!repairable) throw nextValidationError;
                  validationError = nextValidationError;
                }
              }

              const error = lastRepairError || validationError
                || new Error('локальная докачка WebM не восстановила дорожку');
              const exhaustedDetails = {
                ...(validationError?.details || {}),
                reason: 'local-webm-repair-exhausted',
                repairAttempts: Object.fromEntries(attemptsByGap),
              };
              // A video-only interior hole is still recoverable by the sequential
              // and rendered capture paths, so it must not end the download here.
              const fatal = !(exhaustedDetails.kind === 'video'
                && exhaustedDetails.missingInterior === true);
              // For audio there is no path left after the local refills, and
              // giving up threw away a finished capture over a few seconds of
              // sound: measured 85 s of failing retries and then nothing.
              // A reload hands the capture a clean MSE session, which is what
              // actually closes these holes — the same thing that fixed Shorts.
              // content_ui bounds this to two reloads and then reports honestly.
              exhaustedDetails.reloadRequired = fatal;
              error.novaFatal = fatal;
              error.details = exhaustedDetails;
              throw error;
            };
            const assembleCapturedMse = async (onRecoveryProgress) => {
              try {
                // A complete pass must already contain its opening edge and,
                // for video, the verified final frame.
                return assembleForCurrentDownload();
              } catch (error) {
                const details = error?.details;
                const brokenWebmEdge = details?.container === 'webm'
                  && (details?.missingTail === true
                    || details?.missingPrefix === true
                    || details?.missingInterior === true
                    || Number(details?.firstTimecode) > 5_000);
                const brokenMp4Prefix = details?.container === 'mp4'
                  && Number(details?.firstDecodeTime) > 0;
                if (!brokenWebmEdge && !brokenMp4Prefix) throw error;

                if (details?.container === 'webm') {
                  return await repairCapturedWebmLocally(error, onRecoveryProgress);
                }

                if (brokenMp4Prefix && (details?.kind === 'audio' || details?.kind === 'video')) {
                  // Same bounded local repair the WebM tracks get: re-request
                  // only the missing opening fragments instead of a reload.
                  let currentDetails = details;
                  for (let attempt = 0; attempt < 2; attempt++) {
                    throwIfDownloadCancelled();
                    try {
                      await refillMissingMp4Prefix(currentDetails.kind, currentDetails, (pct) => {
                        onRecoveryProgress?.(pct, 'buffering-prefix');
                      });
                    } catch (refillError) {
                      log('assembly', 'bounded MP4 prefix refill failed:', refillError?.message || refillError);
                      break;
                    }
                    try {
                      return assembleForCurrentDownload();
                    } catch (nextError) {
                      const nextDetails = nextError?.details;
                      if (nextDetails?.container === 'mp4'
                        && Number(nextDetails?.firstDecodeTime) > 0
                        && (nextDetails?.kind === 'audio' || nextDetails?.kind === 'video')) {
                        currentDetails = nextDetails;
                        continue;
                      }
                      throw nextError;
                    }
                  }
                }

                const completedReloads = Math.max(0, Number(reloadCount) || 0);
                if (completedReloads < 2) {
                  const retry = new Error(
                    details?.missingInterior
                      ? 'обнаружен пропущенный внутренний медиасегмент; дорожка будет скачана заново'
                      : 'крайние сегменты повреждены; медиадорожка будет скачана заново',
                  );
                  retry.novaFatal = true;
                  retry.details = {
                    ...details,
                    reloadRequired: true,
                    reason: details?.missingInterior ? 'interior-gap-validation' : 'edge-validation',
                    videoId: vidId(),
                    reloadCount: completedReloads,
                  };
                  log('assembly', 'track continuity validation requested one full fresh MSE redownload',
                    JSON.stringify(retry.details));
                  throw retry;
                }

                error.novaFatal = true;
                error.details = {
                  ...details,
                  reloadRequired: false,
                  reason: 'edge-redownload-exhausted',
                  videoId: vidId(),
                  reloadCount: completedReloads,
                };
                throw error;
              }
            };
            const captureSequentialVideo = async (reason) => {
              log('capture', 'retry with sequential MSE before rendered 1x:', reason?.message || reason);
              reportMseProgress(0, 'mse-sequential-video');
              cap = await captureBackgroundSequentialReset(
                { targetQ, end, isMp3: false, height },
                (pct) => reportMseProgress(pct, 'mse-sequential-video'),
              );
              usedSequentialMse = true;
              mseCaptured = true;
            };
            const captureRenderedVideoFallback = async (reason) => {
              log('capture', 'fallback to rendered video:', reason?.message || reason);
              reply({ progress: 0.001, phase: 'rendered-video' });
              try {
                await withDeliberatePlayback(() => preparePlayerForRenderedCapture(vidId(), targetQ));
              } catch (prepareError) {
                if (prepareError?.novaFatal) throw prepareError;
                log('rendered-video', 'player preparation unavailable:', prepareError?.message || prepareError);
              }
              const rendered = await withDeliberatePlayback(() => captureRenderedVideo(
                { targetQ, end, height },
                (pct, state) => reply({ progress: pct, phase: 'rendered-video', paused: state === 'paused' }),
              ));
              cap = { actualHeight: rendered.actualHeight, duration: rendered.duration };
              result = rendered;
            };
            // Field observation: a manual page reload reliably revives a wedged
            // SABR session, while the rendered 1x recording is painfully slow.
            // Prefer the automatic reload retry and keep 1x as the very last
            // resort after both reload attempts are spent.
            const renderedOrReload = async (reason) => {
              throwIfDownloadCancelled();
              const completedReloads = Math.max(0, Number(reloadCount) || 0);
              if (completedReloads < 2) {
                const retry = new Error('получение сегментов остановилось; страница будет обновлена, загрузка продолжится автоматически');
                retry.novaFatal = true;
                retry.details = {
                  reloadRequired: true,
                  reason: 'capture-stalled',
                  cause: String(reason?.message || reason || ''),
                  videoId: vidId(),
                  reloadCount: completedReloads,
                };
                log('capture', 'requesting automatic page reload instead of rendered 1x fallback:',
                  retry.details.cause);
                throw retry;
              }
              await captureRenderedVideoFallback(reason);
            };
            try {
              cap = await captureBackground({
                targetQ, end, isMp3, height,
                forceFreshVideo: Boolean(completedAudioForVideo
                  && store.mp3Isolation?.videoId === vidId()),
                mp3FillerHeight: store.mp3Isolation?.fillerHeight,
                freshPageResume: Boolean(freshPageResume),
                reloadCount: Math.max(0, Number(reloadCount) || 0),
              }, (pct) => {
                reportMseProgress(pct, 'buffering');
              });
              mseCaptured = true;
            } catch (captureError) {
              if (captureError?.novaFatal) throw captureError;

              if (!result && isMp3) {
                throwIfDownloadCancelled();
                const completedReloads = Math.max(0, Number(reloadCount) || 0);
                if (completedReloads < 2) {
                  const retry = new Error('получение аудиосегментов остановилось; страница будет обновлена, загрузка продолжится автоматически');
                  retry.novaFatal = true;
                  retry.details = {
                    reloadRequired: true,
                    reason: 'capture-stalled',
                    cause: String(captureError?.message || captureError || ''),
                    videoId: vidId(),
                    reloadCount: completedReloads,
                  };
                  log('capture', 'requesting automatic page reload instead of rendered audio fallback:',
                    retry.details.cause);
                  throw retry;
                }
                log('capture', 'fallback to rendered audio after MSE:', captureError?.message || captureError);
                reply({ progress: 0.001, phase: 'rendered-audio' });
                const renderedAudio = await withDeliberatePlayback(() => captureRenderedAudio(
                  end,
                  (pct, state) => reply({
                    progress: pct, phase: 'rendered-audio', paused: state === 'paused',
                  }),
                ));
                cap = { duration: renderedAudio.duration || Number(video()?.duration) || 0 };
                result = { audio: renderedAudio };
              } else if (!result) {
                try {
                  await captureSequentialVideo(captureError);
                } catch (sequentialError) {
                  if (sequentialError?.novaFatal) throw sequentialError;
                  await renderedOrReload(sequentialError);
                }
              }
            }
            if (mseCaptured) {
              reportMseProgress(mseProgress, 'assembling');
              try {
                result = await assembleCapturedMse((pct, recoveryPhase = 'buffering-prefix') => {
                  reportMseProgress(pct, recoveryPhase);
                });
              } catch (assemblyError) {
                if (assemblyError?.novaFatal || isMp3) throw assemblyError;
                if (!usedSequentialMse) {
                  try {
                    await captureSequentialVideo(assemblyError);
                    result = await assembleCapturedMse((pct, recoveryPhase = 'buffering-prefix') => {
                      reportMseProgress(pct, recoveryPhase);
                    });
                  } catch (sequentialError) {
                    if (sequentialError?.novaFatal) throw sequentialError;
                    await renderedOrReload(sequentialError);
                  }
                } else {
                  await renderedOrReload(assemblyError);
                }
              }
            }
          }
          let aud = result.audio;
          if (!aud) throw new Error('не удалось захватить аудио');
          if (isMp3) {
            aud = validateDirectAudioTrack(
              aud,
              Number(cap?.duration) || Number(video()?.duration)
                || Number(player()?.getDuration?.()) || 0,
            );
            result.audio = aud;
            cacheCompletedAudio(aud, cap?.duration);
          }
          else {
            store.completedAudioCache = null;
            store.mp3Isolation = null;
          }
          const payload = {
            ok: true,
            done: true,
            audio: { mime: aud.mime, size: aud.bytes.byteLength, captureRate: Number(aud.captureRate) || 1 },
            actualHeight: result.video?.height || (cap && cap.actualHeight),
            duration: cap && cap.duration,
            forceTranscode: Boolean(result.forceTranscode),
          };
          const transfers = [aud.bytes.buffer];
          payload._a = aud.bytes.buffer;
          if (!isMp3) {
            const vid = result.video;
            if (!vid) throw new Error('не удалось захватить видео');
            payload.video = { mime: vid.mime, size: vid.bytes.byteLength, height: vid.height || null };
            payload._v = vid.bytes.buffer;
            transfers.push(vid.bytes.buffer);
            if (result.videoPrefix?.bytes?.byteLength
              && Number(result.videoPrefixBoundary) > 0) {
              payload.videoPrefix = {
                mime: result.videoPrefix.mime,
                size: result.videoPrefix.bytes.byteLength,
                height: result.videoPrefix.height || null,
                boundary: Number(result.videoPrefixBoundary),
              };
              payload._vp = result.videoPrefix.bytes.buffer;
              transfers.push(result.videoPrefix.bytes.buffer);
            }
          }
          reply(payload, transfers);
        } finally {
          store.cancelRequested = false;
          store.capturing = true;
          store.musicSeekClamp = false;
          store.playbackHold?.release();
          store.playbackHold = null;
          store.silenceHeld = false;
          releaseSilenceClamp();
          if (loopedAtStart && mediaAtStart && vidId() === videoIdAtStart) {
            try { mediaAtStart.loop = true; } catch (e) {}
          }
          clearInterval(silenceTimer);
          for (const [element, wasMuted] of silenced) {
            try {
              element.removeEventListener('volumechange', enforceSilence);
              if (!wasMuted && vidId() === videoIdAtStart) element.muted = false;
            } catch (e) {}
          }
          silenced.clear();
          if ((musicHost ? musicAppMuted : playerMutedBefore) === false) {
            try { player()?.unMute?.(); } catch (e) {}
          }
          // Give the user back exactly the play state they had.
          if (wasPlayingAtStart && vidId() === videoIdAtStart) {
            try { video()?.play()?.catch?.(() => {}); } catch (e) {}
          }
          await restoreQuality(previousQuality);
        }
      } else if (cmd === 'subtitles') {
        const res = await getSubtitles();
        reply({ ok: true, done: true, text: res.text, cues: res.cues || null, lang: res.lang });
      } else if (cmd === 'subs-available') {
        const a = subsAvailable();
        reply({ ok: true, available: a.available, lang: a.lang });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e), details: e?.details });
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (vidId() !== store.videoId) {
      store.videoId = vidId();
      store.mediaEpochStart = performance.now();
      store.completedAudioCache = null;
      store.mp3Isolation = null;
      resetCapture();
    }
    if (!store.liveSession) store.capturing = true; // keep passive capture on while watching
    scheduleAutoplayOff();
    scheduleDefaultQuality();
  });

  document.addEventListener('click', (event) => {
    const item = event.target?.closest?.('.ytp-menuitem');
    const text = (item?.textContent || '').replace(/\s+/g, ' ').trim();
    if (item && (/\b(?:4320|2160|1440|1080|720|480|360|240|144)\s*p\b/i.test(text)
      || /quality|качество/i.test(text))) {
      manuallySelectedQualityVideoId = vidId();
      manualQualityRevision += 1;
    }
  }, true);

  function scheduleAutoplayOff() {
    let tries = 20;
    (function tick() {
      if (keepAutoplayOff() || tries-- <= 0) return;
      setTimeout(tick, 1000);
    })();
  }
  scheduleAutoplayOff();
  scheduleDefaultQuality();

  store.videoId = vidId();
  store.capturing = true; // passive capture from page load
  log('hook', 'installed; ctx=', (location.pathname.indexOf('/embed/') === 0 ? 'embed-iframe' : 'page'), 'vid=', vidId(), JSON.stringify({
    mediaSource: typeof window.MediaSource === 'function',
    managedMediaSource: typeof window.ManagedMediaSource === 'function',
    mseInWorker: Boolean(window.MediaSource?.canConstructInDedicatedWorker),
    captureStream: typeof HTMLMediaElement.prototype.captureStream === 'function'
      || typeof HTMLMediaElement.prototype.mozCaptureStream === 'function',
    mediaRecorder: typeof window.MediaRecorder === 'function',
  }));
})();
