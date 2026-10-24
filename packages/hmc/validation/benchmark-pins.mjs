import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** Input pins shared by the trial runner and matrix receipt validation. */
export async function benchmarkPins(data) {
  if (data === 'full') {
    const manifest = JSON.parse(await readFile(new URL('../../../exes/dwi/hmc/validation/reference.manifest.json', import.meta.url), 'utf8'));
    return Object.entries({ image: 'input/sub-107_dir-AP_dwi.nii.gz', bval: 'input/sub-107_dir-AP_dwi.bval', bvec: 'input/sub-107_dir-AP_dwi.bvec', mask: 'mask/sub-107_dir-AP_desc-mindgrab_mask.nii.gz' }).map(([role, path]) => ({
      ...manifest.files.find(entry => entry.path === path), role, url: manifest.base + path, name: `${data}-${role}${extname(path)}`,
    }));
  }
  if (data !== 'slab') throw new Error('Benchmark data is full or slab.');
  const [example] = JSON.parse(await readFile(new URL('../../../apps/noddi/examples.json', import.meta.url), 'utf8'));
  const pins = ['image', 'bval', 'bvec'].map(role => ({ ...example.files.find(file => file.role === role), name: `${data}-${role}` }));
  const manifest = JSON.parse(await readFile(new URL('../../n4/validation/reference.json', import.meta.url), 'utf8'));
  const mask = manifest.files.find(file => file.name === 'mindgrab_mask.nii.gz');
  return [...pins, { ...mask, role: 'mask', url: manifest.base + mask.name, name: `${data}-mask` }];
}
