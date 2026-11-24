// Runs @neurodesk/tumour-report in Node (ONNX Runtime CPU + Greedy single-thread WASM)
// on a native-space T1c scan and compares outputs against the pinned Raidionics v1.3.2
// Docker container reference (brain mask, tumour mask, deterministic MNI RADS features,
// and end-to-end Greedy MNI alignment).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as ort from 'onnxruntime-node';
import { readVolume } from '@neurodesk/synthsr';
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { segmentTumour } from '../src/pipeline.js';
import { computeNativeMorphometry } from '../src/morphometry.js';
import { computeMniRads, normalizeToMniWithGreedy, parseBcbTractsPack } from '../src/rads.js';
import { buildReport, caseName, compareBinaryMasks } from '../src/results.js';
import lobeLabels from '../src/data/mni_lobes.json' with { type: 'json' };
import schaefer7Labels from '../src/data/schaefer7.json' with { type: 'json' };
import schaefer17Labels from '../src/data/schaefer17.json' with { type: 'json' };

function parseArgs(argv) {
  const out = { tumourType: 'metastasis', threads: 4, deformable: false, skullStripped: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--deformable') out.deformable = true;
    else if (arg === '--skull-stripped') out.skullStripped = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[++i];
    }
  }
  out.threads = Number(out.threads || 4);
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.models || !args.atlases) {
  console.error('Usage: node validation/parity.mjs --input <t1c.nii.gz> --models <dir> --atlases <dir> [--container-brain <nii>] [--container-tumour <nii>] [--container-mni-tumour <nii>] [--gt-mask <nii>] [--out-dir <dir>]');
  process.exit(2);
}

const t0 = performance.now();
const vol = readVolume((await readFile(args.input)).buffer);

let brainSess = null;
let tumorSess = null;
const seg = await segmentTumour({
  volume: vol,
  skullStripped: args.skullStripped,
  runBrain: async (tile, shape) => {
    brainSess = await ort.InferenceSession.create(join(args.models, 'raidionics-v13-brain.onnx'), {
      intraOpNumThreads: args.threads,
    });
    const out = await brainSess.run({ input: new ort.Tensor('float32', tile, shape) });
    await brainSess.release();
    brainSess = null;
    return out.output.data;
  },
  runTumorCore: async (tile, shape) => {
    if (!tumorSess) {
      tumorSess = await ort.InferenceSession.create(join(args.models, 'raidionics-v13-tumorcore-t1c.onnx'), {
        intraOpNumThreads: args.threads,
      });
    }
    const out = await tumorSess.run({ input: new ort.Tensor('float32', tile, shape) });
    return out.output.data;
  },
  onProgress: (p) => console.error(`[progress] ${p.stage}: ${p.message}`),
});
if (tumorSess) await tumorSess.release();
const tSeg = performance.now();

const morph = computeNativeMorphometry({
  tumourMask: seg.tumourMask,
  brainMask: seg.brainMask,
  dims: seg.dims,
  affine: seg.affine,
});

const greedyApi = await loadGreedySingleThread();
const mniTemplateBytes = await readFile(join(args.atlases, 'mni_icbm152_t1_brain.nii.gz'));
const mni = await normalizeToMniWithGreedy({
  volume: vol,
  brainMask: seg.brainMask,
  tumourMask: seg.tumourMask,
  mniTemplateBytes,
  greedyApi,
  deformable: args.deformable,
  onProgress: (p) => console.error(`[progress] ${p.stage}: ${p.message}`),
});
const tReg = performance.now();

const loadMask = async (f) => Uint8Array.from(readVolume((await readFile(join(args.atlases, f))).buffer).data);
const loadFloat = async (f) => readVolume((await readFile(join(args.atlases, f))).buffer).data;
const atlases = {
  lateralisation: await loadMask('mni_lateralisation.nii.gz'),
  lobes: await loadMask('mni_lobes.nii.gz'),
  lobeLabels,
  schaefer7: await loadMask('schaefer7_mni.nii.gz'),
  schaefer7Labels,
  schaefer17: await loadMask('schaefer17_mni.nii.gz'),
  schaefer17Labels,
  bcbTracts: parseBcbTractsPack(gunzipSync(await readFile(join(args.atlases, 'bcb_tracts.bin.gz')))),
  resectLeft: await loadFloat('resect_left_mni.nii.gz'),
  resectRight: await loadFloat('resect_right_mni.nii.gz'),
};
const rads = computeMniRads({
  mniMask: mni.mniMask,
  dims: mni.dims,
  tumourType: args.tumourType,
  atlases,
});
const tRads = performance.now();

const label = caseName(basename(args.input));
const report = buildReport({
  caseLabel: label,
  tumourType: args.tumourType,
  dims: seg.dims,
  affine: seg.affine,
  brainMask: seg.brainMask,
  tumourMask: seg.tumourMask,
  mniMask: mni.mniMask,
  mniDims: mni.dims,
  mniAffine: mni.affine,
  morphometry: morph,
  rads,
  warnings: seg.warnings,
});

if (args.outDir) {
  await mkdir(args.outDir, { recursive: true });
  await writeFile(join(args.outDir, report.brainMask.name), Buffer.from(report.brainMask.bytes));
  await writeFile(join(args.outDir, report.tumourMask.name), Buffer.from(report.tumourMask.bytes));
  await writeFile(join(args.outDir, report.tumourMaskMni.name), Buffer.from(report.tumourMaskMni.bytes));
  await writeFile(join(args.outDir, report.reportJson.name), report.reportJson.text);
  await writeFile(join(args.outDir, report.lesionsTsv.name), report.lesionsTsv.text);
  await writeFile(join(args.outDir, report.summaryTsv.name), report.summaryTsv.text);
}

const summary = {
  caseLabel: label,
  patches: seg.patches,
  timingsSec: {
    segmentation: Number(((tSeg - t0) / 1000).toFixed(2)),
    mniRegistration: Number(((tReg - tSeg) / 1000).toFixed(2)),
    rads: Number(((tRads - tReg) / 1000).toFixed(2)),
    total: Number(((tRads - t0) / 1000).toFixed(2)),
  },
  morphometry: {
    lesionCount: morph.lesionCount,
    totalVolumeMl: morph.totalVolumeMl,
    brainVolumeMl: morph.brainVolumeMl,
    multifocal: morph.multifocal,
    maxMinFociDistanceMm: morph.maxMinFociDistanceMm,
  },
  radsSummary: {
    mniVolumeMl: rads.mniVolumeMl,
    laterality: rads.laterality,
    resectability: rads.resectability,
    topLobes: rads.cortical.mniLobes.involved.slice(0, 5),
    topSchaefer7: rads.cortical.schaefer7.involved.slice(0, 5),
    overlappingTracts: rads.subcortical.overlapping.slice(0, 6),
    nearbyTracts: rads.subcortical.nearby.slice(0, 5),
  },
};

if (args.gtMask) {
  const gt = Uint8Array.from(readVolume((await readFile(args.gtMask)).buffer).data, (v) => (v > 0.5 ? 1 : 0));
  summary.vsGroundTruth = compareBinaryMasks(seg.tumourMask, gt);
}
if (args.containerBrain) {
  const cb = Uint8Array.from(readVolume((await readFile(args.containerBrain)).buffer).data, (v) => (v > 0.5 ? 1 : 0));
  summary.vsContainerBrain = compareBinaryMasks(seg.brainMask, cb);
}
if (args.containerTumour) {
  const ct = Uint8Array.from(readVolume((await readFile(args.containerTumour)).buffer).data, (v) => (v > 0.5 ? 1 : 0));
  summary.vsContainerTumour = compareBinaryMasks(seg.tumourMask, ct);
}
if (args.containerMniTumour) {
  const cm = Uint8Array.from(readVolume((await readFile(args.containerMniTumour)).buffer).data, (v) => (v > 0.5 ? 1 : 0));
  summary.vsContainerMniTumourGreedy = compareBinaryMasks(mni.mniMask, cm);
  summary.radsOnContainerMniMask = computeMniRads({
    mniMask: cm,
    dims: mni.dims,
    tumourType: args.tumourType,
    atlases,
  });
}

console.log(JSON.stringify(summary, null, 2));
