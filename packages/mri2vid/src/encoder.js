// VP9 encoding for the command line: libvpx (libav.js, WebAssembly) in place of the
// browser's WebCodecs VideoEncoder, with the browser's bitrate, key frame interval,
// timestamps and colour metadata, into the same muxers.

import { libav } from './libav.js';
import {
  VP9_DECODER_CONFIG, bitrateFor, createMuxer, frameDurationUs, keyFrameInterval,
} from './video.js';

// AV_PICTURE_TYPE_I: asks libvpx for a key frame.
const KEY_PICTURE = 1;

// The muxers' codec names for VP9.
const VP9_MUXER_CODEC = { mp4: 'vp9', webm: 'V_VP9' };

// frameAt(i) resolves to frame i as full-range BT.709 I420 (raster.js rgbToI420), width x height.
// Returns the finished file's bytes.
export async function encodeVp9({
  nFrames,
  fps,
  width,
  height,
  container,
  frameAt,
  onProgress = () => {},
}) {
  const av = await libav();
  const frameDurUs = frameDurationUs(fps);
  const gop = keyFrameInterval(fps);
  const [, context, frame, packet] = await av.ff_init_encoder('libvpx-vp9', {
    ctx: {
      width,
      height,
      pix_fmt: av.AV_PIX_FMT_YUV420P,
      bit_rate: bitrateFor(width, height, fps),
      framerate_num: Math.round(fps * 1000),
      framerate_den: 1000,
      gop_size: gop,
      keyint_min: gop,
    },
    time_base: [1, 1_000_000],
    // Real-time mode without look-ahead, as Chromium runs libvpx: one packet per frame,
    // at the browser's quality (measured in validation/cli-check.mjs) and speed.
    options: {
      'lag-in-frames': '0',
      deadline: 'realtime',
      'cpu-used': '6',
      color_range: 'pc',
      colorspace: 'bt709',
      color_primaries: 'bt709',
      color_trc: 'iec61966-2-1',
    },
  });
  const muxer = createMuxer({ container, codec: VP9_MUXER_CODEC[container], width, height, fps });
  let first = true;
  const mux = (packets) => {
    for (const p of packets) {
      const type = p.flags & av.AV_PKT_FLAG_KEY ? 'key' : 'delta';
      const meta = first ? { decoderConfig: { ...VP9_DECODER_CONFIG, codedWidth: width, codedHeight: height } } : undefined;
      first = false;
      if (container === 'mp4') muxer.addVideoChunkRaw(p.data, type, p.pts, frameDurUs, meta);
      else muxer.addVideoChunkRaw(p.data, type, p.pts, meta);
    }
  };
  const layout = [
    { offset: 0, stride: width },
    { offset: width * height, stride: width >> 1 },
    { offset: width * height + (width >> 1) * (height >> 1), stride: width >> 1 },
  ];
  try {
    for (let i = 0; i < nFrames; i++) {
      const data = await frameAt(i);
      mux(await av.ff_encode_multi(context, frame, packet, [{
        data,
        layout,
        format: av.AV_PIX_FMT_YUV420P,
        width,
        height,
        pts: i * frameDurUs,
        pict_type: i % gop === 0 ? KEY_PICTURE : 0,
      }]));
      onProgress((i + 1) / nFrames);
    }
    mux(await av.ff_encode_multi(context, frame, packet, [], true));
  } finally {
    await av.ff_free_encoder(context, frame, packet);
  }
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
