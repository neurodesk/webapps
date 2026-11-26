// Tool drivers: each accepts exactly the command line the fastprep core emits (as in work/commands.sh) and runs it
// on the matching browser runtime over in-memory files. Unknown options fail rather than being ignored.

import { createNiftiFromData, decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { isReversePair } from '@neurodesk/sdc';
import { denoiseMeica, runMeica } from '@niivue/meica';
import { encodeFor, gunzip } from '@neurodesk/pipeline-drivers/files';
import { greedyDriver, mindgrabDriver, niimathDriver, parse, synthsrDriver } from '@neurodesk/pipeline-drivers/drivers';

export { greedyDriver, mindgrabDriver, niimathDriver, synthsrDriver };

const text = (s) => new TextEncoder().encode(s);

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
