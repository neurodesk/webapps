// Video settings and containers shared by the web app's WebCodecs encoder and the command
// line's libvpx encoder, so both write the same frame size, timing, key frames, bitrate
// and container metadata.

import * as Mp4Muxer from './vendor/mp4-muxer.js';
import * as WebmMuxer from './vendor/webm-muxer.js';

export const CONTAINERS = ['webm', 'mp4'];

export const MIME_TYPES = { mp4: 'video/mp4', webm: 'video/webm' };

// What Chromium's WebCodecs VP9 encoder reports for a frame drawn from a canvas: RGB is
// converted to full-range BT.709 YUV. The command line converts the same way.
export const VP9_DECODER_CONFIG = {
  codec: 'vp09.00.10.08',
  colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true },
};

// Most codecs require even width and height.
export function evenDim(n) {
  return n % 2 === 0 ? n : n + 1;
}

export function bitrateFor(width, height, fps) {
  const bpp = 0.12;
  const b = Math.round(width * height * fps * bpp);
  return Math.max(1_000_000, Math.min(b, 24_000_000));
}

export function frameDurationUs(fps) {
  return Math.round(1_000_000 / fps);
}

// A key frame about once per second.
export function keyFrameInterval(fps) {
  return Math.max(1, Math.round(fps));
}

// `codec` is the muxer's codec name: 'avc', 'vp9' or 'av1' for MP4; 'V_VP9' or 'V_VP8' for WebM.
export function createMuxer({ container, codec, width, height, fps }) {
  if (container === 'mp4') {
    return new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec, width, height },
      fastStart: 'in-memory',
    });
  }
  return new WebmMuxer.Muxer({
    target: new WebmMuxer.ArrayBufferTarget(),
    video: { codec, width, height, frameRate: fps },
  });
}
