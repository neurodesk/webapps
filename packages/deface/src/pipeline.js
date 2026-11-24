// The Deface pipeline without a viewer. The web app and the deface command line inject their own
// niimath and MindGrab runtimes and run the same argv, so both write the same files.
//
// niimath: `run(args, { inputs, output })` runs one niimath argv over named files and resolves to
// the named output. mindgrab: `{ version, segment }` with @brainchop/core's `segment`.

/** The web app's methods (apps/deface/automation.json), in its menu order. */
export const METHODS = Object.freeze({
  allineate: { engine: 'allineate', robustfov: false, hellinger: false },
  allineate_robustfov: { engine: 'allineate', robustfov: true, hellinger: false },
  allineate_hel: { engine: 'allineate', robustfov: false, hellinger: true },
  allineate_hel_robustfov: { engine: 'allineate', robustfov: true, hellinger: true },
  mindgrab: { engine: 'mindgrab', robustfov: false, borderMm: 0 },
  mindgrab_robust: { engine: 'mindgrab', robustfov: true, borderMm: 0 },
  mindgrab8: { engine: 'mindgrab', robustfov: false, borderMm: 8 },
  mindgrab_robust8: { engine: 'mindgrab', robustfov: true, borderMm: 8 },
});

export const DEFAULT_METHOD = 'allineate';

export const OUTPUT_NAMES = Object.freeze({ image: 'defaced.nii', mask: 'brain-mask.nii' });

// The MNI template and face mask that -deface registers to the subject (model.manifest.json).
export const TEMPLATE_NAMES = Object.freeze({ template: 'avg152T1.nii.gz', mask: 'avg152T1mask.nii.gz' });

export function resolveMethod(name = DEFAULT_METHOD) {
  if (!Object.hasOwn(METHODS, name)) {
    const names = Object.keys(METHODS);
    throw new Error(`Method must be ${names.slice(0, -1).join(', ')} or ${names.at(-1)}, not "${name}".`);
  }
  return METHODS[name];
}

const isGzip = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

// niimath picks gzip from the name, so the staged name follows the bytes, not the user's file name.
const inputName = (bytes) => (isGzip(bytes) ? 'input.nii.gz' : 'input.nii');

// Every niimath call writes uncompressed NIfTI in the input's datatype.
const command = (input, operations, output) => [input, '-gz', '0', ...operations, output, '-odt', 'input'];

/**
 * Deface one NIfTI image (gzipped or not) with a method from METHODS.
 * `templates` holds the bytes of TEMPLATE_NAMES, needed by the allineate methods.
 * Returns the defaced image, the brain mask for the MindGrab methods, and provenance.
 *
 * @param {object} options
 * @param {Uint8Array} options.input
 * @param {string} [options.method]
 * @param {{ template: Uint8Array, mask: Uint8Array }} [options.templates]
 * @param {{ run(args: string[], files: { inputs: Record<string, Uint8Array>, output: string }): Promise<Uint8Array> }} options.niimath
 * @param {{ version: string, segment(input: Uint8Array, options: object): Promise<{ mask?: ArrayBuffer, backend: string, elapsedMs: number }> }} [options.mindgrab]
 * @param {object} [options.mindgrabOptions]
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<{ image: { name: string, bytes: Uint8Array }, mask?: { name: string, bytes: Uint8Array }, provenance: object }>}
 */
export async function deface({ input, method: methodName = DEFAULT_METHOD, templates, niimath, mindgrab, mindgrabOptions = {}, onProgress = () => {} }) {
  const method = resolveMethod(methodName);
  const source = { name: inputName(input), bytes: input };
  const niimathRun = async (name, operations, inputs) => ({
    name,
    bytes: await niimath.run(command(inputs[0].name, operations, name), {
      inputs: Object.fromEntries(inputs.map((file) => [file.name, file.bytes])),
      output: name,
    }),
  });

  if (method.engine === 'allineate') {
    if (!templates?.template || !templates?.mask) throw new Error('The allineate methods need the MNI template and face mask.');
    onProgress(`Defacing with allineate (${method.hellinger ? 'Hellinger' : 'fast'}${method.robustfov ? ', robustfov' : ''})…`);
    // Registers the MNI template to the subject and zeroes the voxels under its face mask.
    // -cost hel selects the exhaustive Hellinger engine; without -cost niimath uses its fast engine.
    const operations = [
      ...(method.robustfov ? ['-robustfov'] : []),
      '-deface', TEMPLATE_NAMES.template, TEMPLATE_NAMES.mask,
      ...(method.hellinger ? ['-cost', 'hel'] : []),
    ];
    const image = await niimathRun(OUTPUT_NAMES.image, operations, [
      source,
      { name: TEMPLATE_NAMES.template, bytes: templates.template },
      { name: TEMPLATE_NAMES.mask, bytes: templates.mask },
    ]);
    return { image, provenance: { method: methodName, engine: 'niimath -deface', operations } };
  }

  // robustfov crops the neck first, and the whole pipeline then runs on that crop.
  const native = method.robustfov ? await niimathRun('robustfov.nii', ['-robustfov'], [source]) : source;
  onProgress('Extracting the brain with MindGrab…');
  const result = await mindgrab.segment(native.bytes, { ...mindgrabOptions, model: 'mindgrab', mask: true, gzipOutput: false });
  if (!result.mask) throw new Error('MindGrab did not return a brain mask.');
  let mask = { name: 'mindgrab-mask.nii', bytes: new Uint8Array(result.mask) };
  if (method.borderMm > 0) {
    // Keep a shell of tissue around the brain: binarize, dilate borderMm mm, erode 0 mm.
    mask = await niimathRun(OUTPUT_NAMES.mask, ['-close', '1', String(method.borderMm), '0'], [mask]);
  }
  mask = { name: OUTPUT_NAMES.mask, bytes: mask.bytes };
  onProgress('Removing everything outside the brain…');
  const image = await niimathRun(OUTPUT_NAMES.image, ['-mul', mask.name], [native, mask]);
  return {
    image,
    mask,
    provenance: {
      method: methodName,
      engine: 'MindGrab and niimath',
      robustfov: method.robustfov,
      borderMm: method.borderMm,
      mindgrab: { version: mindgrab.version, model: 'mindgrab', backend: result.backend, elapsedMs: result.elapsedMs },
    },
  };
}
