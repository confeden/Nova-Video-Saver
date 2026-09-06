// Service worker: owns the offscreen document, persistent diagnostics and
// browser downloads. ffmpeg.wasm itself runs in offscreen.html.

const LOG_KEY = 'nova_logs';
const LOG_LIMIT = 400;
const LOG_ENTRY_LIMIT = 4_000;
const ERROR_DETAIL_LIMIT = 50_000;
const ERROR_LOG_FILENAME = 'NVS-debug.txt';
const RELOAD_DOWNLOAD_PREFIX = 'nova_reload_download:';
const RELOAD_GUARD_PREFIX = 'nova_reload_guard:';
const RELOAD_GUARD_TTL_MS = 5 * 60_000;
const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/confeden/nova_updates/main/nvs.json';
const UPDATE_FALLBACK_API = 'https://api.github.com/repos/confeden/Nova-Video-Saver/releases/latest';
const UPDATE_RELEASES_PAGE = 'https://github.com/confeden/Nova-Video-Saver/releases';
const UPDATE_STATE_KEY = 'nova_update';
const UPDATE_ALARM = 'nvs-update-check';
const UPDATE_CHECK_PERIOD_MINUTES = 8 * 60;
const HANDLED_MESSAGES = new Set([
  'nova-check-update',
  'nova-fetch-cover',
  'nova-reload-tab',
  'nova-navigate-tab',
  'nova-log',
  'nova-error',
  'nova-ensure',
  'nova-save',
  'nova-download-state',
  'nova-fetch-caption',
  'nova-register-job',
  'nova-progress',
  'nova-set-reload-download',
  'nova-get-reload-download',
  'nova-clear-reload-download',
  'nova-clear-reload-guard',
  'nova-ping',
  'nova-flush-recovered',
]);
const RECOVERY_KEY = 'nova_recovered';

let offscreenCreation;
let logWrite = Promise.resolve();
let reloadGuardWrite = Promise.resolve();

function serialize(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function truncate(value, limit) {
  const text = serialize(value) || '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString();
}

// A report is read top to bottom by a human looking for one failing download.
// Repeats are folded into a counter and long idle stretches are marked, so the
// boundaries between separate attempts are visible instead of having to be
// reconstructed from timestamps.
const LOG_GAP_MARKER_MS = 2 * 60_000;

function formatLogLines(logs) {
  const lines = [];
  let previousTs = 0;
  for (const entry of logs) {
    const ts = Number(entry?.ts) || 0;
    if (previousTs && ts - previousTs >= LOG_GAP_MARKER_MS) {
      const minutes = Math.round((ts - previousTs) / 60_000);
      lines.push('', `--- пауза ${minutes} мин ---`, '');
    }
    const repeat = Number(entry?.repeat) || 1;
    const lastTs = Number(entry?.lastTs) || ts;
    const suffix = repeat > 1 ? ` (×${repeat}, последний ${formatTimestamp(lastTs)})` : '';
    lines.push(`[${formatTimestamp(ts)}] [${entry?.tag || 'log'}] ${entry?.text || ''}${suffix}`);
    previousTs = lastTs;
  }
  return lines;
}

function appendLog(entry) {
  // Serialize read-modify-write operations so concurrent content-script logs
  // cannot overwrite one another in chrome.storage.local.
  logWrite = logWrite
    .catch(() => {})
    .then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      // A retried operation writes the same line over and over (primers,
      // refill attempts, bridge timeouts). Counting them keeps the fact and
      // its cadence while spending one slot of the ring instead of dozens.
      const last = logs[logs.length - 1];
      if (last && last.tag === entry.tag && last.text === entry.text) {
        last.repeat = (Number(last.repeat) || 1) + 1;
        last.lastTs = entry.ts;
      } else {
        logs.push(entry);
      }
      await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-LOG_LIMIT) });
    });
  return logWrite;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS', 'BLOBS'],
      justification: 'Run ffmpeg.wasm to assemble captured media tracks.',
    }).finally(() => { offscreenCreation = undefined; });
  }
  await offscreenCreation;
}

// Finished files the offscreen document could not hand over (see the recovery
// store there). Flushing needs that document, so it is created on demand.
async function flushRecoveredFiles() {
  const stored = await chrome.storage.local.get(RECOVERY_KEY).catch(() => ({}));
  const entries = Array.isArray(stored[RECOVERY_KEY]) ? stored[RECOVERY_KEY] : [];
  if (!entries.some((entry) => entry && !entry.savedAt)) return { ok: true, saved: 0, pending: 0 };
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ t: 'nova-flush' })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  return result || { ok: false, error: 'обработчик медиа не ответил' };
}

// Windows refuses these as a base name whatever the extension is.
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Chrome does not fail a download whose filename it cannot use — it quietly
// generates one from the URL instead, and for a blob: URL that is the blob's
// UUID plus an extension guessed from the MIME type. That is where finished
// files were landing as `50b453d3-4e0a-4112-a2d2-ec6fe31a2ee5.m4a`.
//
// The two ways a name got there:
//   * a title cut with String.slice landed inside a surrogate pair, leaving a
//     lone surrogate — the string is then not valid UTF-8 and Chrome discards
//     the whole name;
//   * a title made entirely of characters the callers strip («?», «|») left an
//     empty base, so the name was just ".m4a".
// Both are repaired here rather than in each adapter, so no site can reach
// chrome.downloads with a name the browser will silently replace.
function repairFilename(value) {
  const raw = String(value || '');
  const match = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/s.exec(raw) || [];
  let base = match[1] || '';
  const extension = match[2] || '';
  base = base
    // Lone surrogates first: everything after this can assume valid text.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot makes the whole thing read as an extension; a trailing dot
    // or space is rejected outright on Windows.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  // By code points, so the truncation itself cannot recreate the lone surrogate
  // this function exists to remove.
  const points = [...base];
  // Trailing dots and spaces are stripped again after the cut, not only before
  // it: truncating «…AAA. more text» at 120 leaves «…AAA.», which Windows
  // rejects just as it rejects the original.
  if (points.length > 120) base = points.slice(0, 120).join('').replace(/[. ]+$/, '').trim();
  if (RESERVED_DEVICE_NAMES.test(base)) base = `_${base}`;
  if (!base) base = 'nova-download';
  return `${base}${extension}`;
}

async function saveDownload(url, filename) {
  if (typeof url !== 'string' || !url) throw new Error('download URL is missing');
  if (typeof filename !== 'string' || !filename) throw new Error('download filename is missing');
  const repaired = repairFilename(filename);
  if (repaired !== filename) {
    // Logged, not silent: the repair hides the symptom, and without this line
    // the next bad title would be just as invisible as the first one was.
    void appendLog({
      ts: Date.now(),
      tag: 'download',
      text: `filename repaired: ${JSON.stringify(filename)} -> ${JSON.stringify(repaired)}`,
    }).catch(() => {});
  }
  return chrome.downloads.download({ url, filename: repaired, saveAs: false });
}

function validateCaptionUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext') {
    throw new Error('caption URL is not allowed');
  }
  return url.href;
}

async function downloadErrorLog(message, sender) {
  await logWrite.catch(() => {});
  const stored = await chrome.storage.local
    .get([LOG_KEY, 'nvs_playlist_queue', UPDATE_STATE_KEY, RECOVERY_KEY])
    .catch(() => ({}));
  const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  // Extension state snapshot: without it "silent" misbehaviour (stalled
  // queues, stale pending downloads) is invisible in reports.
  const sessionState = await chrome.storage.session.get(null).catch(() => ({}));
  const state = {
    playlistQueue: stored.nvs_playlist_queue || null,
    updateState: stored[UPDATE_STATE_KEY] || null,
    recovered: stored[RECOVERY_KEY] || null,
    session: sessionState,
  };
  const report = [
    'Nova Video Saver error report',
    `Time: ${new Date().toISOString()}`,
    `Version: ${chrome.runtime.getManifest().version}`,
    `Context: ${message.context || 'unknown'}`,
    `Page: ${sender?.tab?.url || 'extension'}`,
    `Browser: ${navigator.userAgent}`,
    '',
    truncate(message.error || 'Unknown error', ERROR_DETAIL_LIMIT),
    message.details ? `\nDetails:\n${truncate(message.details, ERROR_DETAIL_LIMIT)}` : '',
    `\nState:\n${truncate(state, ERROR_DETAIL_LIMIT)}`,
    logs.length ? `\nRecent logs:\n${formatLogLines(logs).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(`\uFEFF${report}\n`)}`;
  const id = await saveDownload(url, ERROR_LOG_FILENAME);
  return { ok: true, id, filename: ERROR_LOG_FILENAME };
}

// ---- update checks -----------------------------------------------------
// nvs.json in confeden/nova_updates mirrors the desktop/Android updater
// manifests: { version, url, sha256, release_url }. The GitHub releases API
// is only a fallback for the window between a release and the bot commit.

function compareVersions(a, b) {
  const left = String(a || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Both endpoints are routinely unreachable behind filtering, where a fetch can
// hang for minutes and keep this worker busy; bound them.
const UPDATE_FETCH_TIMEOUT_MS = 15_000;

async function fetchLatestVersionInfo() {
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, {
      cache: 'no-store', signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`nvs.json HTTP ${response.status}`);
    const data = await response.json();
    if (!/^\d+(\.\d+)*$/.test(String(data.version || ''))) throw new Error('nvs.json version is malformed');
    return {
      version: String(data.version),
      downloadUrl: typeof data.url === 'string' ? data.url : '',
      releaseUrl: typeof data.release_url === 'string' ? data.release_url : UPDATE_RELEASES_PAGE,
      source: 'nvs.json',
    };
  } catch (manifestError) {
    const response = await fetch(UPDATE_FALLBACK_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`releases API HTTP ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(version)) throw new Error('release tag is malformed');
    const zip = (release.assets || []).find((asset) => /\.zip$/i.test(asset?.name || ''));
    return {
      version,
      downloadUrl: zip?.browser_download_url || '',
      releaseUrl: release.html_url || UPDATE_RELEASES_PAGE,
      source: 'releases-api',
    };
  }
}

async function applyUpdateBadge(available) {
  try {
    await chrome.action.setBadgeText({ text: available ? '+' : '' });
    if (available) {
      await chrome.action.setBadgeBackgroundColor({ color: '#212121' });
      await chrome.action.setBadgeTextColor({ color: '#35d477' });
    }
  } catch (error) { /* action API missing only in tests */ }
}

async function checkForUpdates() {
  const current = chrome.runtime.getManifest().version;
  try {
    const latest = await fetchLatestVersionInfo();
    const available = compareVersions(latest.version, current) > 0;
    const state = {
      available,
      current,
      latest: latest.version,
      downloadUrl: latest.downloadUrl,
      releaseUrl: latest.releaseUrl,
      source: latest.source,
      checkedAt: Date.now(),
      error: '',
    };
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
    await applyUpdateBadge(available);
    return { ok: true, ...state };
  } catch (error) {
    const stored = await chrome.storage.local.get(UPDATE_STATE_KEY).catch(() => ({}));
    const previous = stored[UPDATE_STATE_KEY] || {};
    const state = {
      ...previous,
      current,
      checkedAt: Date.now(),
      error: String(error?.message || error),
    };
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state }).catch(() => {});
    return { ok: false, ...state };
  }
}

function scheduleUpdateChecks() {
  chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES,
  });
}

// A report is read to understand ONE failing download, and entries from earlier
// sessions only bury it: exported logs had grown to hundreds of lines covering
// days, where the run in question was the last twenty. Reloading the extension
// or restarting the browser starts a fresh journal.
//
// Deliberately NOT tied to the service worker starting up: MV3 terminates it
// whenever it is idle, so that would wipe the log between the capture and the
// error report about it — exactly the lines needed.
async function startNewLogSession(reason) {
  await logWrite.catch(() => {});
  logWrite = logWrite.catch(() => {}).then(() => chrome.storage.local
    .set({ [LOG_KEY]: [{ ts: Date.now(), tag: 'session', text: `journal cleared on ${reason}` }] })
    .catch(() => {}));
  return logWrite;
}

chrome.runtime.onInstalled.addListener(() => {
  startNewLogSession('extension reload/update');
  scheduleUpdateChecks();
  checkForUpdates();
  flushRecoveredFiles().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  startNewLogSession('browser start');
  scheduleUpdateChecks();
  checkForUpdates();
  flushRecoveredFiles().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdates();
});

async function handleMessage(message, sender) {
  const reloadDownloadKey = () => {
    if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
    return `${RELOAD_DOWNLOAD_PREFIX}${sender.tab.id}`;
  };
  const reloadGuardKey = () => {
    if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
    return `${RELOAD_GUARD_PREFIX}${sender.tab.id}`;
  };
  switch (message.t) {
    case 'nova-check-update':
      return checkForUpdates();

    // Cover art for audio downloads. Fetched here because content pages are
    // bound by page CORS and the offscreen document by its COEP; the service
    // worker with the i.ytimg.com host permission has neither restriction.
    case 'nova-fetch-cover': {
      const videoId = String(message.videoId || '');
      if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw new Error('некорректный идентификатор видео');
      for (const name of ['maxresdefault', 'hqdefault']) {
        try {
          const response = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`, { cache: 'no-store' });
          if (!response.ok) continue;
          const buffer = new Uint8Array(await response.arrayBuffer());
          // A real JPEG only: ffmpeg embeds it as the ID3/covr picture as-is.
          if (buffer.length < 2_000 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) continue;
          let binary = '';
          const step = 0x8000;
          for (let offset = 0; offset < buffer.length; offset += step) {
            binary += String.fromCharCode(...buffer.subarray(offset, Math.min(offset + step, buffer.length)));
          }
          return { ok: true, b64: btoa(binary), source: name };
        } catch (error) { /* try the next thumbnail size */ }
      }
      return { ok: false, error: 'обложка недоступна' };
    }

    // YouTube's SPA router can intercept page-initiated location.reload()/
    // assign() and keep a wedged media session alive. Browser-level tab
    // reloads/navigations (what a manual F5 does) cannot be intercepted.
    case 'nova-reload-tab': {
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('вкладка не определена');
      await chrome.tabs.reload(sender.tab.id);
      return { ok: true };
    }

    case 'nova-navigate-tab': {
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('вкладка не определена');
      const url = new URL(String(message.url || ''));
      const allowedOrigins = ['https://www.youtube.com', 'https://music.youtube.com'];
      if (!allowedOrigins.includes(url.origin) || url.pathname !== '/watch') {
        throw new Error('навигация разрешена только на страницы просмотра YouTube');
      }
      await chrome.tabs.update(sender.tab.id, { url: url.href });
      return { ok: true };
    }

    case 'nova-log':
      await appendLog({
        ts: Date.now(),
        tag: message.tag,
        text: truncate(message.text, LOG_ENTRY_LIMIT),
        tab: sender?.tab?.id,
        frame: sender?.frameId,
      });
      return { ok: true };

    case 'nova-error':
      return downloadErrorLog(message, sender);

    case 'nova-ensure':
      await ensureOffscreen();
      return { ok: true };

    // Heartbeat from the offscreen document. Receiving it resets this
    // worker's idle timer, so a long mux can no longer outlive the worker
    // that has to accept its result.
    case 'nova-ping':
      return { ok: true };

    case 'nova-flush-recovered':
      return flushRecoveredFiles();

    case 'nova-save': {
      const id = await saveDownload(message.url, message.filename);
      return { ok: true, id };
    }

    // A direct save is pulled by the browser itself, so the page has no byte
    // count of its own: without this the on-page panel could only say "handed
    // over" while Chrome's own bubble showed the real progress.
    case 'nova-download-state': {
      const id = Number(message.id);
      if (!Number.isInteger(id)) return { ok: false, error: 'download id is missing' };
      const [item] = await chrome.downloads.search({ id });
      if (!item) return { ok: false, error: 'download not found' };
      return {
        ok: true,
        state: item.state,
        paused: Boolean(item.paused),
        bytesReceived: item.bytesReceived || 0,
        totalBytes: item.totalBytes || item.fileSize || 0,
        error: item.error || '',
      };
    }

    case 'nova-fetch-caption': {
      const response = await fetch(validateCaptionUrl(message.url), {
        credentials: 'include',
        referrer: 'https://www.youtube.com/',
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, len: text.length, text };
    }

    case 'nova-register-job':
      if (!Number.isInteger(sender?.tab?.id)) throw new Error('download tab is unavailable');
      return { ok: true, tabId: sender.tab.id };

    case 'nova-set-reload-download': {
      const pending = message.pending;
      if (!pending || (pending.format !== 'mp4' && pending.format !== 'mp3')
        || !/^[A-Za-z0-9_-]{6,}$/.test(String(pending.videoId || ''))
        || (pending.format === 'mp4' && !Number.isFinite(Number(pending.height)))
        || !Number.isFinite(Number(pending.createdAt))
        || typeof pending.token !== 'string'
        || typeof pending.playerState?.paused !== 'boolean'
        || !Number.isFinite(Number(pending.playerState?.time))
        || typeof pending.playerState?.muted !== 'boolean') {
        throw new Error('invalid reload download request');
      }
      const pendingKey = reloadDownloadKey();
      const guardKey = reloadGuardKey();
      reloadGuardWrite = reloadGuardWrite
        .catch(() => {})
        .then(async () => {
          const now = Date.now();
          const stored = await chrome.storage.session.get(guardKey);
          const guard = stored[guardKey];
          const sameActiveJob = guard
            && guard.videoId === String(pending.videoId)
            && guard.format === pending.format
            && now - Number(guard.updatedAt) <= RELOAD_GUARD_TTL_MS;
          const reloadCount = sameActiveJob ? Number(guard.reloadCount) + 1 : 1;
          if (reloadCount > 2) {
            return {
              ok: false,
              reloadBlocked: true,
              error: 'повторная загрузка краёв уже выполнялась дважды; циклическое обновление остановлено',
            };
          }
          const audioFormat = ['original', 'mp3', 'm4a', 'aac', 'flac', 'wav']
            .includes(pending.audioFormat) ? pending.audioFormat : null;
          await chrome.storage.session.set({
            [guardKey]: {
              videoId: String(pending.videoId),
              format: pending.format,
              reloadCount,
              updatedAt: now,
            },
            [pendingKey]: {
              videoId: String(pending.videoId),
              title: String(pending.title || '').slice(0, 300),
              duration: Math.max(0, Number(pending.duration) || 0),
              format: pending.format,
              audioFormat,
              height: pending.format === 'mp3' ? null : Number(pending.height),
              createdAt: Number(pending.createdAt),
              token: pending.token.slice(0, 100),
              reloadAttempted: true,
              reloadCount,
              playerState: {
                paused: pending.playerState.paused,
                time: Math.max(0, Number(pending.playerState.time)),
                muted: pending.playerState.muted,
              },
            },
          });
          return { ok: true, reloadCount };
        });
      return reloadGuardWrite;
    }

    case 'nova-get-reload-download': {
      const key = reloadDownloadKey();
      const stored = await chrome.storage.session.get(key);
      return { ok: true, pending: stored[key] || null };
    }

    case 'nova-clear-reload-download':
      await chrome.storage.session.remove(reloadDownloadKey());
      return { ok: true };

    case 'nova-clear-reload-guard':
      await chrome.storage.session.remove([reloadDownloadKey(), reloadGuardKey()]);
      return { ok: true };

    case 'nova-progress': {
      if (sender?.url !== chrome.runtime.getURL('offscreen.html')) {
        throw new Error('progress messages are only accepted from the media processor');
      }
      if (!Number.isInteger(message.tabId)) throw new Error('progress tab is unavailable');
      await chrome.tabs.sendMessage(message.tabId, {
        t: 'nova-progress',
        jobId: message.jobId,
        value: message.value,
        percent: message.percent,
        ...(message.status ? { status: message.status } : {}),
      });
      return { ok: true };
    }

    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !HANDLED_MESSAGES.has(message.t)) return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: serialize(error?.stack || error) }));
  return true;
});
