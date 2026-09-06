// Shared user settings: one storage key, one shape, one place that knows the
// defaults. Loaded both as a content script (before content_ui.js /
// twitch_ui.js, which share one isolated world with it) and as a plain script
// in the popup, so the two never disagree about what "по умолчанию" means.
//
// Quality is stored as a number of scanlines, or one of two words:
//   'auto' — follow the monitor the tab is on. This is the default, and it is
//            deliberately NOT resolved at save time: a laptop docked to a 1440p
//            screen and undocked to a 1080p one must follow, so the number is
//            worked out where and when the player is actually being set up.
//   'max'  — always the best rung the site offers.
(() => {
  const KEY = 'nova_settings';

  // The locks are ON by default: the complaint they answer is the player
  // quietly dropping to 360p and staying there, which is the normal state
  // without them, not an edge case.
  const DEFAULTS = {
    youtubeQuality: 'auto',
    youtubeLock: true,
    twitchQuality: 'auto',
    twitchLock: true,
  };

  // Rungs offered in the popup. YouTube and Twitch top out differently, and a
  // value the site never serves would silently behave like the nearest lower
  // one, so the two lists are kept apart.
  const YOUTUBE_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
  const TWITCH_HEIGHTS = [1080, 720, 480, 360, 160];

  function normalizeQuality(value, allowed) {
    if (value === 'auto' || value === 'max') return value;
    const height = Number(value);
    return allowed.includes(height) ? height : 'auto';
  }

  // `?? DEFAULTS` and not `Boolean(...)`: an absent key means "never chosen",
  // which has to fall back to the default. Coercing it would silently turn the
  // locks off for everyone who has not opened the popup yet.
  function normalize(raw) {
    const stored = raw && typeof raw === 'object' ? raw : {};
    return {
      youtubeQuality: normalizeQuality(stored.youtubeQuality, YOUTUBE_HEIGHTS),
      youtubeLock: stored.youtubeLock == null ? DEFAULTS.youtubeLock : Boolean(stored.youtubeLock),
      twitchQuality: normalizeQuality(stored.twitchQuality, TWITCH_HEIGHTS),
      twitchLock: stored.twitchLock == null ? DEFAULTS.twitchLock : Boolean(stored.twitchLock),
    };
  }

  // The short edge, not the height: a monitor in portrait orientation is still
  // a 1440p monitor. devicePixelRatio is folded in because a 100 % scaled
  // 1440p panel reports 1440 while a 150 % scaled one reports 960, and the
  // panel is what decides how much detail is worth downloading.
  //
  // `screen` reports the display the window currently sits on, so moving the
  // tab to the second monitor changes the answer — which is the whole point of
  // 'auto'.
  function monitorHeight() {
    const ratio = Number(window.devicePixelRatio) || 1;
    const shortEdge = Math.min(Number(screen.width) || 0, Number(screen.height) || 0) * ratio;
    if (shortEdge >= 2160) return 2160;
    if (shortEdge >= 1440) return 1440;
    if (shortEdge >= 1080) return 1080;
    if (shortEdge >= 720) return 720;
    return 480;
  }

  // Turns a stored value into a concrete number of scanlines. `available` is
  // what the site offers right now, so 'max' and a request the site cannot
  // serve both land on a rung that exists.
  function resolveHeight(value, available) {
    const rungs = (Array.isArray(available) ? available : [])
      .map(Number).filter((height) => height > 0)
      .sort((left, right) => right - left);
    if (!rungs.length) return null;
    if (value === 'max') return rungs[0];
    const target = value === 'auto' || value == null ? monitorHeight() : Number(value);
    // The best rung that does not exceed the target; if every rung is above it
    // (a target of 480 on a source that starts at 720) take the lowest.
    return rungs.find((height) => height <= target) ?? rungs[rungs.length - 1];
  }

  async function load() {
    const stored = await chrome.storage.local.get(KEY).catch(() => ({}));
    return normalize(stored?.[KEY]);
  }

  // Serialised, for the same reason background.js serialises its journal writes:
  // save() is a read-modify-write, and the popup fires one per control with
  // nothing between them. Two overlapping saves let the second read the state
  // from before the first had been stored and write it back — the earlier choice
  // silently reverts while the popup still says «Сохранено».
  let writeChain = Promise.resolve();

  function save(patch) {
    writeChain = writeChain.catch(() => {}).then(async () => {
      const current = await load();
      const next = normalize({ ...current, ...patch });
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    });
    return writeChain;
  }

  // Fires with the whole normalized object, so a listener never has to merge
  // a partial update itself.
  function subscribe(onChange) {
    const listener = (changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      onChange(normalize(changes[KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  globalThis.NovaSettings = {
    KEY, DEFAULTS, YOUTUBE_HEIGHTS, TWITCH_HEIGHTS,
    normalize, monitorHeight, resolveHeight, load, save, subscribe,
  };
})();
