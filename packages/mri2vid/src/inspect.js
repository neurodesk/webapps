// Reads the videos the web app and the command line write: container facts (codec, size,
// frame count and timestamps) for WebM and MP4, and decoded frames for VP9 with libvpx.
// WebM is demuxed by libav.js; MP4 by the small sample-table reader below, because the
// libav.js build the command line ships has no MP4 demuxer.
import { libav } from './libav.js';

const MP4_CODECS = { avc1: 'h264', vp09: 'vp9', av01: 'av1' };

const isWebm = (bytes) => bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

async function demuxWebm(bytes) {
  const av = await libav();
  const name = `input-${Math.random().toString(36).slice(2)}.webm`;
  await av.writeFile(name, bytes);
  try {
    const [context, streams] = await av.ff_init_demuxer_file(name);
    const stream = streams.find((s) => s.codec_type === av.AVMEDIA_TYPE_VIDEO);
    if (!stream) throw new Error('The WebM file has no video track');
    const parameters = await av.ff_copyout_codecpar(stream.codecpar);
    const packet = await av.av_packet_alloc();
    const [, packets] = await av.ff_read_frame_multi(context, packet);
    await av.av_packet_free_js(packet);
    await av.avformat_close_input_js(context);
    const samples = (packets[stream.index] ?? []).map((p) => ({
      data: p.data,
      key: Boolean(p.flags & av.AV_PKT_FLAG_KEY),
      timestampUs: Math.round((p.pts * stream.time_base_num * 1e6) / stream.time_base_den),
    }));
    const descriptor = await av.avcodec_descriptor_get(parameters.codec_id);
    return {
      container: 'webm',
      codec: descriptor ? await av.AVCodecDescriptor_name(descriptor) : `codec ${parameters.codec_id}`,
      width: parameters.width,
      height: parameters.height,
      samples,
    };
  } finally {
    await av.unlink(name);
  }
}

function boxes(view, start, end) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at + 4, 4));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (view, box, type) => boxes(view, box.start, box.end).find((b) => b.type === type);

function path(view, box, ...types) {
  let found = box;
  for (const type of types) {
    found = found && child(view, found, type);
  }
  if (!found) throw new Error(`MP4 has no ${types.join('/')} box`);
  return found;
}

function demuxMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = { start: 0, end: bytes.byteLength };
  const moov = path(view, top, 'moov');
  const trak = boxes(view, moov.start, moov.end).filter((b) => b.type === 'trak').find((t) => {
    const hdlr = path(view, t, 'mdia', 'hdlr');
    return String.fromCharCode(...bytes.subarray(hdlr.start + 8, hdlr.start + 12)) === 'vide';
  });
  if (!trak) throw new Error('The MP4 file has no video track');
  const mdhd = path(view, trak, 'mdia', 'mdhd');
  const timescale = view.getUint8(mdhd.start) === 1 ? view.getUint32(mdhd.start + 20) : view.getUint32(mdhd.start + 12);
  const stbl = path(view, trak, 'mdia', 'minf', 'stbl');
  const stsd = path(view, stbl, 'stsd');
  const entry = boxes(view, stsd.start + 8, stsd.end)[0];
  const fourcc = entry.type;
  const width = view.getUint16(entry.start + 24);
  const height = view.getUint16(entry.start + 26);

  const stts = path(view, stbl, 'stts');
  const durations = [];
  for (let i = 0, n = view.getUint32(stts.start + 4); i < n; i++) {
    const count = view.getUint32(stts.start + 8 + i * 8);
    const delta = view.getUint32(stts.start + 12 + i * 8);
    for (let k = 0; k < count; k++) durations.push(delta);
  }
  const stsz = path(view, stbl, 'stsz');
  const fixedSize = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixedSize || view.getUint32(stsz.start + 12 + i * 4));
  const stco = child(view, stbl, 'stco') ?? child(view, stbl, 'co64');
  const wide = stco.type === 'co64';
  const chunkOffsets = Array.from({ length: view.getUint32(stco.start + 4) }, (_, i) => (
    wide ? Number(view.getBigUint64(stco.start + 8 + i * 8)) : view.getUint32(stco.start + 8 + i * 4)
  ));
  const stsc = path(view, stbl, 'stsc');
  const runs = Array.from({ length: view.getUint32(stsc.start + 4) }, (_, i) => ({
    firstChunk: view.getUint32(stsc.start + 8 + i * 12),
    perChunk: view.getUint32(stsc.start + 12 + i * 12),
  }));
  const stss = child(view, stbl, 'stss');
  const keys = stss
    ? new Set(Array.from({ length: view.getUint32(stss.start + 4) }, (_, i) => view.getUint32(stss.start + 8 + i * 4) - 1))
    : null;

  const samples = [];
  let time = 0;
  for (let chunk = 0; chunk < chunkOffsets.length; chunk++) {
    const run = runs.findLast((r) => r.firstChunk <= chunk + 1);
    let offset = chunkOffsets[chunk];
    for (let k = 0; k < run.perChunk && samples.length < count; k++) {
      const index = samples.length;
      samples.push({
        data: bytes.subarray(offset, offset + sizes[index]),
        key: keys ? keys.has(index) : true,
        timestampUs: Math.round((time * 1e6) / timescale),
      });
      offset += sizes[index];
      time += durations[index];
    }
  }
  const avc = fourcc === 'avc1' ? child(view, { start: entry.start + 78, end: entry.end }, 'avcC') : null;
  return {
    container: 'mp4', codec: MP4_CODECS[fourcc] ?? fourcc, width, height, samples,
    description: avc ? bytes.subarray(avc.start, avc.end) : undefined,
    durationUs: Math.round((time * 1e6) / timescale),
  };
}

export const demuxVideo = (bytes) => (isWebm(bytes) ? demuxWebm(bytes) : demuxMp4(bytes));

/** Container facts: codec, coded size, frame count, key frames and presentation timestamps. */
export async function inspectVideo(input) {
  const bytes = new Uint8Array(input);
  const video = await demuxVideo(bytes);
  return {
    container: video.container,
    codec: video.codec,
    width: video.width,
    height: video.height,
    frames: video.samples.length,
    keyFrames: video.samples.flatMap((s, i) => (s.key ? [i] : [])),
    timestampsUs: video.samples.map((s) => s.timestampUs),
  };
}

/** Decodes a VP9 video into its I420 frames: { width, height, y, u, v } per frame. */
export async function decodeVideo(input) {
  const bytes = new Uint8Array(input);
  const video = await demuxVideo(bytes);
  if (video.codec !== 'vp9') throw new Error(`Only VP9 is decoded here, not ${video.codec}`);
  const av = await libav();
  const [, context, packet, frame] = await av.ff_init_decoder('libvpx-vp9');
  try {
    const packets = video.samples.map((s, i) => ({ data: s.data, pts: i, flags: s.key ? av.AV_PKT_FLAG_KEY : 0 }));
    const frames = await av.ff_decode_multi(context, packet, frame, packets, true);
    return frames.map((f) => {
      const [y, u, v] = f.layout;
      const plane = ({ offset, stride }, w, h) => {
        const out = new Uint8Array(w * h);
        for (let row = 0; row < h; row++) out.set(f.data.subarray(offset + row * stride, offset + row * stride + w), row * w);
        return out;
      };
      const cw = (f.width + 1) >> 1;
      const ch = (f.height + 1) >> 1;
      return { width: f.width, height: f.height, y: plane(y, f.width, f.height), u: plane(u, cw, ch), v: plane(v, cw, ch) };
    });
  } finally {
    await av.ff_free_decoder(context, packet, frame);
  }
}
