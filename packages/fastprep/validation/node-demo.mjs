// Runs the browser host end to end under Node: the WASM core, niimath WASM, glm WASM, meica WASM and MindGrab's CPU modules
// (via @neurodesk/node-drivers). Greedy's threaded WASM and SynthSR's ONNX session need a browser, so here they are
// native binaries behind the same API the drivers call; the drivers' argv mapping is still exercised.
//
//   node validation/node-demo.mjs BIDS_DIR TEMPLATES_DIR OUT_DIR TOOL_BIN_DIR [OMP]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import createNiimath from '@niivue/niimath/niimath.js';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { loadMeica } from '@niivue/meica';
import { runFastprep } from '../src/index.js';

const [bids, tplDir, outDir, bin, omp = String(cpus().length)] = process.argv.slice(2);
if (!bin) throw new Error('usage: node-demo.mjs BIDS_DIR TEMPLATES_DIR OUT_DIR TOOL_BIN_DIR [OMP]');

function tree(root) {
  const out = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : out.push(join(d, f))));
  walk(root);
  return out.map((p) => [relative(root, p), new Blob([readFileSync(p)])]);
}

/** A native tool as an in-memory call: inputs written to a scratch dir, outputs read back. */
function native(tool, inputs, argv, outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'fastprep-node-'));
  try {
    for (const [name, bytes] of Object.entries(inputs)) writeFileSync(join(dir, name), bytes);
    execFileSync(join(bin, tool), argv.map((a) => (a in inputs || outputs.includes(a) ? join(dir, a) : a)), { stdio: 'pipe' });
    return outputs.map((o) => new Uint8Array(readFileSync(join(dir, o))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const greedy = {
  register_affine_masked_wasm(fixed, moving, mask, metric, iters) {
    const ins = { 'f.nii': fixed, 'm.nii': moving, ...(mask && { 'g.nii': mask }) };
    const [m] = native('greedy-rs', ins, ['-d', '3', '-V', '0', '-m', metric, '-n', iters, '-i', 'f.nii', 'm.nii', ...(mask ? ['-gm', 'g.nii'] : []), '-a', '-o', 'a.mat'], ['a.mat']);
    return new TextDecoder().decode(m);
  },
  register_nmi_svf_masked_wasm(fixed, moving, mask, init, iters) {
    const ins = { 'f.nii': fixed, 'm.nii': moving, ...(mask && { 'g.nii': mask }), ...(init && { 'i.mat': new TextEncoder().encode(init) }) };
    const args = ['-d', '3', '-V', '0', '-m', 'NMI', '-n', iters, '-i', 'f.nii', 'm.nii', ...(mask ? ['-gm', 'g.nii'] : []), ...(init ? ['-it', 'i.mat'] : []), '-sv', '-o', 'w.nii'];
    return native('greedy-rs', ins, args, ['w.nii'])[0];
  },
  reslice_warp_affine_options(fixed, moving, warp, matrix, _pre, nearest) {
    const ins = { 'f.nii': fixed, 'm.nii': moving, 'w.nii': warp, 'a.mat': new TextEncoder().encode(matrix) };
    return native('greedy-rs', ins, ['-d', '3', '-rf', 'f.nii', ...(nearest ? ['-ri', 'NN'] : []), '-rm', 'm.nii', 'o.nii', '-r', 'w.nii', 'a.mat'], ['o.nii'])[0];
  },
};
const synthsr = (bytes) => native('synthsr', { 'in.nii.gz': bytes }, ['in.nii.gz', 'out.nii', '--force', '--quiet'], ['out.nii'])[0];

const wasm = (name) => ({ module_or_path: readFileSync(new URL(`../wasm/${name}/${name}_wasm_bg.wasm`, import.meta.url)) });
const t0 = Date.now();
const files = await runFastprep({
  dataset: tree(bids),
  templates: tree(tplDir),
  runtimes: {
    niimath: createNiimath,
    mindgrab: await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json')),
    mindgrabOptions: { backend: 'cpu' },
    greedy,
    synthsr,
    meica: await loadMeica({ threads: 1 }),
    wasm: { core: wasm('fastprep'), glm: wasm('glm') },
  },
  options: { omp: Number(omp), nprocs: Number(omp) },
  onLog: (l) => console.log(l),
});
for (const root of ['/out', '/work']) {
  for (const rel of files.list(root)) {
    const p = join(outDir, root.slice(1), rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, await files.bytes(`${root}/${rel}`));
  }
}
console.log(`browser host finished in ${((Date.now() - t0) / 1000).toFixed(1)} s; files in ${outDir}`);
