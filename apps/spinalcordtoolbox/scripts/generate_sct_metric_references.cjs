#!/usr/bin/env node
'use strict';

/*
 * Regenerates the SCT reference tables in test/fixtures/sct-metrics by running
 * the real `sct_process_segmentation` and `sct_analyze_lesion` from the pinned
 * SCT container on the fixture masks. `scripts/test_sct_metrics_parity.cjs`
 * compares the browser modules with these files number by number.
 *
 *   node scripts/generate_sct_metric_references.cjs
 *
 * Needs Docker. On arm64 the amd64 image runs emulated; the whole run takes a
 * few minutes. Disc labels for the per-level cases come from
 * `sct_label_vertebrae` in the same container: any single-voxel disc file
 * exercises `-discfile`, and this one needs no extra model download.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureFixtureFiles } = require('./huggingface-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/sct-metrics');
const cases = require(path.join(FIXTURE_DIR, 'cases.json'));
const PYTHON = '/opt/spinalcordtoolbox-7.3.3/python/envs/venv_sct/bin/python';

const HELPERS = `
import json
import sys

import numpy as np
import pandas as pd
from spinalcordtoolbox.image import Image


def discs(src, dst):
    """Disc labels as RPI voxel coordinates."""
    im = Image(src).change_orientation('RPI')
    points = [
        {'x': int(x), 'y': int(y), 'z': int(z), 'value': int(round(float(im.data[x, y, z])))}
        for x, y, z in np.argwhere(im.data)
    ]
    json.dump({'orientation': 'RPI', 'points': sorted(points, key=lambda p: p['value'])}, open(dst, 'w'), indent=1)


def multi(lesion_src, cord_src, dst_nii, dst_json):
    """The fake lesion plus three synthetic ones, in stored voxel order.

    B sits on the lateral edge of the cord and sticks out of it (restriction
    to the cord, parasagittal bridge fallback). C and D touch only by a
    corner, so 18-connectivity keeps them apart where 26 would merge them.
    """
    lesion = Image(lesion_src)
    cord = Image(cord_src).data > 0
    data = (lesion.data > 0).astype(np.uint8)
    # Stored orientation is AIL: axis 0 = AP, axis 1 = SI, axis 2 = RL.
    for j in range(58, 64):
        ks = np.unique(np.where(cord[:, j, :])[1])
        edge = ks[-2:]
        for k in edge:
            data[:, j, k] |= cord[:, j, k].astype(np.uint8)
        outside = int(ks[-1]) + 1
        if outside < data.shape[2]:
            rows = np.where(cord[:, j, ks[-1]])[0]
            data[rows, j, outside] = 1
    placed = False
    for j in range(80, 90):
        for i, k in np.argwhere(cord[:, j, :]):
            if cord[i + 1, j + 1, k + 1] and not data[max(i - 2, 0):i + 4, j - 2:j + 4, max(k - 2, 0):k + 4].any():
                data[i, j, k] = 1
                data[i + 1, j + 1, k + 1] = 1
                placed = True
                break
        if placed:
            break
    assert placed
    lesion.data = data
    lesion.save(dst_nii)
    flat = np.flatnonzero(data.ravel(order='F'))
    json.dump({'dims': list(data.shape), 'order': 'x + y * nx + z * nx * ny (stored axes)', 'indices': flat.tolist()},
              open(dst_json, 'w'))


def measures(pkl, dst):
    pd.read_pickle(pkl)['measures'].to_csv(dst, index=False)


def splines(dst):
    """SciPy splrep/splev on a fixed vector: pins the FITPACK port offline."""
    import math
    from scipy import interpolate
    out = {}
    x = np.arange(20, dtype=float)
    y = np.array([math.sin(i / 3) + 0.1 * ((i * 7) % 5) for i in range(20)])
    for name, s, k in [('smooth', 0.5, 3), ('interpolate', 0.0, 3), ('tight', 0.05, 3), ('linear', 0.2, 1)]:
        tck, fp, ier, _ = interpolate.splrep(x, y, s=s, k=k, full_output=1)
        xr = np.arange(-2, 23, dtype=float)
        out[name] = {
            's': s, 'k': k, 't': tck[0].tolist(), 'c': tck[1][:len(tck[0])].tolist(), 'fp': float(fp), 'ier': int(ier),
            'fit': interpolate.splev(xr, tck, der=0).tolist(), 'deriv': interpolate.splev(xr, tck, der=1).tolist(),
        }
    json.dump(out, open(dst, 'w'))


if __name__ == '__main__':
    globals()[sys.argv[1]](*sys.argv[2:])
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function buildScript() {
  const lines = ['set -euo pipefail', 'cd /work', 'sct_version'];
  lines.push(`${PYTHON} helpers.py splines out/scipy_splrep.json`);
  lines.push('sct_label_vertebrae -i t2.nii.gz -s t2_seg.nii.gz -c t2 -v 0');
  lines.push(`${PYTHON} helpers.py discs t2_seg_labeled_discs.nii.gz out/t2_discs.json`);
  const oriented = new Set();
  for (const item of cases.morphometry) {
    let mask = `${item.mask}.nii.gz`;
    let discs = 't2_seg_labeled_discs.nii.gz';
    if (item.orient) {
      const suffix = `_${item.orient}`;
      if (!oriented.has(item.mask + suffix)) {
        lines.push(`sct_image -i ${mask} -setorient ${item.orient} -o ${item.mask}${suffix}.nii.gz -v 0`);
        lines.push(`sct_image -i ${discs} -setorient ${item.orient} -o discs${suffix}.nii.gz -v 0`);
        oriented.add(item.mask + suffix);
      }
      mask = `${item.mask}${suffix}.nii.gz`;
      discs = `discs${suffix}.nii.gz`;
    }
    const discArgs = item.discs ? `-discfile ${discs} ` : '';
    lines.push(`sct_process_segmentation -i ${mask} ${discArgs}${item.sct} -o out/${item.id}.csv -v 0`);
  }
  lines.push(`${PYTHON} helpers.py multi les_lesion.nii.gz les_sc.nii.gz les_multi.nii.gz out/les_multi.json`);
  for (const item of cases.lesion) {
    const image = item.image ? `-i ${item.image}.nii.gz ` : '';
    const cord = item.cord ? `-s ${item.cord}.nii.gz ` : '';
    lines.push(`sct_analyze_lesion -m ${item.lesion}.nii.gz ${cord}${image}-ofolder lesion_${item.id} -v 0`);
    lines.push(`${PYTHON} helpers.py measures lesion_${item.id}/${item.lesion}_analysis.pkl out/${item.id}.csv`);
  }
  return `${lines.join('\n')}\n`;
}

// `--only id[,id]` regenerates just those cases (and leaves the other tables untouched).
const only = (() => {
  const index = process.argv.indexOf('--only');
  return index < 0 ? null : new Set(process.argv[index + 1].split(','));
})();
if (only) {
  cases.morphometry = cases.morphometry.filter(item => only.has(item.id));
  cases.lesion = cases.lesion.filter(item => only.has(item.id));
}

async function main() {
  await ensureFixtureFiles(ROOT, Object.values(cases.inputs));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-metric-references-'));
  fs.mkdirSync(path.join(work, 'out'));
  for (const [name, relativePath] of Object.entries(cases.inputs)) {
    fs.copyFileSync(path.join(ROOT, relativePath), path.join(work, `${name}.nii.gz`));
  }
  fs.writeFileSync(path.join(work, 'helpers.py'), HELPERS);
  fs.writeFileSync(path.join(work, 'run.sh'), buildScript());

  const docker = process.env.DOCKER || 'docker';
  const image = process.env.SCT_DOCKER_IMAGE || cases.image;
  run(docker, ['run', '--rm', '--platform', 'linux/amd64', '-v', `${work}:/work`, image, 'bash', '-l', '/work/run.sh']);

  for (const name of fs.readdirSync(path.join(work, 'out'))) {
    fs.copyFileSync(path.join(work, 'out', name), path.join(FIXTURE_DIR, name));
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`SCT references written to ${path.relative(ROOT, FIXTURE_DIR)} from ${image}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
