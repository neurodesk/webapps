// One registration run: every section registered to its plane with Greedy's single-threaded
// WebAssembly (the bytes test/ runs in Node), then the output files. The page starts one worker
// per run and terminates it to cancel.
//   in:  { volume, sections: [{ name, image }], plane: { axis, index, step, tilt }, options, version, axisName, volumeOutput }
//   out: { type: 'progress', message, value } | { type: 'section', index, name, files, report }
//        | { type: 'done', written, files } | { type: 'error', message }
//   done's files are empty when volumeOutput is false (the MRI grid is too large to copy).
//   files: [{ kind, name, bytes }] (gzip-compressed NIfTI, matrix text or JSON)
import init, * as api from '@neurodesk/greedy/wasm-single';
import { gzip, registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from '@neurodesk/greedy';
import { preflightSection, registerSection } from './core/register.js';
import { planeSform, registrationImages, registrationReport, sectionsInVolume, warpedSection, worldTransforms } from './core/outputs.js';
import { rgbaNifti } from './core/nifti.js';
import { outputNames, SECTION_OUTPUT_KINDS } from './config.js';

const greedy = {
  rigid: async (args) => registerRigidGreedy({ api, ...args }),
  affine: async (args) => registerAffineGreedy({ api, ...args }),
  svf: async (args) => registerSvfGreedy({ api, ...args }),
};

const text = (value) => new TextEncoder().encode(value);

self.onmessage = async ({ data: { volume, sections, plane, options, version, axisName, volumeOutput } }) => {
  try {
    // Every section's memory is checked before the first registration, so a section over the
    // limit does not discard the sections registered before it.
    const planeOf = (n) => ({ axis: plane.axis, index: plane.index + n * plane.step, tilt: plane.tilt });
    for (const [n, { name, image }] of sections.entries()) {
      self.postMessage({ type: 'progress', message: `Checking ${name}`, value: 0 });
      try {
        preflightSection({ volume, section: image, plane: planeOf(n), options });
      } catch (error) {
        throw new Error(sections.length > 1 ? `${name}: ${error.message}` : error.message);
      }
    }
    await init();
    const registered = [];
    for (const [n, { name, image }] of sections.entries()) {
      const share = 0.9 / sections.length;
      const progress = (message, value) => self.postMessage({ type: 'progress', message: sections.length > 1 ? `Section ${n + 1} of ${sections.length}: ${message}` : message, value: n * share + value * share });
      const result = await registerSection({
        volume,
        section: image,
        plane: planeOf(n),
        options,
        greedy,
        onProgress: progress,
      });
      progress('Writing the outputs', 0.95);
      const warped = warpedSection(result, image);
      const transforms = worldTransforms(result);
      const images = registrationImages(result);
      const report = registrationReport(result, { name, version, settings: { plane, options }, axisName });
      const names = outputNames(name);
      const bytes = {
        warped: await gzip(rgbaNifti(warped.rgba, [warped.nu, warped.nv, 1], planeSform(result.plane, warped.spacing))),
        plane: await gzip(images.plane),
        section: await gzip(images.section),
        affine: text(transforms.matrix),
        warp: result.warp ? await gzip(transforms.warp) : null,
        registration: text(`${JSON.stringify(report, null, 2)}\n`),
      };
      const files = SECTION_OUTPUT_KINDS.filter((kind) => bytes[kind]).map((kind) => ({ kind, name: names[kind], bytes: bytes[kind] }));
      self.postMessage({ type: 'section', index: n, name, files, report }, files.map((file) => file.bytes.buffer));
      if (volumeOutput) registered.push({ result: { plane: result.plane }, warped });
    }
    if (!volumeOutput) {
      self.postMessage({ type: 'done', written: 0, files: [] });
      return;
    }
    self.postMessage({ type: 'progress', message: 'Placing the sections in the MRI grid', value: 0.95 });
    const { bytes, written } = sectionsInVolume(volume, registered);
    self.postMessage({ type: 'done', written, files: [{ kind: 'volume', name: 'sections_in_mri.nii.gz', bytes: await gzip(bytes) }] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
