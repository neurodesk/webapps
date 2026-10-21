// Tool drivers: each accepts exactly the command line the fastprep core emits (as in work/commands.sh) and runs it
// on the matching browser runtime over in-memory files. Unknown options fail rather than being ignored.

import { denoiseMeica, runMeica } from '@niivue/meica';
import { encodeFor, gunzip, parent } from './files.js';

const text = (s) => new TextEncoder().encode(s);

/** Split argv into options (with their declared arity) and positionals; reject anything undeclared. */
function parse(argv, arity) {
  const opts = new Map();
  const pos = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a in arity) {
      const vals = argv.slice(i + 1, i + 1 + arity[a]);
      if (vals.length < arity[a]) throw new Error(`${argv[0]}: ${a} needs ${arity[a]} value(s)`);
      opts.set(a, [...(opts.get(a) ?? []), vals]);
      i += arity[a];
    } else if (a.startsWith('-')) {
      throw new Error(`${argv[0]}: option ${a} is not supported in the browser`);
    } else pos.push(a);
  }
  const one = (k) => opts.get(k)?.at(-1);
  return { opts, pos, one, has: (k) => opts.has(k) };
}

/**
 * niimath through its Emscripten module, one fresh module per command (no state leaks; an abort cannot poison the
 * next). The WASM build has no zstd, so `.nii.zst` intermediates are kept raw: the name keeps `.zst` (the core's
 * paths stay native) while the module sees `.nii`.
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
      preRun: [(m) => Object.assign(m.ENV, { FSLOUTPUTTYPE: zst ? 'NIFTI' : 'NIFTI_GZ', NIIMATH_GZ_LEVEL: '1' })],
    });
    const dirs = new Set();
    const staged = new Set();
    for (const a of argv.slice(1)) {
      const p = a.startsWith('@') ? a.slice(1) : a;
      if (!p.startsWith('/')) continue;
      const dir = parent(real(p));
      dirs.add(dir);
      mod.FS.mkdirTree(dir);
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
          const p = `${dir}/${f}`;
          if (f === '.' || f === '..' || staged.has(p) || !mod.FS.isFile(mod.FS.stat(p).mode)) continue;
          files.put(zst && p.endsWith('.nii') ? `${p}.zst` : p, mod.FS.readFile(p));
        }
      }
    }
    return { code, stdout: log.join('\n'), stderr: '' };
  };
}

/** brainchop-mindgrab / brainchop-mindmap through @brainchop/mindgrab's segment() and segmentTissues(). */
export function mindgrabDriver({ segment, segmentTissues }, options = {}) {
  const arity = { '-backend': 1, '-o': 1, '--mask': 1, '--pve': 0 };
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

/** greedy-rs registration and reslicing through the threaded WASM exports (@neurodesk/greedy). */
export function greedyDriver(api) {
  const arity = {
    '-d': 1, '-threads': 1, '-V': 1, '-m': 1, '-n': 1, '-i': 2, '-a': 0, '-ia-image-centers': 0, '-o': 1,
    '-gm': 1, '-it': 1, '-sv': 0, '-rf': 1, '-ri': 1, '-rm': 2, '-r': 2,
  };
  return async (argv, { files }) => {
    const a = parse(argv, arity);
    const raw = async (p) => gunzip(await files.bytes(p));
    const iters = a.one('-n')?.[0] ?? '100x50x10';
    const mask = a.has('-gm') ? await raw(a.one('-gm')[0]) : undefined;
    const out = a.one('-o')?.[0];
    if (a.has('-a')) {
      const [fixed, moving] = a.one('-i');
      const matrix = await api.register_affine_masked_wasm(await raw(fixed), await raw(moving), mask, a.one('-m')?.[0] ?? 'NMI', iters);
      files.put(out, text(matrix));
    } else if (a.has('-sv')) {
      const [fixed, moving] = a.one('-i');
      const it = a.has('-it') ? await files.text(a.one('-it')[0]) : undefined;
      const warp = await api.register_nmi_svf_masked_wasm(await raw(fixed), await raw(moving), mask, it, iters);
      files.put(out, await encodeFor(out, new Uint8Array(warp)));
    } else if (a.has('-rf')) {
      const [warp, matrix] = a.one('-r') ?? [];
      if (!warp) throw new Error('greedy-rs: browser reslicing needs -r WARP AFFINE');
      const fixed = await raw(a.one('-rf')[0]);
      const nearest = (a.one('-ri')?.[0] ?? 'LINEAR').toUpperCase() === 'NN';
      const [w, m] = [await raw(warp), await files.text(matrix)];
      for (const [src, dst] of a.opts.get('-rm')) {
        const img = await api.reslice_warp_affine_options(fixed, await raw(src), w, m, undefined, nearest, 0);
        files.put(dst, await encodeFor(dst, new Uint8Array(img)));
      }
    } else throw new Error('greedy-rs: expected -a, -sv or -rf');
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** synthsr IN OUT through a runtime function bytes -> synthetic T1w NIfTI bytes (@neurodesk/synthsr). */
export function synthsrDriver(synthesize) {
  const arity = { '--force': 0, '--quiet': 0, '--threads': 1, '--device': 1 };
  return async (argv, { files }) => {
    const { pos } = parse(argv, arity);
    if (pos.length !== 2) throw new Error('synthsr: expected IN OUT');
    files.put(pos[1], await encodeFor(pos[1], new Uint8Array(await synthesize(await files.bytes(pos[0])))));
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** glm --task-analysis and --meica-qc through the glm WASM module. */
export function glmDriver(glm) {
  const arity = { '--task-analysis': 0, '--summary': 1, '--fwhm': 1 };
  return async (argv, { files }) => {
    if (argv[1] === '--meica-qc') {
      if (argv.length !== 8) throw new Error('glm: --meica-qc expects MIXING METRICS CONFOUNDS EVENTS SIDECAR OUT');
      const [mixing, metrics, conf, events, side, out] = argv.slice(2);
      const read = (p) => files.text(p);
      files.put(out, text(glm.meica_qc(await read(mixing), await read(metrics), await read(conf), events ? await read(events) : '', await read(side))));
      return { code: 0, stdout: '', stderr: '' };
    }
    const a = parse(argv, arity);
    if (!a.has('--task-analysis') || a.pos.length !== 7) throw new Error('glm: only --task-analysis is supported in the browser');
    const [bold, conf, events, ...maps] = a.pos;
    const r = glm.task_analysis(
      await files.bytes(bold),
      await files.text(bold.replace(/\.nii(\.gz)?$/, '.json')),
      await files.text(conf),
      await files.text(events),
      Number(a.one('--fwhm')?.[0] ?? 5),
    );
    files.put(a.one('--summary')[0], text(r[0]));
    maps.forEach((m, k) => files.put(m, r[k + 1]));
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * meica (tedana's ME-ICA) through @niivue/meica's single-threaded WASM `api`: the classification call
 * (`-d ECHO... -e TE... --mask M --dummy-scans N --tree T [--external TSV] --n-threads K --quiet --out-dir D`, files
 * written under D with meica's names) and `--denoise BOLD --mixing TSV --metrics TSV --dummy-scans N -o OUT`.
 */
export function meicaDriver(api) {
  const known = ['-d', '-e', '--mask', '--dummy-scans', '--tree', '--external', '--n-threads', '--quiet', '--out-dir',
    '--denoise', '--mixing', '--metrics', '-o'];
  return async (argv, { files }) => {
    const opts = new Map(); // flag -> values up to the next flag (-d and -e take several)
    for (let i = 1; i < argv.length;) {
      if (!known.includes(argv[i])) throw new Error(`meica: ${argv[i]} is not supported in the browser`);
      let j = i + 1;
      while (j < argv.length && !known.includes(argv[j])) j++;
      opts.set(argv[i], argv.slice(i + 1, j));
      i = j;
    }
    const one = (k) => opts.get(k)?.[0];
    const dummyScans = Number(one('--dummy-scans') ?? 0);
    if (opts.has('--denoise')) {
      const out = one('-o');
      files.put(out, denoiseMeica({
        api, bold: await files.bytes(one('--denoise')), mixing: await files.text(one('--mixing')),
        metrics: await files.text(one('--metrics')), dummyScans, gzip: out.endsWith('.gz'),
      }));
      return { code: 0, stdout: '', stderr: '' };
    }
    const tree = one('--tree') ?? 'tedana_orig';
    const options = { tree: files.has(tree) ? await files.text(tree) : tree, dummy_scans: dummyScans };
    if (opts.has('--external')) options.external = await files.text(one('--external'));
    const echoes = [];
    for (const p of opts.get('-d') ?? []) echoes.push({ name: p, bytes: await files.bytes(p) });
    const mask = opts.has('--mask') ? await files.bytes(one('--mask')) : undefined;
    const { files: outs } = runMeica({ api, echoes, tes: (opts.get('-e') ?? []).map(Number), options, mask });
    for (const { name, bytes } of outs) files.put(`${one('--out-dir')}/${name}`, bytes);
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** Driver table keyed by the tool names in the core's commands. */
export function drivers({ niimath, mindgrab, mindgrabOptions, greedy, synthsr, glm, meica }) {
  const brainchop = mindgrabDriver(mindgrab, mindgrabOptions);
  return {
    niimath: niimathDriver(niimath),
    'brainchop-mindgrab': brainchop,
    'brainchop-mindmap': brainchop,
    'greedy-rs': greedyDriver(greedy),
    synthsr: synthsrDriver(synthsr),
    glm: glmDriver(glm),
    ...(meica && { meica: meicaDriver(meica) }),
  };
}
