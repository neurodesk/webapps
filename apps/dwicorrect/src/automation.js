import { imageFiles } from '@neurodesk/webapp-components/automation';

/** Acquisition values for automation must come from metadata or explicit parameters. */
export function acquisitionSidecar(sidecar, parameters = {}) {
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new Error('The acquisition sidecar must contain a JSON object.');
  }
  const result = { ...sidecar };
  if (parameters.phaseEncodingDirection !== undefined) result.PhaseEncodingDirection = parameters.phaseEncodingDirection;
  if (parameters.totalReadoutTime !== undefined) result.TotalReadoutTime = parameters.totalReadoutTime;
  if (parameters.multiband !== undefined) result.MultibandAccelerationFactor = parameters.multiband;
  if (!['i', 'i-', 'j', 'j-'].includes(result.PhaseEncodingDirection)) {
    throw new Error('Automation requires PhaseEncodingDirection in the sidecar or a phaseEncodingDirection parameter (i, i-, j or j-).');
  }
  if (typeof result.TotalReadoutTime !== 'number' || !Number.isFinite(result.TotalReadoutTime) || result.TotalReadoutTime <= 0) {
    throw new Error('Automation requires a finite positive TotalReadoutTime in the sidecar or a totalReadoutTime parameter in seconds.');
  }
  if (parameters.sliceToVolume && !Array.isArray(result.SliceTiming)) {
    throw new Error('Slice-to-volume correction requires SliceTiming in the sidecar.');
  }
  return result;
}

/** Resolve independently named input roles before the existing page import path. */
export async function correctionFiles(inputs, inputDetails = {}, parameters = {}) {
  const dwi = imageFiles(inputs, inputDetails, { image: 'dwi' });
  const metadata = dwi.find(file => /\.json$/i.test(file.name));
  const sidecar = acquisitionSidecar(metadata ? JSON.parse(await metadata.text()) : {}, parameters);
  const stem = inputs.dwi[0].name.replace(/\.nii(?:\.gz)?$/i, '');
  const reverse = imageFiles(inputs, inputDetails, { image: 'reverse', sidecar: 'reverseSidecar', bval: null, bvec: null, name: inputs.reverse?.[0] ? `reverse_${inputs.reverse[0].name}` : undefined });
  const field = inputs.fieldmap?.[0];
  const fieldmap = field && !/_fieldcoef\.nii(?:\.gz)?$/i.test(field.name)
    ? new File([field], `automation_fieldmap${field.name.endsWith('.gz') ? '.nii.gz' : '.nii'}`, { type: field.type })
    : field;
  return [
    ...dwi.filter(file => !/\.json$/i.test(file.name)),
    new File([JSON.stringify(sidecar)], `${stem}.json`, { type: 'application/json' }),
    ...reverse,
    ...(fieldmap ? [fieldmap] : []),
  ];
}
