const formatTokens = new Set([
  'nifti', 'nii', 'nii-gz', 'nii-pair', 'analyze', 'mgh', 'mgz', 'nrrd', 'seg-nrrd', 'minc', 'mha', 'mif',
  'brik-head', 'ecat', 'npy', 'dicom', 'dicom-seg', 'ome-zarr', 'gifti', 'freesurfer-surface',
  'freesurfer-annot', 'freesurfer-label', 'mz3', 'obj', 'ply', 'stl', 'vtk', 'cifti', 'cifti-dtseries',
  'cifti-dscalar', 'cifti-dlabel', 'cifti-dconn', 'cifti-pconn', 'cifti-ptseries', 'cifti-pscalar', 'trk',
  'tck', 'trx', 'bval-bvec', 'bval', 'bvec', 'fsl-mat', 'fnirt-coef', 'fnirt-field', 'x5', 'itk-transform',
  'displacement-field', 'spm-deformation', 'mrtrix-warp', 'afni-1d', 'lta', 'xfm', 'matlab-mat',
  'freesurfer-lut', 'onnx', 'dseg-tsv', 'json', 'tsv', 'csv',
]);
const formatSpellings = { gii: 'gifti', bvals: 'bval', bvecs: 'bvec', surface: null };
const spatialTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:surface', 'neuro:tract']);
const griddedTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map']);
const contractSpatialTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:surface', 'neuro:tractogram']);

function promoteFormats(field, mapped) {
  if (mapped.formats) {
    // Formats are alternatives. Adding a broad NIfTI token would permit scalar
    // images where the alias promises a vector displacement field.
    if (field.type === 'neuro:displacement-field' && field.formats?.some(token =>
      !['nifti', 'nii', 'nii-gz', 'displacement-field'].includes(token))) {
      throw new Error('Displacement-field formats must describe a vector NIfTI displacement field');
    }
    return [...mapped.formats];
  }
  return [...new Set((field.formats ?? []).map(token => {
    if (formatTokens.has(token)) return token;
    if (Object.hasOwn(formatSpellings, token)) return formatSpellings[token];
    return `neurodesk:${token}`;
  }).filter(Boolean))];
}

function spatialInput(operation) {
  const roles = Object.entries(operation.inputs)
    .filter(([, field]) => field.source === 'files' && contractSpatialTypes.has(field.type))
    .map(([role]) => role);
  return roles.length === 1 ? roles[0] : undefined;
}

function inputReference(operation, role) {
  const input = operation.inputs[role];
  return input?.source === 'files' && input.maximum === 1 && contractSpatialTypes.has(input.type)
    ? `inputs.input_${role}` : undefined;
}

function promoteSpace(field, kind, operation, { app, operationId }) {
  if (field.space === 'MNI152-1mm' && (
    app === 'syncro' && operationId === 'normalize' ||
    app === 'disconnectome' && operationId === 'analyze'
  )) return 'MNI152NLin6Asym';
  if (kind !== 'artifacts') return undefined;
  if (app === 'syncro' && operationId === 'normalize' && field.space === 'native') {
    return inputReference(operation, 'primary');
  }
  if (app === 'topofit' && operationId === 'reconstruct' &&
    ['input', 'scanner-RAS-mm'].includes(field.space)) return inputReference(operation, 'image');
  if (app === 'dwi2trx' && operationId === 'tractography' && field.space === 'RAS-mm') {
    return inputReference(operation, 'image');
  }
  if (app === 'vesselboost' && operationId === 'segment' && field.space === 'analysis') {
    return inputReference(operation, 'image');
  }
  if (['native', 'input', 'subject-1mm'].includes(field.space)) {
    const role = spatialInput(operation);
    return role ? inputReference(operation, role) : undefined;
  }
  if (field.space === 'fixed' || field.space === 'moving') return inputReference(operation, field.space);
  return undefined;
}

// Ambiguous annotations remain in neurodesk/data. Prefixing a generic space
// would incorrectly make unrelated subjects or selected atlases share a frame.
export function qualifiers(field, kind, operation, mapped, context = {}) {
  const result = {};
  const formats = promoteFormats(field, mapped);
  if (formats.length) result.formats = formats;
  if (spatialTypes.has(mapped.type)) {
    const space = promoteSpace(field, kind, operation, context);
    if (space) result.space = space;
    if (space && griddedTypes.has(mapped.type) &&
      (field.space === 'subject-1mm' || field.space === 'MNI152-1mm')) result.resolution = 1;
  }
  if (field.labelSystem !== undefined && mapped.type === 'neuro:label-map') {
    result.labelSystem = field.labelSystem === 'FreeSurfer' ? 'freesurfer' : `neurodesk:${field.labelSystem}`;
  }
  return result;
}
