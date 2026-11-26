// JHU-ICBM atlas overlap, QFV computation, Random Forest feature preparation,
// CSV generation, core-penumbra mismatch, and OpenADS Automatic Radiological Report.
import { voxelCount, assertMatchingGeometry } from './volume.js';

export const MNI182_DIMS = [182, 218, 182];

export const ATLAS_SPECS = {
  vascular: {
    name: 'Vascular territory',
    niftiPath: 'atlases/ArterialAtlas_MNI182.nii.gz',
    lookupPath: 'atlases/Vas_Lookup_Volume_df_MNI.json',
  },
  lobe: {
    name: 'Lobe / anatomical region',
    niftiPath: 'atlases/LobeAtlas_MNI182.nii.gz',
    lookupPath: 'atlases/Lobe_Lookup_Volume_df_MNI.json',
  },
  aspects: {
    name: 'ASPECTS region',
    niftiPath: 'atlases/AspectsAtlas_MNI182.nii.gz',
    lookupPath: 'atlases/Aspects_Lookup_Volume_df_MNI.json',
  },
  aspectpc: {
    name: 'Posterior-circulation ASPECTS',
    niftiPath: 'atlases/AspectsPcaAtlas_MNI182.nii.gz',
    lookupPath: 'atlases/Aspects_PCA_Lookup_Volume_df_MNI.json',
  },
  bpmType1: {
    name: 'JHU BPM Type-I',
    niftiPath: 'atlases/BPMTypeIV2Atlas_MNI182.nii.gz',
    lookupPath: 'atlases/JHU_MNI_SS_BPM_TypeI_V2_Lookup_Volume_df_MNI.json',
  },
};

export const VENTRICLES_SPEC = {
  name: 'Enlarged lateral ventricles',
  niftiPath: 'atlases/VentriclesEnlargedAtlas_MNI182.nii.gz',
  lookupPath: 'atlases/Ventricles_LVOR_LVIR_Lookup_Volume_df_MNI.json',
  adcThreshold: 0.549,
};

export const RF_MODELS = {
  vascular: ['ACA', 'MCA', 'PCA', 'cerebellar', 'basilar', 'Lenticulostriate', 'Choroidal_Thalamoperfurating'],
  lobe: [
    'basal_ganglia',
    'deep_white_matter',
    'cerebellum',
    'frontal',
    'insula',
    'internal_capsule',
    'brainstem',
    'occipital',
    'parietal',
    'temporal',
    'thalamus',
  ],
  aspects: ['Caudate', 'lentiform', 'IC', 'insula', 'M1', 'M2', 'M3', 'M6', 'M5', 'M4'],
};

export const QFV_LABELS = {
  vascular: ['ACA', 'MCA', 'PCA', 'cerebellar', 'basilar', 'Lenticulostriate', 'Choroidal & Thalamoperfurating', 'watershed'],
  lobe: ['basal ganglia', 'deep white matter', 'cerebellum', 'frontal', 'insula', 'internal capsule', 'brainstem', 'occipital', 'parietal', 'temporal', 'thalamus'],
  aspects: ['Caudate', 'lentiform', 'IC', 'insula', 'M1', 'M2', 'M3', 'M6', 'M5', 'M4'],
  aspectpc: ['PCA', 'Thalamus', 'Cerebellum', 'Pons', 'Midbrain'],
};

const ASPECTS_PAIRS = [
  ['caudate_L', 'caudate_R'],
  ['lentiform_L', 'lentiform_R'],
  ['intern_capsule_L', 'intern_capsule_R'],
  ['insula_L', 'insula_R'],
  ['M1_L', 'M1_R'],
  ['M2_L', 'M2_R'],
  ['M3_L', 'M3_R'],
  ['M6_L', 'M6_R'],
  ['M5_L', 'M5_R'],
  ['M4_L', 'M4_R'],
];

const DISPLAY_NAMES = {
  ACA: 'anterior cerebral artery',
  MCA: 'middle cerebral artery',
  PCA: 'posterior cerebral artery',
  cerebellar: 'cerebellar artery',
  basilar: 'basilar artery',
  Lenticulostriate: 'lateral lenticulostriate',
  Choroidal_Thalamoperfurating: 'choroidal & thalamoperforating',
  'Choroidal & Thalamoperfurating': 'choroidal & thalamoperforating',
  basal_ganglia: 'basal ganglia',
  deep_white_matter: 'deep white matter',
  internal_capsule: 'internal capsule',
  frontal: 'frontal lobe',
  occipital: 'occipital lobe',
  parietal: 'parietal lobe',
  temporal: 'temporal lobe',
  IC: 'internal capsule',
};

export const formatRegionName = (region) => DISPLAY_NAMES[region] || region.replace(/_/g, ' ');

const round7 = (v) => Math.round(v * 1e7) / 1e7;
export const voxelVolumeMl = (pixdim) => (pixdim[0] * pixdim[1] * pixdim[2]) / 1000;
export const logVolMl = (totalMl) => round7(Math.log10(totalMl + 0.001));

export function computeLesionVolumes(lesion, dims, pixdim) {
  const vv = voxelVolumeMl(pixdim);
  const [nx, ny, nz] = dims;
  const midX = nx >> 1;
  const n = voxelCount(dims);
  const binaryMask = new Uint8Array(n);
  let total = 0;
  let left = 0;
  let right = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = y * nx + z * nx * ny;
      for (let x = 0; x < nx; x++) {
        if (lesion[base + x] > 0.5) {
          binaryMask[base + x] = 1;
          total++;
          if (x < midX) left++;
          else right++;
        }
      }
    }
  }
  return {
    totalVoxels: total,
    totalMl: total * vv,
    leftMl: left * vv,
    rightMl: right * vv,
    binaryMask,
  };
}

export function computeIcvMl(brainMask, dims, pixdim) {
  if (!brainMask) return null;
  const vv = voxelVolumeMl(pixdim);
  let count = 0;
  const n = voxelCount(dims);
  for (let i = 0; i < n; i++) {
    if (brainMask[i] > 0.5) count++;
  }
  return count > 0 ? count * vv : null;
}

export function computeMismatch(coreMask, hpMask, dims, pixdim) {
  const vv = voxelVolumeMl(pixdim);
  const n = voxelCount(dims);
  let coreV = 0;
  let hpV = 0;
  let overlapV = 0;
  let penumbraV = 0;
  for (let i = 0; i < n; i++) {
    const c = coreMask[i] > 0.5;
    const h = hpMask[i] > 0.5;
    if (c) coreV++;
    if (h) hpV++;
    if (c && h) overlapV++;
    if (h && !c) penumbraV++;
  }
  const coreMl = coreV * vv;
  const hpMl = hpV * vv;
  const overlapMl = overlapV * vv;
  const penumbraMl = penumbraV * vv;
  const mismatchVolumeMl = Math.max(0, hpMl - coreMl);
  const mismatchRatio = coreMl > 0.01 ? hpMl / coreMl : null;
  return { coreMl, hpMl, overlapMl, penumbraMl, mismatchVolumeMl, mismatchRatio };
}

export function computeAtlasOverlap(
  binaryMask,
  maskDims,
  atlasLabels,
  atlasDims,
  lookup,
  { maskAffine = null, atlasAffine = null } = {},
) {
  assertMatchingGeometry(
    { dims: maskDims, affine: maskAffine, voxels: binaryMask },
    { dims: atlasDims, affine: atlasAffine, voxels: atlasLabels },
    'lesion mask',
    'atlas',
  );
  const numRegions = lookup.regions.length;
  const counts = new Array(numRegions).fill(0);
  for (let i = 0; i < atlasLabels.length; i++) {
    if (!binaryMask[i]) continue;
    const label = Math.round(atlasLabels[i]);
    if (label >= 1 && label <= numRegions) {
      counts[label - 1]++;
    }
  }
  return lookup.regions.map((region, idx) => ({
    region,
    overlapVoxels: counts[idx],
    regionTotalVoxels: lookup.volumeVoxels[idx],
    probability: lookup.volumeVoxels[idx] > 0 ? counts[idx] / lookup.volumeVoxels[idx] : 0,
  }));
}

export function computeVentricleFeatures(
  adcMni,
  brainMask,
  dims,
  ventLabels,
  ventDims,
  lookup,
  threshold = 0.549,
  { adcAffine = null, brainMaskDims = dims, brainMaskAffine = null, ventAffine = null } = {},
) {
  assertMatchingGeometry(
    { dims, affine: adcAffine, voxels: adcMni },
    { dims: ventDims, affine: ventAffine, voxels: ventLabels },
    'ADC',
    'ventricles atlas',
  );
  assertMatchingGeometry(
    { dims: brainMaskDims, affine: brainMaskAffine, voxels: brainMask },
    { dims: ventDims, affine: ventAffine, voxels: ventLabels },
    'brain mask',
    'ventricles atlas',
  );
  const n = ventLabels.length;
  let count = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (brainMask[i] > 0.5) {
      sum += adcMni[i];
      count++;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    if (brainMask[i] > 0.5) {
      const d = adcMni[i] - mean;
      ss += d * d;
    }
  }
  const std = count > 0 ? Math.sqrt(ss / count) : 0;
  const lvo = new Array(20).fill(0);
  const lvi = new Array(20).fill(0);
  for (let i = 0; i < n; i++) {
    if (!(brainMask[i] > 0.5)) continue;
    const label = Math.round(ventLabels[i]);
    if (label < 1 || label > 20) continue;
    const z = (adcMni[i] - mean) / (std + 1e-8);
    if (z < threshold) lvo[label - 1]++;
    else if (z > threshold) lvi[label - 1]++;
  }
  const lvoCounts = lvo.slice(0, 10);
  const lviCounts = lvi.slice(10, 20);
  const qfv = [
    ...lvoCounts.map((c, i) => round7(1 - c / (lookup.lvorVolumeVoxels[i] + 1e-6))),
    ...lviCounts.map((c, i) => round7(c / (lookup.lvirVolumeVoxels[i] + 1e-6))),
  ];
  return {
    regions: lookup.regions,
    lvoCounts,
    lviCounts,
    lvorVolumeVoxels: lookup.lvorVolumeVoxels,
    lvirVolumeVoxels: lookup.lvirVolumeVoxels,
    qfv,
  };
}

function mapRegionField(rows, getter) {
  const m = new Map();
  for (const row of rows) m.set(row.region, getter(row));
  return m;
}

function vasGroupRaw(get) {
  return [
    get('ACAL') + get('MLSL'),
    get('ACAR') + get('MLSR'),
    get('MCAFL') + get('MCAPL') + get('MCATL') + get('MCAOL') + get('MCAIL'),
    get('MCAFR') + get('MCAPR') + get('MCATR') + get('MCAOR') + get('MCAIR'),
    get('PCATL') + get('PCAOL'),
    get('PCATR') + get('PCAOR'),
    get('SCL') + get('ICL'),
    get('SCR') + get('ICR'),
    get('BL'),
    get('BR'),
    get('LLSL'),
    get('LLSR'),
    get('PCTPL') + get('ACTPL'),
    get('PCTPR') + get('ACTPR'),
    get('LVL'),
    get('LVR'),
  ];
}

function lobeGroupRaw(get) {
  return [
    get('BasalGanglia_L'),
    get('BasalGanglia_R'),
    get('CSO_L') + get('CorRad_L'),
    get('CSO_R') + get('CorRad_R'),
    get('cerebellum_L'),
    get('cerebellum_R'),
    get('frontal_L'),
    get('frontal_R'),
    get('insula_L'),
    get('insula_R'),
    get('IntCapsule_L'),
    get('IntCapsule_R'),
    get('midbrain') + get('pons') + get('medulla'),
    get('occipital_L'),
    get('occipital_R'),
    get('parietal_L'),
    get('parietal_R'),
    get('temporal_L'),
    get('temporal_R'),
    get('Thalamus_L'),
    get('Thalamus_R'),
  ];
}

function combinePairs(arr) {
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push(arr[i] + arr[i + 1]);
  return out;
}

function combineLobe(arr) {
  const out = new Array(11);
  for (let i = 0; i < 6; i++) out[i] = arr[i * 2] + arr[i * 2 + 1];
  out[6] = arr[12] * 2;
  for (let i = 0; i < 4; i++) out[7 + i] = arr[13 + i * 2] + arr[14 + i * 2];
  return out;
}

function groupedFractions(rows, groupFn) {
  const ov = mapRegionField(rows, (r) => r.overlapVoxels);
  const tot = mapRegionField(rows, (r) => r.regionTotalVoxels);
  const num = groupFn((k) => ov.get(k) ?? 0);
  const den = groupFn((k) => tot.get(k) ?? 0);
  return num.map((v, i) => v / (den[i] + 1e-6));
}

export function computeQfvVectors(atlasStats, totalMl) {
  const logml = logVolMl(totalMl);
  const result = { logml };

  if (atlasStats.vascular) {
    const vals = combinePairs(groupedFractions(atlasStats.vascular, vasGroupRaw)).map(round7);
    result.vascular = {
      logml,
      labels: QFV_LABELS.vascular,
      values: vals,
      byRegion: Object.fromEntries(QFV_LABELS.vascular.map((k, i) => [k, vals[i]])),
    };
  }
  if (atlasStats.lobe) {
    const vals = combineLobe(groupedFractions(atlasStats.lobe, lobeGroupRaw)).map(round7);
    result.lobe = {
      logml,
      labels: QFV_LABELS.lobe,
      values: vals,
      byRegion: Object.fromEntries(QFV_LABELS.lobe.map((k, i) => [k, vals[i]])),
    };
  }
  if (atlasStats.aspects) {
    const ov = mapRegionField(atlasStats.aspects, (r) => r.overlapVoxels);
    const tot = mapRegionField(atlasStats.aspects, (r) => r.regionTotalVoxels);
    const frac = (k) => (ov.get(k) ?? 0) / ((tot.get(k) ?? 0) + 1e-6);
    const vals = ASPECTS_PAIRS.map(([l, r]) => round7(frac(l) + frac(r)));
    result.aspects = {
      logml,
      labels: QFV_LABELS.aspects,
      values: vals,
      byRegion: Object.fromEntries(QFV_LABELS.aspects.map((k, i) => [k, vals[i]])),
    };
  }
  if (atlasStats.aspectpc) {
    const fracs = atlasStats.aspectpc.map((r) => round7(r.overlapVoxels / (r.regionTotalVoxels + 1e-6)));
    const vals = [];
    for (let i = 0; i + 1 < fracs.length - 2; i += 2) vals.push(round7(fracs[i] + fracs[i + 1]));
    vals.push(...fracs.slice(-2));
    result.aspectpc = {
      logml,
      labels: QFV_LABELS.aspectpc,
      values: vals,
      byRegion: Object.fromEntries(QFV_LABELS.aspectpc.map((k, i) => [k, vals[i]])),
    };
  }
  return result;
}

// Build the exact feature arrays consumed by OpenADS's 28 regional RF ONNX models.
// Note: ADSWeb's AA_models take [totalMl, ...regionalVolumesMl] (verified in pipeline-slice.js:1355-1416).
export function buildRfFeatureRequests(atlasStats, totalMl, pixdim, ventricles = null) {
  const vv = voxelVolumeMl(pixdim);
  const mlMap = (rows) => mapRegionField(rows || [], (r) => r.overlapVoxels * vv);

  const vMap = mlMap(atlasStats.vascular);
  const vGet = (k) => vMap.get(k) ?? 0;
  const vasFeats = [
    vGet('ACAL') + vGet('MLSL') + vGet('ACAR') + vGet('MLSR'),
    vGet('MCAFL') + vGet('MCAPL') + vGet('MCATL') + vGet('MCAOL') + vGet('MCAIL') +
      vGet('MCAFR') + vGet('MCAPR') + vGet('MCATR') + vGet('MCAOR') + vGet('MCAIR'),
    vGet('PCATL') + vGet('PCAOL') + vGet('PCATR') + vGet('PCAOR'),
    vGet('SCL') + vGet('ICL') + vGet('SCR') + vGet('ICR'),
    vGet('BL') + vGet('BR'),
    vGet('LLSL') + vGet('LLSR'),
    vGet('PCTPL') + vGet('ACTPL') + vGet('PCTPR') + vGet('ACTPR'),
    vGet('LVL') + vGet('LVR'),
  ];

  const lMap = mlMap(atlasStats.lobe);
  const lGet = (k) => lMap.get(k) ?? 0;
  const lobeFeats = [
    lGet('BasalGanglia_L') + lGet('BasalGanglia_R'),
    lGet('CSO_L') + lGet('CorRad_L') + lGet('CSO_R') + lGet('CorRad_R'),
    lGet('cerebellum_L') + lGet('cerebellum_R'),
    lGet('frontal_L') + lGet('frontal_R'),
    lGet('insula_L') + lGet('insula_R'),
    lGet('IntCapsule_L') + lGet('IntCapsule_R'),
    (lGet('midbrain') + lGet('pons') + lGet('medulla')) * 2,
    lGet('occipital_L') + lGet('occipital_R'),
    lGet('parietal_L') + lGet('parietal_R'),
    lGet('temporal_L') + lGet('temporal_R'),
    lGet('Thalamus_L') + lGet('Thalamus_R'),
  ];

  const aMap = mlMap(atlasStats.aspects);
  const aGet = (k) => aMap.get(k) ?? 0;
  const aspectFeats = ASPECTS_PAIRS.map(([l, r]) => aGet(l) + aGet(r));

  const requests = {
    vascular: RF_MODELS.vascular.map((name, i) => ({
      region: name,
      volumeMl: vasFeats[i],
      modelPath: `models/aa/vascular/${name}.onnx`,
      features: [totalMl, ...vasFeats],
    })),
    lobe: RF_MODELS.lobe.map((name, i) => ({
      region: name,
      volumeMl: lobeFeats[i],
      modelPath: `models/aa/lobe/${name}.onnx`,
      features: [totalMl, ...lobeFeats],
    })),
    aspects: RF_MODELS.aspects.map((name, i) => ({
      region: name,
      volumeMl: aspectFeats[i],
      modelPath: `models/aa/aspects/${name}.onnx`,
      features: [totalMl, ...aspectFeats],
    })),
  };

  if (ventricles && ventricles.qfv?.length === 20) {
    requests.hydrocephalus = {
      region: 'hydrocephalus',
      modelPath: 'models/aa/hydro/hydrocephalus.onnx',
      features: [logVolMl(totalMl), ...ventricles.qfv],
    };
  }
  return requests;
}

export function csvCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (arr) => arr.map(csvCell).join(',');

export function buildQfvCsv(subjectId, qfvEntry) {
  return `${csvRow(['subject_id', 'volml', ...qfvEntry.labels])}\n${csvRow([subjectId, qfvEntry.logml, ...qfvEntry.values])}\n`;
}

export function buildLesionLoadCsv(rows) {
  return `${csvRow(rows.map((r) => r.region))}\n${csvRow(rows.map((r) => r.overlapVoxels))}\n`;
}

function formatTableSection(title, rows) {
  const lines = [
    '-'.repeat(92),
    title.padStart(Math.floor((92 + title.length) / 2)).padEnd(92),
    '-'.repeat(92),
    'ROI'.padEnd(34) + 'Predict'.padStart(12) + 'Probability'.padStart(18) + 'Volume (mL)'.padStart(20),
  ];
  for (const r of rows) {
    const prob = r.probability == null ? 'N.A.' : r.probability.toFixed(3);
    const vol = r.volumeMl == null ? 'N.A.' : r.volumeMl.toFixed(2);
    lines.push(formatRegionName(r.region).padEnd(34) + r.predict.padStart(12) + prob.padStart(18) + vol.padStart(20));
  }
  lines.push('-'.repeat(92));
  return lines.join('\n');
}

export function buildRadiologicalReportText({
  subjectId,
  modality = 'DWI',
  volumes,
  icvMl,
  interpretation,
  hydrocephalus = null,
  mismatch = null,
}) {
  const sideLabel =
    volumes.leftMl > 0.01 && volumes.rightMl > 0.01
      ? 'bilateral'
      : volumes.leftMl >= volumes.rightMl && volumes.leftMl > 0
        ? 'unilateral, within the left brain hemisphere'
        : volumes.rightMl > 0
          ? 'unilateral, within the right brain hemisphere'
          : 'absent';

  const finding = modality === 'PWI' ? 'hypoperfusion' : 'restricted diffusion';
  const vascAffected = (interpretation.vascular || []).filter((r) => r.predict === 'AFFECTED');
  const lobeAffected = (interpretation.lobe || []).filter((r) => r.predict === 'AFFECTED');
  const aspectsAffected = (interpretation.aspects || []).filter((r) => r.predict === 'AFFECTED');
  const aspectsScore = interpretation.aspects?.length ? 10 - aspectsAffected.length : null;

  const icvClause = icvMl != null && icvMl > 0
    ? `${((volumes.totalMl / icvMl) * 100).toFixed(2)}% of ICV`
    : 'ICV unavailable';
  const summary = [
    `Area of ${finding} is ${sideLabel}, with ${volumes.totalMl.toFixed(2)} mL (L ${volumes.leftMl.toFixed(2)} mL / R ${volumes.rightMl.toFixed(2)} mL; ${icvClause}).`,
    vascAffected.length
      ? `Arterial territory: ${vascAffected.map((r) => formatRegionName(r.region)).join(', ')}.`
      : 'No significant arterial territory involvement predicted.',
    lobeAffected.length
      ? `Anatomical structures involved: ${lobeAffected.map((r) => formatRegionName(r.region)).join(', ')}.`
      : 'No significant lobar or deep-structure involvement predicted.',
    hydrocephalus
      ? hydrocephalus.predict === 'AFFECTED'
        ? `Hydrocephalus predicted (p = ${hydrocephalus.probability.toFixed(3)}).`
        : `No hydrocephalus predicted (p = ${hydrocephalus.probability.toFixed(3)}).`
      : 'Hydrocephalus not evaluated (requires MNI-space ADC and brain mask).',
    aspectsScore != null ? `Predicted MCA-ASPECTS: ${aspectsScore} / 10.` : '',
    mismatch
      ? `Core-penumbra mismatch: Core ${mismatch.coreMl.toFixed(2)} mL, Hypoperfusion ${mismatch.hpMl.toFixed(2)} mL, Mismatch ${mismatch.mismatchVolumeMl.toFixed(2)} mL${mismatch.mismatchRatio != null ? ` (ratio ${mismatch.mismatchRatio.toFixed(2)}x)` : ''}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const sections = [
    `${'-'.repeat(30)} Automatic Radiological Report ${'-'.repeat(31)}`,
    'Research use only — not a clinical diagnostic report.',
    '',
    summary,
    '',
    formatTableSection('Arterial territories', interpretation.vascular || []),
    '',
    formatTableSection('Anatomical structures', interpretation.lobe || []),
    '',
    ...(hydrocephalus
      ? [
          formatTableSection('Hydrocephalus', [
            { region: 'hydrocephalus', predict: hydrocephalus.predict, probability: hydrocephalus.probability, volumeMl: null },
          ]),
          '',
        ]
      : []),
    formatTableSection('MCA ASPECTS regions', interpretation.aspects || []),
    '',
    `Subject: ${subjectId} | Modality: ${modality}`,
  ];

  return {
    text: sections.join('\n') + '\n',
    sideLabel,
    aspectsScore,
    vascAffected: vascAffected.map((r) => r.region),
    lobeAffected: lobeAffected.map((r) => r.region),
  };
}
