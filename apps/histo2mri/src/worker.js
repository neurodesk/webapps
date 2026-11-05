// One registration run: every section registered to its plane with Greedy's single-threaded
// WebAssembly (the bytes test/ runs in Node), then the output files. The page starts one worker
// per run and terminates it to cancel.
//   in:  { volume, sections: [{ name, image }], plane: { axis, index, step, tilt }, options, version, axisName }
//   out: { type: 'progress', message, value } | { type: 'section', index, name, files, report }
//        | { type: 'done', files } | { type: 'error', message }
//   files: [{ kind, name, bytes }] (gzip-compressed NIfTI, matrix text or JSON)
import init, * as api from '@neurodesk/greedy/wasm-single';
import { gzip, registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from '@neurodesk/greedy';
import { registerSection } from './core/register.js';
import { planeSform, registrationImages, registrationReport, sectionsInVolume, warpedSection, worldTransforms } from './core/outputs.js';
import { rgbaNifti } from './core/nifti.js';
import { outputNames } from './config.js';

const greedy = {
  rigid: async (args) => registerRigidGreedy({ api, ...args }),
  affine: async (args) => registerAffineGreedy({ api, ...args }),
  svf: async (args) => registerSvfGreedy({ api, ...args }),
};

const text = (value) => new TextEncoder().encode(value);

self.onmessage = async ({ data: { volume, sections, plane, options, version, axisName } }) => {
  try {
    await init();
    const registered = [];
    for (const [n, { name, image }] of sections.entries()) {
      const share = 0.9 / sections.length;
      const progress = (message, value) => self.postMessage({ type: 'progress', message: sections.length > 1 ? `Section ${n + 1} of ${sections.length}: ${message}` : message, value: n * share + value * share });
      const result = await registerSection({
        volume,
        section: image,
        plane: { axis: plane.axis, index: plane.index + n * plane.step, tilt: plane.tilt },
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
      const files = [
        { kind: 'warped', name: names.warped, bytes: await gzip(rgbaNifti(warped.rgba, [warped.nu, warped.nv, 1], planeSform(result.plane, warped.spacing))) },
        { kind: 'plane', name: names.plane, bytes: await gzip(images.plane) },
        { kind: 'section', name: names.section, bytes: await gzip(images.section) },
        { kind: 'affine', name: names.affine, bytes: text(transforms.matrix) },
        ...(result.warp ? [{ kind: 'warp', name: names.warp, bytes: await gzip(transforms.warp) }] : []),
        { kind: 'report', name: names.report, bytes: text(`${JSON.stringify(report, null, 2)}\n`) },
      ];
      self.postMessage({ type: 'section', index: n, name, files, report }, files.map((file) => file.bytes.buffer));
      registered.push({ result, warped });
    }
    self.postMessage({ type: 'progress', message: 'Placing the sections in the MRI grid', value: 0.95 });
    const { bytes, written } = sectionsInVolume(volume, registered);
    self.postMessage({ type: 'done', written, files: [{ kind: 'volume', name: 'sections_in_mri.nii.gz', bytes: await gzip(bytes) }] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
