// Tool drivers: each accepts exactly the command line a Rust pipeline core emits (as in its work/commands.sh) and
// runs it on the matching browser runtime over in-memory files. Unknown options fail rather than being ignored.
// Paths may be absolute (fastprep: /work/...) or relative (SYNcro: work/..., outputs at the root).

import { encodeFor, gunzip, parent } from './files.js';

const text = (s) => new TextEncoder().encode(s);

/**
 * Split argv into options (with their declared arity) and positionals; reject anything undeclared. An arity of
 * Infinity takes every remaining argument (Greedy's `-r` chain).
 */
export function parse(argv, arity) {
  const opts = new Map();
  const pos = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a in arity) {
      const n = arity[a] === Infinity ? argv.length - i - 1 : arity[a];
      const vals = argv.slice(i + 1, i + 1 + n);
      if (vals.length < n) throw new Error(`${argv[0]}: ${a} needs ${n} value(s)`);
      opts.set(a, [...(opts.get(a) ?? []), vals]);
      i += n;
    } else if (a.startsWith('-')) {
      throw new Error(`${argv[0]}: option ${a} is not supported in the browser`);
    } else pos.push(a);
  }
  const one = (k) => opts.get(k)?.at(-1);
  return { opts, pos, one, has: (k) => opts.has(k) };
}

/**
 * niimath through its Emscripten module, one fresh module per command (no state leaks; an abort cannot poison the
 * next). Its output format follows the step's FSLOUTPUTTYPE (default NIFTI_GZ), as native niimath's does. The WASM
 * build has no zstd, so `.nii.zst` intermediates are kept raw: the name keeps `.zst` (the core's paths stay native)
 * while the module sees `.nii`.
 */
export function niimathDriver(createModule) {
  return async (argv, { files, fslOut }) => {
    const zst = fslOut === 'NIFTI_ZST';
    const real = (p) => (p.endsWith('.nii.zst') ? p.slice(0, -4) : p);
    const log = [];
    const mod = await createModule({
      noInitialRun: true,
      print: (l) => log.push(l),
      printErr: (l) => log.push(l),
      // libc copies ENV in its startup constructors, so it is set here, not before callMain
      preRun: [(m) => Object.assign(m.ENV, { FSLOUTPUTTYPE: zst ? 'NIFTI' : (fslOut ?? 'NIFTI_GZ'), NIIMATH_GZ_LEVEL: '1' })],
    });
    // A relative path lives below the module's working directory, /.
    const dirOf = (p) => (p.includes('/') ? parent(p) : '.');
    const dirs = new Set();
    const staged = new Set();
    for (const a of argv.slice(1)) {
      const p = a.startsWith('@') ? a.slice(1) : a;
      if (!p.startsWith('/') && !files.has(p) && !/\.nii(\.gz|\.zst)?$/.test(p)) continue;
      const dir = dirOf(real(p));
      dirs.add(dir);
      if (dir !== '.') mod.FS.mkdirTree(dir);
      if (files.has(p)) {
        mod.FS.writeFile(real(p), await files.bytes(p));
        staged.add(real(p));
      }
    }
    const args = argv.slice(1).map((a) => (a.startsWith('@') ? `@${real(a.slice(1))}` : real(a)));
    let code;
    const hostExitCode = globalThis.process?.exitCode; // Emscripten's Node glue records exit() there
    try {
      code = mod.callMain(args);
    } catch (e) {
      if (typeof e?.status !== 'number') throw e;
      code = e.status;
    } finally {
      if (globalThis.process) globalThis.process.exitCode = hostExitCode;
    }
    if (code === 0) {
      for (const dir of dirs) {
        for (const f of mod.FS.readdir(dir)) {
          const p = dir === '.' ? f : `${dir}/${f}`;
          if (f === '.' || f === '..' || staged.has(p) || !mod.FS.isFile(mod.FS.stat(p).mode)) continue;
          files.put(zst && p.endsWith('.nii') ? `${p}.zst` : p, mod.FS.readFile(p));
        }
      }
    }
    return { code, stdout: log.join('\n'), stderr: '' };
  };
}

/**
 * brainchop-mindgrab / brainchop-mindmap through @brainchop/core's segment() and segmentTissues(). The native
 * backend and thread options name hardware the browser chooses itself, so they are accepted and ignored.
 */
export function mindgrabDriver({ segment, segmentTissues }, options = {}) {
  const arity = { '-backend': 1, '-cpu': 1, '-o': 1, '--mask': 1, '--pve': 0 };
  return async (argv, { files }) => {
    const a = parse(argv, arity);
    const [input] = a.pos;
    const out = a.one('-o')?.[0];
    if (!input || !out || a.pos.length !== 1) throw new Error(`${argv[0]}: expected -o OUT and one input`);
    const bytes = await files.bytes(input);
    const gzipOutput = out.endsWith('.gz');
    if (argv[0] === 'brainchop-mindmap') {
      if (!a.has('--pve')) throw new Error('brainchop-mindmap: only --pve is supported in the browser');
      const { tissues } = await segmentTissues(bytes, { ...options, model: 'mindmap', gzipOutput });
      const stem = out.replace(/\.nii(\.gz)?$/, '');
      for (const t of ['gm', 'wm', 'csf']) files.put(`${stem}_${t}${out.slice(stem.length)}`, new Uint8Array(tissues[t]));
    } else {
      const mask = a.one('--mask')?.[0];
      const r = await segment(bytes, { ...options, model: 'mindgrab', mask: Boolean(mask), gzipOutput });
      files.put(out, new Uint8Array(r.image));
      if (mask) files.put(mask, await encodeFor(mask, new Uint8Array(r.mask)));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * greedy-rs registration and reslicing through the WASM exports (@neurodesk/greedy), the same functions the
 * native command runs: `-a` (affine), `-sv` (stationary velocity, after `-it`) and `-rf ... -r CHAIN` with a
 * chain of an affine, a warp and an affine, or a warp and two affines (the last acting first), `-ri NN` and
 * `-rb FILL`. `-threads` is the native thread pool; the browser's was sized when Greedy loaded.
 */
export function greedyDriver(api) {
  const arity = {
    '-d': 1, '-threads': 1, '-V': 1, '-m': 1, '-n': 1, '-i': 2, '-a': 0, '-ia-image-centers': 0, '-o': 1,
    '-gm': 1, '-it': 1, '-sv': 0, '-rf': 1, '-ri': 1, '-rb': 1, '-rm': 2, '-r': Infinity,
  };
  return async (argv, { files }) => {
    const a = parse(argv, arity);
    const raw = async (p) => gunzip(await files.bytes(p));
    const iters = a.one('-n')?.[0] ?? '100x50x10';
    const mask = a.has('-gm') ? await raw(a.one('-gm')[0]) : undefined;
    const out = a.one('-o')?.[0];
    if (a.has('-a')) {
      const [fixed, moving] = a.one('-i');
      const matrix = await api.register_affine_masked_wasm(await raw(fixed), await raw(moving), mask, a.one('-m')?.[0] ?? 'NMI', iters, a.has('-ia-image-centers'));
      files.put(out, text(matrix));
    } else if (a.has('-sv')) {
      const [fixed, moving] = a.one('-i');
      const it = a.has('-it') ? await files.text(a.one('-it')[0]) : undefined;
      const warp = await api.register_nmi_svf_masked_wasm(await raw(fixed), await raw(moving), mask, it, iters);
      files.put(out, await encodeFor(out, new Uint8Array(warp)));
    } else if (a.has('-rf')) {
      const chain = a.one('-r') ?? [];
      const fixed = await raw(a.one('-rf')[0]);
      const nearest = (a.one('-ri')?.[0] ?? 'LINEAR').toUpperCase() === 'NN';
      const fill = Number(a.one('-rb')?.[0] ?? 0);
      if (!Number.isFinite(fill)) throw new Error('greedy-rs: -rb must be a finite number in the browser');
      const isWarp = (p) => /\.nii(\.gz)?$/.test(p);
      let reslice;
      if (chain.length === 1 && !isWarp(chain[0])) {
        const matrix = await files.text(chain[0]);
        reslice = (moving) => api.reslice_affine_options(fixed, moving, matrix, nearest, fill);
      } else if ((chain.length === 2 || chain.length === 3) && isWarp(chain[0]) && !chain.slice(1).some(isWarp)) {
        const [w, m] = [await raw(chain[0]), await files.text(chain[1])];
        const preceding = chain[2] ? await files.text(chain[2]) : undefined;
        reslice = (moving) => api.reslice_warp_affine_options(fixed, moving, w, m, preceding, nearest, fill);
      } else {
        throw new Error('greedy-rs: browser reslicing needs -r AFFINE, -r WARP AFFINE or -r WARP AFFINE AFFINE');
      }
      for (const [src, dst] of a.opts.get('-rm')) {
        const img = await reslice(await raw(src));
        files.put(dst, await encodeFor(dst, new Uint8Array(img)));
      }
    } else throw new Error('greedy-rs: expected -a, -sv or -rf');
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * synthsr IN OUT [--ct] through a runtime function `(bytes, {ct}) -> synthetic T1w NIfTI bytes`
 * (@neurodesk/synthsr). `--threads` and `--device` name native resources; the runtime picks the browser's.
 */
export function synthsrDriver(synthesize) {
  const arity = { '--force': 0, '--quiet': 0, '--threads': 1, '--device': 1, '--ct': 0 };
  return async (argv, { files }) => {
    const { pos, has } = parse(argv, arity);
    if (pos.length !== 2) throw new Error('synthsr: expected IN OUT');
    files.put(pos[1], await encodeFor(pos[1], new Uint8Array(await synthesize(await files.bytes(pos[0]), { ct: has('--ct') }))));
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * antsRegistration and antsApplyTransforms through the SYNcro registration kernel (@neurodesk/registration), whose
 * own argv is antsRegistration's and whose `--apply` mode is antsApplyTransforms' float resample. `kernel()`
 * resolves to `{call(args), FS}` for one Emscripten instance, whose working directory is `/`: every file the argv
 * names is written there under the same path (a `.nii` name inflated, as ANTs picks its reader by file name), so
 * the argv runs unchanged, and the declared outputs are read back.
 */
export function antsDrivers(kernel) {
  const at = (path) => (path.startsWith('/') ? path : `/${path}`);
  const stage = async (k, files, argv) => {
    for (const path of new Set(argv.slice(1).flatMap((x) => x.replace(/^\w*\[|\]$/g, '').split(',')))) {
      if (!files.has(path)) continue;
      k.FS.mkdirTree(parent(at(path)));
      const bytes = await files.bytes(path);
      k.FS.writeFile(at(path), /\.nii$/.test(path) ? await gunzip(bytes) : bytes);
    }
  };
  const run = async (k, files, args, outputs) => {
    for (const o of outputs) k.FS.mkdirTree(parent(at(o)));
    k.call(args);
    for (const o of outputs) files.put(o, k.FS.readFile(at(o)));
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    async antsRegistration(argv, { files }) {
      const args = argv.slice(1);
      const output = args[args.indexOf('--output') + 1]?.replace(/^\[|\]$/g, '').split(',');
      if (!output || output.length !== 2) throw new Error('antsRegistration: expected --output [PREFIX,WARPED]');
      const k = await kernel();
      await stage(k, files, argv);
      const transforms = ['0GenericAffine.mat', '1Warp.nii.gz', '1InverseWarp.nii.gz'].map((name) => `${output[0]}${name}`);
      return run(k, files, args, [...transforms, output[1]]);
    },
    async antsApplyTransforms(argv, { files }) {
      const a = parse(argv, { '-d': 1, '--float': 1, '-i': 1, '-r': 1, '-o': 1, '-n': 1, '-f': 1, '-t': 1 });
      const interpolation = { Linear: 'linear', NearestNeighbor: 'nearest' }[a.one('-n')?.[0] ?? 'Linear'];
      if (!interpolation) throw new Error('antsApplyTransforms: -n must be Linear or NearestNeighbor in the browser');
      const k = await kernel();
      await stage(k, files, argv);
      const out = a.one('-o')[0];
      const transforms = a.opts.get('-t').map(([t]) => t);
      return run(k, files, ['--apply', a.one('-r')[0], a.one('-i')[0], out, interpolation, a.one('-f')?.[0] ?? '0', ...transforms], [out]);
    },
  };
}
