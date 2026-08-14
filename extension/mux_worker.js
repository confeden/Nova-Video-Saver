// Copy-remux on a worker thread.
//
// mediabunny used to run on the offscreen document's own main thread, and a
// 700 s video occupied it for more than a minute: the document stopped
// answering messages entirely — `nova-finalize` sat in its queue for 68 s while
// the assembly was already finished — and the browser felt frozen down to the
// extensions panel. The work is identical here, it simply no longer blocks the
// thread that has to keep talking to the rest of the extension.
//
// The bytes are transferred in, never copied, so this worker holds the only
// copy. If the mux fails they are transferred straight back, which is what lets
// the ffmpeg fallback in the document still run.

const streams = {
  video: createStream(),
  audio: createStream(),
};
let mediabunny;
let muxStarted = false;

function createStream() {
  return {
    chunks: [],
    starts: [],
    received: 0,
    expected: 0,
    complete: false,
    failure: null,
    waiters: [],
  };
}

function wake(stream) {
  if (!stream.waiters.length) return;
  const pending = stream.waiters;
  stream.waiters = [];
  for (const waiter of pending) {
    if (stream.failure) waiter.reject(stream.failure);
    else if (stream.complete || stream.received >= waiter.need) waiter.resolve();
    else stream.waiters.push(waiter);
  }
}

function pushChunk(stream, bytes) {
  stream.starts.push(stream.received);
  stream.chunks.push(bytes);
  stream.received += bytes.length;
  wake(stream);
}

function completeStream(stream) {
  stream.complete = true;
  wake(stream);
}

function failStream(stream, error) {
  stream.failure = error instanceof Error ? error : new Error(String(error));
  wake(stream);
}

function readRange(stream, start, end) {
  const from = Math.max(0, Math.min(start, stream.received));
  const to = Math.max(from, Math.min(end, stream.received));
  const result = new Uint8Array(to - from);
  if (!result.length) return result;
  // Binary search for the chunk holding `from`: a long video arrives in
  // hundreds of chunks and mediabunny reads tens of thousands of ranges.
  let low = 0;
  let high = stream.chunks.length - 1;
  let index = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const chunkStart = stream.starts[mid];
    const chunkEnd = chunkStart + stream.chunks[mid].length;
    if (from < chunkStart) high = mid - 1;
    else if (from >= chunkEnd) low = mid + 1;
    else { index = mid; break; }
  }
  let written = 0;
  for (let i = index; i < stream.chunks.length && written < result.length; i++) {
    const chunk = stream.chunks[i];
    const chunkStart = stream.starts[i];
    const sliceFrom = Math.max(0, from + written - chunkStart);
    const sliceTo = Math.min(chunk.length, to - chunkStart);
    if (sliceTo <= sliceFrom) continue;
    result.set(chunk.subarray(sliceFrom, sliceTo), written);
    written += sliceTo - sliceFrom;
  }
  return written === result.length ? result : result.subarray(0, written);
}

function streamSource(StreamSource, stream) {
  return new StreamSource({
    // The page knows each track's exact size before the transfer starts, so the
    // parser never has to guess where the file ends.
    getSize: () => stream.expected || stream.received,
    read: async (start, end) => {
      if (stream.failure) throw stream.failure;
      if (end > stream.received && !stream.complete) {
        await new Promise((resolve, reject) => {
          stream.waiters.push({ need: end, resolve, reject });
        });
      }
      if (stream.failure) throw stream.failure;
      return readRange(stream, start, end);
    },
  });
}

async function mux() {
  const {
    Input, Output, Conversion, ALL_FORMATS, StreamSource, BufferTarget, Mp4OutputFormat,
  } = mediabunny;
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoInput = new Input({
    formats: ALL_FORMATS, source: streamSource(StreamSource, streams.video),
  });
  const audioInput = new Input({
    formats: ALL_FORMATS, source: streamSource(StreamSource, streams.audio),
  });
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
  // The document watches these for its stall guard; without them a wedged
  // conversion would look identical to a slow one.
  videoConversion.onProgress = (value) => {
    self.postMessage({ t: 'progress', value: Math.max(0, Math.min(1, Number(value) || 0)) });
  };
  audioConversion.onProgress = () => { self.postMessage({ t: 'tick' }); };
  await output.start();
  await Promise.all([videoConversion.execute(), audioConversion.execute()]);
  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer?.byteLength) throw new Error('сборка вернула пустой файл');
  return new Uint8Array(buffer);
}

// Starts only once both tracks are here in full.
//
// Reading ahead of the transfer was tried and produced a **truncated file**:
// 62.8 MB of tracks came back as 14.4 MB whose header still claimed the full
// duration, so nothing downstream noticed. The overlap it bought was ~3 s,
// which is not worth a silently short video; the point of this worker is to
// keep the document responsive, and that is unaffected by waiting.
function maybeStartMux() {
  if (muxStarted || !mediabunny) return;
  if (!streams.video.complete || !streams.audio.complete) return;
  muxStarted = true;
  (async () => {
    try {
      const bytes = await mux();
      self.postMessage({
        t: 'done',
        bytes: bytes.buffer,
        // What the mux actually read, so a short output can be told apart from
        // a short input in the report.
        consumed: { video: streams.video.received, audio: streams.audio.received },
      }, [bytes.buffer]);
    } catch (error) {
      const surrendered = surrenderChunks();
      self.postMessage({
        t: 'error',
        message: String(error?.message || error),
        video: surrendered.video,
        audio: surrendered.audio,
      }, surrendered.transfer);
    }
  })();
}

// Everything this worker holds, handed back so the document can fall back to
// the buffered path (mediabunny over a plain buffer, then ffmpeg).
function surrenderChunks() {
  const video = streams.video.chunks.map((chunk) => chunk.buffer);
  const audio = streams.audio.chunks.map((chunk) => chunk.buffer);
  streams.video.chunks = [];
  streams.audio.chunks = [];
  return { video, audio, transfer: [...video, ...audio] };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || typeof message.t !== 'string') return;

  if (message.t === 'chunk') {
    const stream = streams[message.track];
    if (stream) pushChunk(stream, new Uint8Array(message.bytes));
    return;
  }
  if (message.t === 'complete') {
    const stream = streams[message.track];
    if (!stream) return;
    // The document says how many bytes it sent. Anything less arrived here
    // means chunks were lost on the way, and finishing the mux on a truncated
    // input would produce a short file that still passes the duration check —
    // measured once as 14 MB of output from 62 MB of tracks.
    const expected = Math.max(0, Number(message.sent) || 0);
    if (expected && stream.received !== expected) {
      const short = `дорожка ${message.track} пришла не полностью:`
        + ` ${stream.received} из ${expected} байт`;
      failStream(stream, new Error(short));
      const surrendered = surrenderChunks();
      self.postMessage({
        t: 'error',
        message: short,
        video: surrendered.video,
        audio: surrendered.audio,
      }, surrendered.transfer);
      return;
    }
    completeStream(stream);
    maybeStartMux();
    return;
  }
  if (message.t === 'cancel') {
    const cancelled = new Error(message.reason || 'сборка отменена');
    failStream(streams.video, cancelled);
    failStream(streams.audio, cancelled);
    return;
  }
  if (message.t !== 'start') return;

  streams.video.expected = Math.max(0, Number(message.videoSize) || 0);
  streams.audio.expected = Math.max(0, Number(message.audioSize) || 0);
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
