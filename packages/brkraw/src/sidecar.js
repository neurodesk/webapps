// Scrubbed BIDS-style JSON sidecar generator for Bruker ParaVision scans.
// Intentionally omits all identifying study/subject/operator/date/UID fields.
import { stripJcampString } from './jcamp.js';

function firstNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (Array.isArray(val) && val.length > 0) return firstNumber(val[0]);
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function numberList(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'number') return Number.isFinite(val) ? [val] : [];
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      const n = firstNumber(item);
      if (n !== null) out.push(n);
    }
    return out;
  }
  const n = Number(val);
  return Number.isFinite(n) ? [n] : [];
}

function msToSeconds(val) {
  const n = firstNumber(val);
  return n === null ? null : Number((n / 1000).toFixed(6));
}

function msArrayToSeconds(val) {
  const nums = numberList(val);
  if (nums.length <= 1) return null;
  const distinct = new Set(nums);
  if (distinct.size <= 1) return null;
  return nums.map((n) => Number((n / 1000).toFixed(6)));
}

function cleanArray(val) {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map((v) => (typeof v === 'string' ? stripJcampString(v) : v));
  return [typeof val === 'string' ? stripJcampString(val) : val];
}

/**
 * Build a privacy-scrubbed BIDS-compatible JSON metadata object for a converted Bruker scan.
 * Never includes subject ID/name/DOB/sex/weight, operator, study/acquisition dates, or DICOM UIDs.
 */
export function buildScrubbedSidecar({
  softwareVersion = null,
  scanId,
  recoId,
  slicePackIndex = 0,
  slicePackCount = 1,
  dim = null,
  acqp,
  method,
  visuPars,
  shape,
  zooms,
  affineInfo,
  sclSlope,
  sclInter,
  perFrameScalingApplied = false,
  converterVersion = '0.1.0',
}) {
  const rawEchoTime = visuPars.get('VisuAcqEchoTime') ?? method.get('PVM_EchoTime');
  const sliceThickness = dim === 3
    ? (zooms?.[2] ? Number(zooms[2].toFixed(6)) : null)
    : firstNumber(visuPars.get('VisuCoreFrameThickness') ?? method.get('PVM_SliceThick'));

  const sidecar = {
    Manufacturer: 'Bruker BioSpin',
    SoftwareVersions: softwareVersion ? `ParaVision ${softwareVersion}` : null,
    MagneticFieldStrength: firstNumber(visuPars.get('VisuMagneticFieldStrength'))
      ?? (firstNumber(acqp.get('BF1')) ? Number((firstNumber(acqp.get('BF1')) / 42.576).toFixed(3)) : null),
    PulseSequenceType: stripJcampString(method.get('Method')) || null,
    SequenceName: stripJcampString(visuPars.get('VisuAcqSequenceName') ?? acqp.get('ACQ_protocol_name')) || null,
    ProtocolName: stripJcampString(acqp.get('ACQ_protocol_name') ?? acqp.get('ACQ_scan_name')) || null,
    BrukerSeriesType: stripJcampString(visuPars.get('VisuSeriesTypeId')) || null,
    RepetitionTime: msToSeconds(visuPars.get('VisuAcqRepetitionTime') ?? method.get('PVM_RepetitionTime')),
    EchoTime: msToSeconds(rawEchoTime),
    EchoTimes: msArrayToSeconds(rawEchoTime),
    InversionTime: msToSeconds(visuPars.get('VisuAcqInversionTime')),
    FlipAngle: firstNumber(visuPars.get('VisuAcqFlipAngle') ?? acqp.get('ACQ_flip_angle')),
    EchoTrainLength: firstNumber(visuPars.get('VisuAcqEchoTrainLength') ?? method.get('PVM_RareFactor')),
    NumberOfAverages: firstNumber(visuPars.get('VisuAcqNAverages') ?? method.get('PVM_NAverages')),
    PixelBandwidth: firstNumber(visuPars.get('VisuAcqPixelBandwidth')),
    SliceThickness: sliceThickness,
    MatrixSize: shape,
    VoxelSizeMm: zooms.map((z) => Number(z.toFixed(6))),
    SliceOrientation: cleanArray(method.get('PVM_SPackArrSliceOrient')),
    ReadOrientation: cleanArray(method.get('PVM_SPackArrReadOrient')),
    CoordinateSpace: affineInfo.space,
    SubjectType: affineInfo.effectiveSubjectType,
    SubjectPosition: affineInfo.effectiveSubjectPosition,
    BrukerScanId: scanId,
    BrukerRecoId: recoId,
    SlicePackIndex: slicePackIndex,
    SlicePackCount: slicePackCount,
    RescaleSlope: sclSlope,
    RescaleIntercept: sclInter,
    PerFrameScalingApplied: perFrameScalingApplied,
    ConversionSoftware: 'Neurodesk BrkRaw',
    ConversionSoftwareVersion: converterVersion,
    UpstreamReference: 'BrkRaw 0.5.7 (5664cef2)',
    ScrubbedIdentifiers: true,
  };

  // Strip null/empty values for clean BIDS JSON output
  const clean = {};
  for (const [k, v] of Object.entries(sidecar)) {
    if (v !== null && v !== undefined && v !== '') {
      clean[k] = v;
    }
  }
  return clean;
}
