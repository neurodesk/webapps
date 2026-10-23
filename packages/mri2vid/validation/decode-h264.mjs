import { demuxVideo } from '../src/inspect.js';

/** Decode the browser's H.264 samples with its own WebCodecs decoder. */
export async function decodeH264(page, bytes) {
  const video = await demuxVideo(bytes);
  const codec = `avc1.${[...video.description.subarray(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  return page.evaluate(async ({ samples, description, codec, width, height }) => {
    const frames = [];
    const copies = [];
    let failure;
    const decoder = new VideoDecoder({
      output(frame) {
        try {
          if (!['I420', 'I420A', 'I422', 'I444', 'NV12'].includes(frame.format)) {
            throw new Error(`Unsupported H.264 frame format: ${frame.format}`);
          }
          const index = frames.length;
          frames.push(null);
          const buffer = new Uint8Array(frame.allocationSize());
          copies.push(frame.copyTo(buffer).then(([plane]) => {
            const y = [];
            for (let row = 0; row < height; row++) {
              y.push(...buffer.subarray(plane.offset + row * plane.stride, plane.offset + row * plane.stride + width));
            }
            frames[index] = { width, height, y };
          }).finally(() => frame.close()));
        } catch (error) {
          failure = error.message;
          frame.close();
        }
      },
      error(error) { failure = error.message; },
    });
    try {
      decoder.configure({ codec, codedWidth: width, codedHeight: height, description: new Uint8Array(description) });
      for (const sample of samples) {
        decoder.decode(new EncodedVideoChunk({
          type: sample.key ? 'key' : 'delta', timestamp: sample.timestampUs, data: new Uint8Array(sample.data),
        }));
      }
      await decoder.flush();
      await Promise.all(copies);
      if (failure) throw new Error(failure);
      if (frames.length !== samples.length) throw new Error(`Decoded ${frames.length} frames for ${samples.length} H.264 samples`);
      return frames;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
  }, {
    samples: video.samples.map(sample => ({ ...sample, data: [...sample.data] })),
    description: [...video.description], codec, width: video.width, height: video.height,
  });
}
