// Output serializers, NIfTI writers, TSV/JSON report builders, and parity comparison
// utilities for @neurodesk/tumour-report.
import { writeVolume } from '@neurodesk/synthsr';

export const REPORT_SCHEMA_VERSION = 1;

export function caseName(fileName) {
  const raw = Array.isArray(fileName) ? (fileName[0] ?? '') : (fileName ?? '');
  const stem = String(raw).replace(/\.nii(\.gz)?$/i, '').replace(/[-_.\s]+$/, '');
  return stem || 'tumour-report';
}

export function outputNames(caseLabel) {
  return {
    brainMask: `${caseLabel}_brain_mask.nii`,
    tumourMask: `${caseLabel}_tumour_mask.nii`,
    tumourMaskMni: `${caseLabel}_tumour_mask_mni.nii`,
    reportJson: `${caseLabel}_report.json`,
    lesionsTsv: `${caseLabel}_lesions.tsv`,
    summaryTsv: `${caseLabel}_rads_summary.tsv`,
  };
}

export function lesionsTable(lesions) {
  const header = [
    'lesion_id',
    'voxels',
    'volume_ml',
    'centroid_x_mm',
    'centroid_y_mm',
    'centroid_z_mm',
    'equiv_diam_mm',
    'max_3d_diam_mm',
    'axial_slice',
    'axial_long_mm',
    'axial_short_mm',
    'axial_product_mm2',
    'measurable_10x10mm',
    'surface_area_mm2',
    'sphericity',
  ];
  const lines = [header.join('\t')];
  for (const l of lesions) {
    const ax = l.axialBidimensional;
    lines.push([
      l.id,
      l.voxels,
      l.volumeMl.toFixed(3),
      l.centroidMm[0].toFixed(2),
      l.centroidMm[1].toFixed(2),
      l.centroidMm[2].toFixed(2),
      l.equivalentDiameterMm.toFixed(2),
      l.maxDiameter3dMm.toFixed(2),
      ax.sliceIndex ?? '',
      ax.longAxisMm.toFixed(2),
      ax.shortAxisMm.toFixed(2),
      ax.crossProductMm2.toFixed(2),
      ax.measurable10x10mm ? 'yes' : 'no',
      l.surfaceAreaMm2.toFixed(2),
      l.sphericity.toFixed(4),
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function radsSummaryTable({ tumourType, morphometry, rads }) {
  const lines = ['section\tmetric\tvalue\tunit'];
  const row = (section, metric, value, unit = '') => {
    lines.push([section, metric, value ?? '', unit].join('\t'));
  };
  row('summary', 'tumour_type', tumourType);
  row('summary', 'status', morphometry.status);
  row('summary', 'lesion_count', morphometry.lesionCount);
  row('summary', 'total_volume', morphometry.totalVolumeMl.toFixed(3), 'mL');
  if (morphometry.brainVolumeMl !== null) {
    row('summary', 'brain_volume', morphometry.brainVolumeMl.toFixed(2), 'mL');
  }
  if (morphometry.brainPercentage !== null) {
    row('summary', 'tumour_to_brain_ratio', morphometry.brainPercentage.toFixed(2), '%');
  }
  row('summary', 'multifocal', morphometry.multifocal ? 'yes' : 'no');
  row('summary', 'qualifying_foci_ge_0.1ml', morphometry.multifocalCount);
  if (morphometry.maxMinFociDistanceMm >= 0) {
    row('summary', 'max_min_foci_distance', morphometry.maxMinFociDistanceMm.toFixed(2), 'mm');
  }
  if (morphometry.largestDiameters) {
    const d = morphometry.largestDiameters;
    row('largest_lesion', 'equivalent_diameter', d.equivalentDiameterMm.toFixed(2), 'mm');
    row('largest_lesion', 'max_3d_diameter', d.maxDiameter3dMm.toFixed(2), 'mm');
    row('largest_lesion', 'axial_long_diameter', d.axialLongMm.toFixed(2), 'mm');
    row('largest_lesion', 'axial_short_diameter', d.axialShortMm.toFixed(2), 'mm');
    row('largest_lesion', 'axial_cross_product', d.axialCrossProductMm2.toFixed(2), 'mm^2');
  }
  if (rads) {
    row('mni_laterality', 'mni_volume', rads.mniVolumeMl.toFixed(3), 'mL');
    row('mni_laterality', 'left_hemisphere', rads.laterality.leftPct.toFixed(2), '%');
    row('mni_laterality', 'right_hemisphere', rads.laterality.rightPct.toFixed(2), '%');
    row('mni_laterality', 'midline_crossing', rads.laterality.midlineCrossing ? 'yes' : 'no');
    if (rads.resectability) {
      row('gbm_resectability', 'resectability_index', rads.resectability.resectabilityIndex.toFixed(4));
      row('gbm_resectability', 'expected_resectable_volume', rads.resectability.expectedResectableMl.toFixed(3), 'mL');
      row('gbm_resectability', 'expected_residual_volume', rads.resectability.expectedResidualMl.toFixed(3), 'mL');
    }
    for (const item of rads.cortical.mniLobes.involved) {
      row('mni_lobes', item.name, item.overlapPct.toFixed(2), '%');
    }
    if (rads.cortical.schaefer7) {
      for (const item of rads.cortical.schaefer7.involved) {
        row('schaefer7', item.name, item.overlapPct.toFixed(2), '%');
      }
    }
    if (rads.subcortical) {
      for (const tract of rads.subcortical.overlapping) {
        row('bcb_tract_overlap', tract.name, tract.overlapPct.toFixed(2), '%');
      }
      for (const tract of rads.subcortical.nearby.slice(0, 10)) {
        row('bcb_tract_distance', tract.name, tract.minDistanceMm.toFixed(2), 'mm');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function buildReport({
  caseLabel,
  tumourType = 'glioblastoma',
  dims,
  affine,
  brainMask = null,
  tumourMask,
  mniMask = null,
  mniDims = null,
  mniAffine = null,
  morphometry,
  rads = null,
  provenance = {},
  warnings = [],
}) {
  const names = outputNames(caseLabel);
  const reportObject = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    notice: 'Research software only. Atlas-based estimates and automated image measurements are not for clinical diagnosis or surgical planning.',
    caseLabel,
    tumourType,
    nativeGeometry: { dims, affine },
    morphometry,
    rads,
    warnings,
    provenance,
  };
  const out = {
    report: reportObject,
    reportJson: {
      name: names.reportJson,
      text: `${JSON.stringify(reportObject, null, 2)}\n`,
    },
    lesionsTsv: {
      name: names.lesionsTsv,
      text: lesionsTable(morphometry.lesions),
    },
    summaryTsv: {
      name: names.summaryTsv,
      text: radsSummaryTable({ tumourType, morphometry, rads }),
    },
    tumourMask: {
      name: names.tumourMask,
      bytes: writeVolume({ data: tumourMask, dims, affine }, 'Raidionics v1.3 contrast-enhancing tumour core mask'),
    },
  };
  if (brainMask) {
    out.brainMask = {
      name: names.brainMask,
      bytes: writeVolume({ data: brainMask, dims, affine }, 'Raidionics v1.3 brain mask'),
    };
  }
  if (mniMask && mniDims && mniAffine) {
    out.tumourMaskMni = {
      name: names.tumourMaskMni,
      bytes: writeVolume({ data: mniMask, dims: mniDims, affine: mniAffine }, 'Tumour core mask in MNI ICBM152 2009a 1mm space'),
    };
  }
  return out;
}

export function compareBinaryMasks(predicted, reference) {
  if (predicted.length !== reference.length) {
    throw new Error(`Mask length mismatch: ${predicted.length} vs ${reference.length}`);
  }
  let predCount = 0;
  let refCount = 0;
  let both = 0;
  let differing = 0;
  for (let i = 0; i < predicted.length; i++) {
    const a = predicted[i] ? 1 : 0;
    const b = reference[i] ? 1 : 0;
    predCount += a;
    refCount += b;
    if (a && b) both++;
    if (a !== b) differing++;
  }
  const denom = predCount + refCount;
  const dice = denom > 0 ? (2 * both) / denom : 1;
  return {
    predictedVoxels: predCount,
    referenceVoxels: refCount,
    intersectionVoxels: both,
    differing,
    dice: Number(dice.toFixed(5)),
  };
}
