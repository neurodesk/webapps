// Shared SynthSeg pipeline. Spatial processing and postprocessing come from the CLI's Rust
// compiled to wasm (./wasm.js); the runtime only supplies model bytes and an inference session.
// Order mirrors exes/synthseg/src/main.rs.
const CITATION = 'Billot et al. (2023) SynthSeg: Segmentation of brain MRI scans of any contrast and resolution without retraining. Med Image Anal. PMID: 36857946';
const VERSION = '0.3.20260920';

export async function runSynthseg({ buffer, options = {}, loadModel, createSession, wasm,
  onProgress = () => {}, runtime = {} }) {
  const settings = { fast: false, ct: false, ...options };
  const started = performance.now(), timings = {};
  let previous = started, session, seg;
  const mark = (name) => { const now = performance.now(); timings[name] = (now - previous) / 1000; previous = now; };
  const infer = async (input, flipped) => {
    const dims = [1, 1, ...seg.padded];
    const outputs = await session.run({ input: { type: 'float32', dims, getData: async () => input } });
    const output = outputs.output;
    if (output.dims.join() !== [1, 33, ...seg.padded].join()) throw new Error('Model output shape does not match the SynthSeg contract.');
    seg.posteriors(await output.getData(), { flipped });
    output.dispose?.();
  };
  try {
    onProgress(0.01, 'Reading NIfTI and resampling to 1 mm…');
    seg = new wasm.Segmenter(new Uint8Array(buffer), settings);
    mark('preprocess');
    onProgress(0.12, `Prepared ${seg.padded.join(' × ')} voxels`);
    const model = await loadModel();
    mark('model');
    onProgress(0.26, 'Initializing inference…');
    session = await createSession(model.bytes, seg.padded);
    mark('initialize');
    onProgress(0.32, 'Segmenting… this can take several minutes');
    await infer(seg.input(), false);
    if (!settings.fast) {
      onProgress(0.6, 'Segmenting flipped image…');
      await infer(seg.flippedInput(), true);
    }
    mark('inference');
    await session.release(); session = null;
    mark('release');
    onProgress(0.92, 'Postprocessing and saving labels…');
    const { buffer: labels, geometry } = seg.labels(settings);
    mark('postprocess');
    const provenance = {
      package: '@neurodesk/synthseg', version: VERSION, model: 'synthseg_2.0', modelSha256: model.hash,
      citation: CITATION, ...runtime, ...settings, flip: !settings.fast, ...geometry,
      seconds: (performance.now() - started) / 1000, timings,
    };
    return { buffer: labels.buffer, provenance };
  } finally {
    await session?.release();
    seg?.free();
  }
}
