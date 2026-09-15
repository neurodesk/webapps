import { segment } from '@brainchop/mindgrab';
import mindgrabPackage from '@brainchop/mindgrab/package.json' with { type: 'json' };
import { readVolume, writeVolume } from '@neurodesk/synthsr';

const asBuffer = bytes => bytes instanceof ArrayBuffer
  ? bytes
  : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function runMindgrab({ volume, assetPath, backend = 'auto', segmenter = segment, onProgress = () => {}, onLog = () => {} }) {
  onProgress(0, 'Extracting brain with MindGrab…');
  const result = await segmenter(writeVolume(volume, 'MindGrab input'), {
    model: 'mindgrab',
    mask: true,
    gzipOutput: false,
    backend,
    worker: false,
    assetPath,
    onLog,
  });
  if (!result.mask) throw new Error('MindGrab did not return a brain mask.');
  const brain = readVolume(asBuffer(result.image));
  const decodedMask = readVolume(asBuffer(result.mask));
  const mask = { ...decodedMask, data: Uint8Array.from(decodedMask.data, value => value ? 1 : 0) };
  onProgress(1, 'Brain extraction complete');
  return {
    brain,
    mask,
    provenance: {
      method: 'MindGrab',
      package: '@brainchop/mindgrab',
      version: mindgrabPackage.version,
      model: 'mindgrab',
      backend: result.backend,
      elapsedMs: result.elapsedMs,
      ranInWorker: result.ranInWorker,
    },
  };
}
