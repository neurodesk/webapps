// Video encoder. Preferred path is WebCodecs VideoEncoder into a vendored,
// dependency-free MP4 or WebM muxer. When WebCodecs is unavailable the code
// falls back to MediaRecorder capturing a canvas stream to WebM (real time,
// slower, last resort). No CDN and no external requests are involved.

import * as Mp4Muxer from './vendor/mp4-muxer.js';
import * as WebmMuxer from './vendor/webm-muxer.js';
import { drawFrame, drawAnnotation, sliceLabel } from './annotate.js';

// Candidate codecs per container. First supported wins.
const MP4_CODECS = [
  { webcodecs: 'avc1.4d0028', muxer: 'avc', name: 'H.264' },
  { webcodecs: 'avc1.42001f', muxer: 'avc', name: 'H.264 (baseline)' },
  { webcodecs: 'vp09.00.10.08', muxer: 'vp9', name: 'VP9' },
  { webcodecs: 'av01.0.04M.08', muxer: 'av1', name: 'AV1' },
];
const WEBM_CODECS = [
  { webcodecs: 'vp09.00.10.08', muxer: 'V_VP9', name: 'VP9' },
  { webcodecs: 'vp8', muxer: 'V_VP8', name: 'VP8' },
];

export function hasWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export function hasMediaRecorder() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function evenDim(n) {
  // Most codecs require even width/height.
  return n % 2 === 0 ? n : n + 1;
}

// Yield a real macrotask (not a microtask) so a queued Stop click can run and the
// browser can repaint the progress bar between frames.
const yieldToEventLoop = () => new Promise((r) => setTimeout(r));

async function pickCodec(list, width, height, fps) {
  if (!hasWebCodecs() || typeof VideoEncoder.isConfigSupported !== 'function') return null;
  for (const c of list) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.webcodecs, width, height, framerate: fps,
      });
      if (support && support.supported) return c;
    } catch (_) { /* try next */ }
  }
  return null;
}

// Report which options are usable in this browser.
export async function probeEncoders(width = 256, height = 256, fps = 20) {
  const w = evenDim(width), h = evenDim(height);
  const out = { mp4: null, webm: null, mediaRecorder: false };
  if (hasWebCodecs()) {
    const mp4 = await pickCodec(MP4_CODECS, w, h, fps);
    if (mp4) out.mp4 = mp4.name;
    const webm = await pickCodec(WEBM_CODECS, w, h, fps);
    if (webm) out.webm = webm.name;
  }
  if (hasMediaRecorder()) out.mediaRecorder = true;
  return out;
}

function bitrateFor(width, height, fps) {
  const bpp = 0.12;
  const b = Math.round(width * height * fps * bpp);
  return Math.max(1_000_000, Math.min(b, 24_000_000));
}

// frameProvider(i) returns { frame, fW, fH, channels, sliceIndex } for i in [0, nFrames).
// Returns { blob, mime, ext, codecName, container }.
export async function encodeVideo({
  nFrames,
  fps,
  container, // 'mp4' | 'webm'
  frameProvider,
  annotate = false,
  total = nFrames,
  onProgress = () => {},
  shouldStop = () => false,
}) {
  if (nFrames < 1) throw new Error('Nothing to encode: no frames selected');
  const first = frameProvider(0);
  const width = evenDim(first.fW);
  const height = evenDim(first.fH);

  if (hasWebCodecs()) {
    const list = container === 'mp4' ? MP4_CODECS : WEBM_CODECS;
    const codec = await pickCodec(list, width, height, fps);
    if (codec) {
      return await encodeWebCodecs({
        nFrames, fps, width, height, container, codec, frameProvider,
        annotate, total, onProgress, shouldStop,
      });
    }
    // If MP4 was requested but no MP4 codec is available, try WebM via WebCodecs.
    if (container === 'mp4') {
      const webm = await pickCodec(WEBM_CODECS, width, height, fps);
      if (webm) {
        return await encodeWebCodecs({
          nFrames, fps, width, height, container: 'webm', codec: webm, frameProvider,
          annotate, total, onProgress, shouldStop,
        });
      }
    }
  }

  if (hasMediaRecorder()) {
    return await encodeMediaRecorder({
      nFrames, fps, width, height, frameProvider, annotate, total, onProgress, shouldStop,
    });
  }

  throw new Error('This browser cannot encode video (no WebCodecs and no MediaRecorder). Try a recent Chrome, Edge, Safari, or Firefox.');
}

async function encodeWebCodecs({
  nFrames, fps, width, height, container, codec, frameProvider, annotate, total, onProgress, shouldStop,
}) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  let muxer;
  if (container === 'mp4') {
    muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: codec.muxer, width, height },
      fastStart: 'in-memory',
    });
  } else {
    muxer = new WebmMuxer.Muxer({
      target: new WebmMuxer.ArrayBufferTarget(),
      video: { codec: codec.muxer, width, height, frameRate: fps },
    });
  }

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure({
    codec: codec.webcodecs,
    width,
    height,
    bitrate: bitrateFor(width, height, fps),
    framerate: fps,
  });

  const frameDurUs = Math.round(1_000_000 / fps);
  const gop = Math.max(1, Math.round(fps)); // keyframe about once per second
  let stopped = false;

  for (let i = 0; i < nFrames; i++) {
    if (encoderError) break;
    if (shouldStop()) { stopped = true; break; }
    const { frame, fW, fH, channels, sliceIndex } = frameProvider(i);
    ctx.clearRect(0, 0, width, height);
    drawFrame(ctx, frame, fW, fH, channels);
    if (annotate) drawAnnotation(ctx, sliceLabel(sliceIndex, total), fH);

    const vf = new VideoFrame(canvas, {
      timestamp: i * frameDurUs,
      duration: frameDurUs,
    });
    encoder.encode(vf, { keyFrame: i % gop === 0 });
    vf.close();

    onProgress((i + 1) / nFrames);
    if (i % 4 === 0) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
    // Bound memory on large volumes: let the encoder drain if its queue backs up.
    while (encoder.encodeQueueSize > 30 && !shouldStop()) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw new Error(`Encoder error: ${encoderError.message || encoderError}`);
  if (stopped) { const e = new Error('stopped'); e.stopped = true; throw e; }

  muxer.finalize();
  const buffer = muxer.target.buffer;
  onProgress(1);
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  return {
    blob: new Blob([buffer], { type: mime }),
    mime,
    ext: container,
    codecName: codec.name,
    container,
  };
}

async function encodeMediaRecorder({
  nFrames, fps, width, height, frameProvider, annotate, total, onProgress, shouldStop,
}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve) => { rec.onstop = () => resolve(); });
  rec.start();

  const frameMs = 1000 / fps;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let stopped = false;
  for (let i = 0; i < nFrames; i++) {
    if (shouldStop()) { stopped = true; break; }
    const { frame, fW, fH, channels, sliceIndex } = frameProvider(i);
    ctx.clearRect(0, 0, width, height);
    drawFrame(ctx, frame, fW, fH, channels);
    if (annotate) drawAnnotation(ctx, sliceLabel(sliceIndex, total), fH);
    if (typeof track.requestFrame === 'function') track.requestFrame();
    onProgress((i + 1) / nFrames);
    // eslint-disable-next-line no-await-in-loop
    await sleep(frameMs);
  }

  rec.stop();
  await done;
  if (stopped) { const e = new Error('stopped'); e.stopped = true; throw e; }
  onProgress(1);
  return {
    blob: new Blob(chunks, { type: 'video/webm' }),
    mime: 'video/webm',
    ext: 'webm',
    codecName: 'MediaRecorder WebM',
    container: 'webm',
  };
}
