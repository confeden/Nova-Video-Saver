// Copy-remux on a worker thread, fed while the tracks are still arriving.
//
// mediabunny used to run on the offscreen document's own main thread, and a
// 700 s video occupied it for more than a minute: the document stopped
// answering messages entirely — `nova-finalize` sat in its queue for 68 s while
// the assembly was already finished — and the browser felt frozen down to the
// extensions panel. The work is identical here, it simply no longer blocks the
// thread that has to keep talking to the rest of the extension.
//
// Three findings decide the shape of this file. All three were reproduced
// against this exact vendored build (mediabunny 1.51.0).
//
// 1. Declaring a size SMALLER than the real track truncates the output in
//    SILENCE. Reads are clamped to the declared size and both the ISOBMFF and
//    the Matroska demuxer treat a slice past it as end of file, with no error.
//    That is the 14.4 MB file made from 62.8 MB of tracks in ROADMAP 3.2 — and
//    the duration check waved it through because mediabunny writes
//    `mvhd.duration` as the MAXIMUM over the output tracks, so the one complete
//    track (audio) declared the full length while the video stopped a quarter
//    of the way in. Nothing here declares a size any more.
//
// 2. A sized source cannot overlap the transfer at all for a fragmented MP4.
//    `Conversion.init` probes the LAST FOUR BYTES of the file (the mfra index)
//    the moment the source reports a size, so the parse cannot begin until the
//    final byte has arrived. Measured overlap with the previous StreamSource:
//    zero. `ReadableStreamSource` reports no size until its stream closes, so
//    the tail probe is skipped and init returns in about a tenth of a second.
//    Its cache holds references to the very chunks below, not copies.
//
// 3. `conversion.onProgress` is not free. Setting it makes `execute()`
//    precompute the duration first, and for a fragmented MP4 that is
//    `getPacket(Infinity)` — a walk to the last fragment before a single packet
//    is copied. It defeats the streaming and blows the sliding cache. The
//    document's stall guard is fed from the source's read callback instead.
//
// The bytes are transferred in, never copied. A failed mux hands them back so
// the document can still run the proven buffered path.

// Generous, and nearly free: the cache stores references to chunks this worker
// holds anyway. It only bounds how far back the parser may seek before the
// source gives up — loudly, with "Read is before the cached region".
const CACHE_BYTES = 64 * 1024 * 1024;
const TICK_INTERVAL_MS = 400;

const tracks = {
  video: createTrack(),
  audio: createTrack(),
};
let mediabunny;
let muxStarted = false;

function createTrack() {
  return {
    // Kept only so a failed mux can surrender them; these are the same objects
    // the ReadableStream and mediabunny's cache reference, so they cost nothing
    // beyond the array itself.
    chunks: [],
    received: 0,
    // What the document says it will send. Display only — it is NEVER handed to
    // mediabunny, which is the whole point of finding 1 above.
    announced: 0,
    consumed: 0,
    controller: null,
    stream: null,
    closed: false,
    // Set once mediabunny has read this track to its end. Gates the heartbeat:
    // see startHeartbeat.
    fullyRead: false,
    failure: null,
  };
}

function openTrack(track) {
  // The start callback runs synchronously inside the constructor, so the
  // controller is available immediately after this line.
  track.stream = new ReadableStream({
    start(controller) { track.controller = controller; },
  });
  // `start` is posted before any chunk, so in practice there is no backlog.
  // Replaying one anyway is two lines, and the alternative — silently dropping
  // chunks that arrived first — is the exact silent-truncation shape this file
  // exists to make impossible.
  for (const chunk of track.chunks) track.controller.enqueue(chunk);
  // Settled before the stream existed: replay that too, and go through the
  // controller directly — failTrack/closeTrack are guarded against repeats.
  try {
    if (track.failure) track.controller.error(track.failure);
    else if (track.closed) track.controller.close();
  } catch (error) { /* already settled */ }
}

function pushChunk(track, bytes) {
  track.chunks.push(bytes);
  track.received += bytes.length;
  track.controller?.enqueue(bytes);
}

function closeTrack(track) {
  if (track.closed || track.failure) return;
  track.closed = true;
  try { track.controller?.close(); } catch (error) { /* already closed */ }
}

function failTrack(track, error) {
  if (track.failure) return;
  track.failure = error instanceof Error ? error : new Error(String(error));
  try { track.controller?.error(track.failure); } catch (e) { /* already settled */ }
}

let lastTickAt = 0;
let heartbeat = null;

// The document kills a mux that stays silent for 120 s, and that guard is the
// ONLY thing that turns a wedged mux (a mediabunny deadlock, a track stream
// that never closes) into a recoverable fallback to ffmpeg. So the heartbeat
// must NOT run for the whole mux — that would keep the guard's clock reset
// forever and make a real hang unrecoverable.
//
// The only phase that is legitimately silent is the tail: once mediabunny has
// read both tracks to the end, `source.onread` stops firing, but `execute()`
// is still assembling and `output.finalize()` writes `moov` — reading nothing.
// That silence (measured at ~2 min on a 269 MB pair) tripped the guard and
// threw away a working mux. So the heartbeat starts exactly when both tracks
// are fully read: before that, silence still means a genuine stall and the
// guard rightly fires; after it, the tick says "assembling, still alive".
function maybeStartTailHeartbeat() {
  if (heartbeat) return;
  if (!tracks.video.fullyRead || !tracks.audio.fullyRead) return;
  heartbeat = setInterval(() => { self.postMessage({ t: 'tick' }); }, 1_000);
}

function stopHeartbeat() {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

// One definition of "read to the end", shared by the tail-heartbeat gate and
// the final truncation guard so they can never disagree. The tolerance matters:
// a copy remux legitimately leaves a few trailing bytes unread (padding, a
// closing box), so an exact `consumed === received` would keep the heartbeat
// from ever arming on a healthy mux and let a slow `finalize()` trip the guard —
// the very false-positive this whole mechanism removes.
function trackReadToEnd(track) {
  if (!track.closed) return false;
  const missed = track.received - track.consumed;
  return missed <= Math.max(65_536, track.received * 0.02);
}

function reportProgress() {
  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return;
  lastTickAt = now;
  const announced = tracks.video.announced + tracks.audio.announced;
  const consumed = tracks.video.consumed + tracks.audio.consumed;
  if (announced > 0) {
    self.postMessage({ t: 'progress', value: Math.max(0, Math.min(1, consumed / announced)) });
  } else {
    self.postMessage({ t: 'tick' });
  }
}

function trackSource(ReadableStreamSource, track) {
  const source = new ReadableStreamSource(track.stream, { maxCacheSize: CACHE_BYTES });
  // Fires once per chunk pulled out of the stream, with the cumulative byte
  // range. It is both the liveness signal and, at the end, the proof that the
  // parser walked the whole track rather than stopping early.
  source.onread = (_start, end) => {
    if (end > track.consumed) track.consumed = end;
    // The last read of a closed track means mediabunny reached its end; from
    // here this track is silent by right, so it may arm the tail heartbeat.
    if (!track.fullyRead && trackReadToEnd(track)) {
      track.fullyRead = true;
      maybeStartTailHeartbeat();
    }
    reportProgress();
  };
  return source;
}

async function mux() {
  const {
    Input, Output, Conversion, ALL_FORMATS, ReadableStreamSource, BufferTarget, Mp4OutputFormat,
  } = mediabunny;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoInput = new Input({
    formats: ALL_FORMATS, source: trackSource(ReadableStreamSource, tracks.video),
  });
  const audioInput = new Input({
    formats: ALL_FORMATS, source: trackSource(ReadableStreamSource, tracks.audio),
  });
  // Both of these resolve as soon as each track's header has arrived, which is
  // the first chunk or two — not the whole file.
  const videoConversion = await Conversion.init({
    input: videoInput, output, composable: true, audio: { discard: true },
  });
  const audioConversion = await Conversion.init({
    input: audioInput, output, composable: true, video: { discard: true },
  });
  const discarded = [...videoConversion.discardedTracks, ...audioConversion.discardedTracks];
  if (discarded.length) {
    throw new Error(`дорожка не поддерживается: ${discarded.map((entry) => entry.reason).join(', ')}`);
  }
  self.postMessage({ t: 'parsing' });
  await output.start();
  await Promise.all([videoConversion.execute(), audioConversion.execute()]);
  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer?.byteLength) throw new Error('сборка вернула пустой файл');
  // Per-track truncation guard. The output's own duration cannot provide this:
  // `mvhd.duration` is the maximum over the tracks, so a complete audio track
  // hides a video track that stopped early — exactly how the 14.4 MB file
  // passed every check it met. How far the parser actually walked each source
  // cannot be hidden that way.
  for (const [name, track] of Object.entries(tracks)) {
    if (!trackReadToEnd(track)) {
      throw new Error(`дорожка ${name} прочитана не до конца:`
        + ` ${track.consumed} из ${track.received} байт`);
    }
  }
  return new Uint8Array(buffer);
}

// Starts as soon as both streams exist, i.e. at `start` — long before any bytes
// arrive. The parser blocks on its first read until the first chunks land.
function maybeStartMux() {
  if (muxStarted || !mediabunny) return;
  muxStarted = true;
  // The tail heartbeat arms itself once both tracks are fully read (see
  // trackSource.onread); it is not started here, so a stall before then still
  // trips the document's guard.
  (async () => {
    try {
      const bytes = await mux();
      stopHeartbeat();
      self.postMessage({
        t: 'done',
        bytes: bytes.buffer,
        // What the mux actually read, so a short output can be told apart from
        // a short input in the report.
        consumed: { video: tracks.video.consumed, audio: tracks.audio.consumed },
      }, [bytes.buffer]);
    } catch (error) {
      stopHeartbeat();
      const surrendered = surrenderChunks();
      self.postMessage({
        t: 'error',
        message: String(error?.message || error),
        video: surrendered.video,
        audio: surrendered.audio,
      });
    }
  })();
}

// Everything this worker holds, handed back so the document can fall back to
// the buffered path (mediabunny over a plain buffer, then ffmpeg).
//
// Copied, not transferred: mediabunny's sliding cache references these very
// buffers, and a conversion that is still unwinding would find them detached
// under it. One extra copy on a path that has already failed is the cheap side
// of that trade.
function surrenderChunks() {
  const take = (track) => {
    const copies = track.chunks.map((chunk) => chunk.slice().buffer);
    track.chunks = [];
    return copies;
  };
  return { video: take(tracks.video), audio: take(tracks.audio) };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || typeof message.t !== 'string') return;

  if (message.t === 'chunk') {
    const track = tracks[message.track];
    if (track) pushChunk(track, new Uint8Array(message.bytes));
    return;
  }
  if (message.t === 'complete') {
    const track = tracks[message.track];
    if (!track) return;
    // The document says how many bytes it sent. Anything less arrived here
    // means chunks were lost on the way, and finishing the mux on a truncated
    // input would produce a short file that still passes the duration check —
    // measured once as 14 MB of output from 62 MB of tracks.
    const expected = Math.max(0, Number(message.sent) || 0);
    if (expected && track.received !== expected) {
      const short = `дорожка ${message.track} пришла не полностью:`
        + ` ${track.received} из ${expected} байт`;
      failTrack(track, new Error(short));
      const surrendered = surrenderChunks();
      self.postMessage({
        t: 'error',
        message: short,
        video: surrendered.video,
        audio: surrendered.audio,
      });
      return;
    }
    closeTrack(track);
    return;
  }
  if (message.t === 'cancel') {
    const cancelled = new Error(message.reason || 'сборка отменена');
    failTrack(tracks.video, cancelled);
    failTrack(tracks.audio, cancelled);
    return;
  }
  if (message.t !== 'start') return;

  tracks.video.announced = Math.max(0, Number(message.videoSize) || 0);
  tracks.audio.announced = Math.max(0, Number(message.audioSize) || 0);
  openTrack(tracks.video);
  openTrack(tracks.audio);
  try {
    mediabunny = await import('./vendor/mediabunny/mediabunny.min.mjs');
  } catch (error) {
    // Nothing has been transferred here yet, so the document still owns every
    // byte and can simply carry on without a worker.
    self.postMessage({ t: 'unavailable', message: String(error?.message || error) });
    return;
  }
  self.postMessage({ t: 'ready' });
  maybeStartMux();
};
