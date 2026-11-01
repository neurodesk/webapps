// Tool drivers: each accepts exactly the command line the fastprep core emits (as in work/commands.sh) and runs it
// on the matching browser runtime over in-memory files. Unknown options fail rather than being ignored.

import { createNiftiFromData, decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { isReversePair } from '@neurodesk/sdc';
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
      const matrix = await api.register_affine_masked_wasm(await raw(fixed), await raw(moving), mask, a.one('-m')?.[0] ?? 'NMI', iters, a.has('-ia-image-centers'));
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
 * meica (tedana's ME-ICA) through @niivue/meica's single-threaded WASM: `meica` is its module, or a function that
 * loads it (so single-echo sessions never fetch it). The classification call
 * (`-d ECHO... -e TE... --mask M --dummy-scans N --tree T [--external TSV] --n-threads K --quiet --out-dir D`, files
 * written under D with meica's names) and `--denoise BOLD --mixing TSV --metrics TSV --dummy-scans N -o OUT`.
 */
export function meicaDriver(meica) {
  const arity = {
    '-d': null, '-e': null, '--mask': 1, '--dummy-scans': 1, '--tree': 1, '--external': 1, '--n-threads': 1,
    '--quiet': 0, '--out-dir': 1, '--denoise': 1, '--mixing': 1, '--metrics': 1, '-o': 1,
  };
  return async (argv, { files }) => {
    const opts = new Map();
    for (let i = 1; i < argv.length;) {
      const flag = argv[i];
      if (!Object.hasOwn(arity, flag)) throw new Error(`meica: ${flag} is not supported in the browser`);
      let j = i + 1;
      if (arity[flag] === null) {
        while (j < argv.length && !argv[j].startsWith('-')) j++;
        if (j === i + 1) throw new Error(`meica: ${flag} needs at least 1 value`);
      } else {
        j += arity[flag];
        if (j > argv.length || argv.slice(i + 1, j).some(value => value.startsWith('-'))) {
          throw new Error(`meica: ${flag} needs ${arity[flag]} value(s)`);
        }
      }
      opts.set(flag, argv.slice(i + 1, j));
      i = j;
    }
    const api = typeof meica === 'function' ? await meica() : meica;
    const one = (k) => opts.get(k)?.[0];
    const dummyScans = Number(one('--dummy-scans'));
    if (opts.has('--denoise')) {
      const out = one('-o');
      files.put(out, denoiseMeica({
        api, bold: await files.bytes(one('--denoise')), mixing: await files.text(one('--mixing')),
        metrics: await files.text(one('--metrics')), dummyScans, gzip: out.endsWith('.gz'),
      }));
      return { code: 0, stdout: '', stderr: '' };
    }
    const tree = one('--tree');
    const options = { tree: files.has(tree) ? await files.text(tree) : tree, dummy_scans: dummyScans };
    if (opts.has('--external')) options.external = await files.text(one('--external'));
    const echoes = [];
    for (const p of opts.get('-d')) echoes.push({ name: p, bytes: await files.bytes(p) });
    const mask = opts.has('--mask') ? await files.bytes(one('--mask')) : undefined;
    const { files: outs } = runMeica({ api, echoes, tes: opts.get('-e').map(Number), options, mask });
    for (const { name, bytes } of outs) files.put(`${one('--out-dir')}/${name}`, bytes);
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** The core emits temporal means and explicit BIDS acquisition metadata for this solver. */
export function sdcDriver(runtime) {
  let loaded;
  return async (argv, { files }) => {
    const { pos, one } = parse(argv, { '--pe1': 1, '--pe2': 1, '--trt': 1 });
    if (pos.length !== 4 || pos[0] !== 'pyhysco') {
      throw new Error('sdc: expected pyhysco IMAGE1 IMAGE2 PREFIX');
    }
    const [, image1, image2, prefix] = pos;
    const pe1 = one('--pe1')?.[0];
    const pe2 = one('--pe2')?.[0];
    if (!isReversePair(pe1, pe2)) throw new Error('sdc: images require opposite phase-encoding directions');
    const trt = Number(one('--trt')?.[0]);
    if (!Number.isFinite(trt) || trt <= 0) throw new Error('sdc: TotalReadoutTime must be finite and positive');
    const buffers = await Promise.all([image1, image2].map(async (path) => decodeNiftiBuffer(await files.bytes(path))));
    if (!sameNiftiGrid(...buffers)) throw new Error('sdc: EPI images must share a spatial grid');
    const images = buffers.map((buffer) => readNiftiFrames(buffer, Float64Array));
    if (images.some(({ frames, header }) => frames !== 1 || header.dims[0] > 4)) {
      throw new Error('sdc: the fastprep driver requires one temporal mean per EPI image');
    }
    const { dims, header } = images[0];
    const voxel = dims.map((_, axis) => Math.hypot(...header.affine.slice(0, 3).map((row) => row[axis])));
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        const cosine = header.affine.slice(0, 3).reduce((sum, row) => sum + row[a] * row[b], 0) / (voxel[a] * voxel[b]);
        if (!Number.isFinite(cosine) || Math.abs(cosine) > 1e-5) throw new Error('sdc: sheared EPI grids are unsupported');
      }
    }
    loaded ??= Promise.resolve(typeof runtime === 'function' ? runtime() : runtime);
    const api = await loaded;
    const result = api.pyhysco(images[0].data, images[1].data, dims, voxel, {
      phaseEncodingDirection: pe1,
      totalReadoutTime: trt,
    });
    for (const [suffix, values] of [['fieldmap', result.field], ['corrected1', result.corrected1], ['corrected2', result.corrected2]]) {
      const path = `${prefix}_${suffix}.nii.gz`;
      const bytes = createNiftiFromData(Float32Array.from(values), buffers[0], { dims });
      files.put(path, await encodeFor(path, new Uint8Array(bytes)));
    }
    files.put(`${prefix}_fieldmap.json`, text(`${JSON.stringify({
      Units: 'Hz',
      PhaseEncodingDirection: pe1,
      TotalReadoutTime: trt,
      Description: 'Susceptibility field from a reverse phase-encoding pair, PyHySCO 0.0.4 defaults, sdc. Sign as FSL topup: image 1 corrected is image1(x + field * TotalReadoutTime * PE sign) voxels.',
    }, null, 2)}\n`));
    return { code: 0, stdout: `PyHySCO: ${result.iterations} iterations`, stderr: '' };
  };
}

/** Driver table keyed by the tool names in the core's commands. */
export function drivers({ niimath, mindgrab, mindgrabOptions, greedy, synthsr, glm, meica, sdc }) {
  const brainchop = mindgrabDriver(mindgrab, mindgrabOptions);
  return {
    niimath: niimathDriver(niimath),
    'brainchop-mindgrab': brainchop,
    'brainchop-mindmap': brainchop,
    'greedy-rs': greedyDriver(greedy),
    synthsr: synthsrDriver(synthsr),
    glm: glmDriver(glm),
    ...(sdc && { sdc: sdcDriver(sdc) }),
    ...(meica && { meica: meicaDriver(meica) }),
  };
}
