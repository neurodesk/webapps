import { expect, test } from '@playwright/test';

const routes = [
  ['T1', 'structural'], ['b0 as anatomy', 'structural-b0'],
  ['DWI + ADC', 'dwi', 'adc'], ['DWI + b0', 'dwi', 'b0'],
  ['DWI + ADC + b0', 'dwi', 'adc', 'b0'],
  ['T1 + DWI + ADC', 'structural', 'dwi', 'adc'],
  ['T1 + DWI + b0', 'structural', 'dwi', 'b0'],
  ['uploaded mask', 'structural', 'uploaded'], ['manual drawing', 'structural', 'manual'],
  ['qform b0', 'structural-b0', 'qform'], ['compressed T1', 'structural', 'gzip'],
  ['oblique T1', 'structural', 'oblique'],
];
const permutations = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]];
const orientations = permutations.flatMap(axes => Array.from({ length: 8 }, (_, bits) => axes.map((axis, i) => axis * (bits & (1 << i) ? -1 : 1))));

for (const [name, ...inputs] of routes) {
  test(`confirmed mask retains world side: ${name}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.maskDrawingController);
    // All signed storage permutations on the anatomical path, with flipped and
    // permuted cases repeated through each diffusion input combination.
    const cases = inputs.includes('qform') ? [[1, 2, 3], [-1, 2, 3]] : inputs[0] === 'structural' && inputs.length === 1 ? orientations : [[-1, 2, 3], [2, -3, -1]];
    for (const axes of cases) {
      const result = await page.evaluate(async ({ inputs, axes }) => {
        const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
        const { decodeNiftiBuffer } = await import('/js/modules/atlas-loader.js');
        const dims = [12, 14, 16];
        const affine = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => i === 3 && j === 3 ? 1 : 0));
        axes.forEach((axis, world) => {
          const native = Math.abs(axis) - 1;
          affine[world][native] = Math.sign(axis);
          affine[world][3] = -Math.sign(axis) * (dims[native] - 1) / 2;
        });
        if (inputs.includes('oblique')) {
          const angle = Math.PI / 12;
          const [a, b] = affine.slice(0, 2).map(row => [...row]);
          affine[0] = a.map((value, i) => Math.cos(angle) * value - Math.sin(angle) * b[i]);
          affine[1] = a.map((value, i) => Math.sin(angle) * value + Math.cos(angle) * b[i]);
        }
        const mask = new Uint8Array(dims.reduce((a, b) => a * b));
        for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
          const world = affine.slice(0, 3).map(row => row[0] * x + row[1] * y + row[2] * z + row[3]);
          if (world[0] < -2 && world[0] > -5 && world[1] > 0 && world[1] < 3 && world[2] > 1 && world[2] < 4) mask[x + dims[0] * (y + dims[1] * z)] = 1;
        }
        const scan = Float32Array.from(mask, value => value ? 100 : 20);
        const bytes = writeNifti1(scan, { dims, affine: affine.flat() });
        if (inputs.includes('qform')) {
          const header = new DataView(bytes);
          header.setInt16(254, 0, true);
          header.setInt16(252, 1, true);
          header.setFloat32(76, axes[0] < 0 ? -1 : 1, true);
          header.setFloat32(260, axes[0] < 0 ? 1 : 0, true);
          for (let i = 0; i < 3; i++) header.setFloat32(268 + 4 * i, affine[i][3], true);
        }
        const mixed = inputs.includes('structural') && inputs.includes('dwi');
        const seedAffine = affine.map(row => [...row]);
        const seedMask = new Uint8Array(mask);
        if (mixed) {
          for (let i = 0; i < 3; i++) {
            seedAffine[i][3] += seedAffine[i][0] * (dims[0] - 1);
            seedAffine[i][0] *= -1;
          }
          for (let i = 0; i < mask.length; i++) seedMask[i] = mask[i - i % dims[0] + dims[0] - 1 - i % dims[0]];
        }
        const seed = new File([writeNifti1(seedMask, { dims, affine: seedAffine.flat() })], 'seed.nii');
        app.clearResults({ full: true });
        for (const input of inputs) {
          if (['manual', 'uploaded', 'qform', 'gzip', 'oblique'].includes(input)) continue;
          let content = bytes;
          if (mixed && !input.startsWith('structural')) content = writeNifti1(Float32Array.from(seedMask, value => value ? 100 : 20), { dims, affine: seedAffine.flat() });
          if (inputs.includes('gzip')) content = await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
          const file = new File([content], `${input}.nii${inputs.includes('gzip') ? '.gz' : ''}`);
          if (input.startsWith('structural')) await app.setStructural(file);
          else await app.setDeepIslesInput(input, file);
        }
        await app.ensureStructuralForDiffusion();
        if (inputs.includes('uploaded')) await app.startUploadedLesionMaskReview(seed);
        else await app.startLesionMaskReview({ seedFile: seed, blank: inputs.includes('manual') });
        if (inputs.includes('manual')) {
          const image = app.nv.volumes[0].img2RAS();
          app.nv.drawBitmap.set(Uint8Array.from(image, value => value === 100 ? 1 : 0));
          app.nv.refreshDrawing(true);
        }
        // Check actual NiiVue seed loading independently against the anatomical
        // landmark, before checking export. This also catches a load-time flip.
        const ras = app.nv.volumes[0].img2RAS();
        const reviewErrors = app.nv.drawBitmap.reduce((sum, value, i) => sum + Number(Boolean(value) !== (ras[i] === 100)), 0);
        const legacyErrors = app.nv.drawBitmap.reduce((sum, value, i) => sum + Number(value !== mask[i]), 0);
        const download = app.exportActiveNativeDrawingFile();
        const exported = await decodeNiftiBuffer(await download.arrayBuffer());
        const exportErrors = exported.data.reduce((sum, value, i) => sum + Number(value !== mask[i]), 0);
        // Identity world-space registration isolates review -> confirmation ->
        // reporting-grid transfer from neural registration accuracy.
        app.fixedMni160Info = { dims: [32, 32, 32], affine: [[1, 0, 0, -16], [0, 1, 0, -16], [0, 0, 1, -16], [0, 0, 0, 1]], spacing: [1, 1, 1] };
        app.prealignSamplingAffine = app.fixedMni160Info.affine;
        const confirmed = await app.confirmLesionDrawing();
        const fixed = await decodeNiftiBuffer(await confirmed.arrayBuffer());
        let left = 0;
        let right = 0;
        for (let i = 0; i < fixed.data.length; i++) if (fixed.data[i]) {
          if (i % 32 - 16 < 0) left++;
          else right++;
        }
        const native = await decodeNiftiBuffer(await app.confirmedNativeLesionFile.arrayBuffer());
        return { axes, reviewErrors, exportErrors, legacyErrors, confirmErrors: native.data.reduce((sum, value, i) => sum + Number(value !== mask[i]), 0), left, right };
      }, { inputs, axes });
      expect(result.reviewErrors, JSON.stringify(result)).toBe(0);
      expect(result.exportErrors, JSON.stringify(result)).toBe(0);
      expect(result.confirmErrors, JSON.stringify(result)).toBe(0);
      expect(result.left, JSON.stringify(result)).toBeGreaterThan(0);
      expect(result.right, JSON.stringify(result)).toBe(0);
      if (axes.join(',') === '-1,2,3') expect(result.legacyErrors).toBeGreaterThan(0);
    }
  });
}

for (const [input, property] of [
  ['structuralFileInput', 'nativeStructuralFile'],
  ['deepIslesDwiFileInput', 'deepIslesDwiFile'],
  ['deepIslesAdcFileInput', 'deepIslesAdcFile'],
  ['deepIslesB0FileInput', 'deepIslesB0File'],
]) {
  test(`DICOM orientation survives confirmation from ${input}`, async ({ page }) => {
    const { dicomSeries } = await import('../../../test-utils/dicom-fixture.mjs');
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.maskDrawingController);
    await page.locator(`#${input}`).setInputFiles(dicomSeries({ extension: '' }));
    await page.waitForFunction(property => !!app[property], property);
    const errors = await page.evaluate(async property => {
      const { decodeNiftiBuffer } = await import('/js/modules/atlas-loader.js');
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const file = app[property];
      // Each file picker uses real DICOM conversion; input-combination routing
      // is exercised separately above. Here isolate its output orientation.
      await app.setStructural(file);
      const geometry = await app.ensureNativeStructuralInfo();
      const expected = new Uint8Array(geometry.dims.reduce((a, b) => a * b));
      expected[geometry.dims[0] * geometry.dims[1] + 2 * geometry.dims[0] + 1] = 1;
      const seed = new File([writeNifti1(expected, { dims: geometry.dims, affine: geometry.affine.flat(), spacing: geometry.spacing })], 'seed.nii');
      await app.startLesionMaskReview({ seedFile: seed });
      app.fixedMni160Info = geometry;
      app.prealignSamplingAffine = geometry.affine;
      const fileOut = await app.confirmLesionDrawing();
      const actual = await decodeNiftiBuffer(await fileOut.arrayBuffer());
      return actual.data.reduce((sum, value, i) => sum + Number(value !== expected[i]), 0);
    }, property);
    expect(errors).toBe(0);
  });
}
