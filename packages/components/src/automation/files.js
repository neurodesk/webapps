import { decodeNiftiBuffer, parseNiftiHeader, isValidNifti1 } from '../file-io/NiftiUtils.js';
import { sha256 } from '../file-io/hash.js';
export { sha256 } from '../file-io/hash.js';

export async function describeFile(file, signal) {
  signal?.throwIfAborted();
  return { filename: file.name, bytes: file.size, sha256: await sha256(await file.arrayBuffer(), signal) };
}

const imageTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map']);
export const convertsDicom = input => imageTypes.has(input.type) && input.formats.includes('dicom');
const isNifti = file => /\.nii(?:\.gz)?$/i.test(file.name);
const stem = name => name.replace(/\.nii(?:\.gz)?$|\.(?:json|bval|bvec)$/i, '');

async function candidate(file, sidecars, signal) {
  const bytes = await decodeNiftiBuffer(await file.arrayBuffer());
  signal?.throwIfAborted();
  if (!isValidNifti1(bytes)) throw new Error(`DICOM conversion produced an invalid NIfTI: ${file.name}`);
  const header = parseNiftiHeader(bytes);
  const metadata = {};
  for (const sidecar of sidecars.filter(file => /\.json$/i.test(file.name))) {
    const value = JSON.parse(await sidecar.text());
    for (const key of ['Modality', 'SeriesNumber', 'ImageType', 'EchoNumber', 'EchoTime', 'RepetitionTime', 'MagneticFieldStrength']) {
      if (Object.hasOwn(value, key)) metadata[key] = value[key];
    }
  }
  return { filename: file.name, sha256: await sha256(bytes, signal), dimensions: header.dims.slice(1, header.dims[0] + 1), metadata };
}

export async function prepareImageInput(files, input, { selection, convertDicom, signal } = {}) {
  const direct = files.filter(isNifti);
  const dicom = files.filter(file => !isNifti(file) && !/\.(?:json|bval|bvec)$/i.test(file.name));
  const staged = dicom.map((file, index) => new File([file], `${index + 1}-${file.name}`, { type: file.type, lastModified: file.lastModified }));
  const converted = staged.length ? await convertDicom(staged, { signal, niftiOnly: false }) : [];
  signal?.throwIfAborted();
  const images = [...direct, ...converted.filter(isNifti)];
  if (!images.length) throw new Error('No images produced. Choose NIfTI files or a complete DICOM series.');
  const auxiliary = [...files, ...converted].filter(file => /\.(?:json|bval|bvec)$/i.test(file.name));
  const details = [];
  for (const file of images) {
    const sidecars = auxiliary.filter(sidecar => stem(sidecar.name) === stem(file.name));
    details.push({ file, sidecars, descriptor: await candidate(file, sidecars, signal) });
  }
  let selected = details;
  if (selection !== undefined) {
    selected = details.filter(entry => entry.descriptor.sha256 === selection);
    if (selected.length !== 1) throw Object.assign(new Error('The selected series is absent or ambiguous; inspect the current input again.'), {
      code: 'INVALID_SERIES_SELECTION', candidates: details.map(entry => entry.descriptor),
    });
  } else if (input.maximum === 1 && details.length !== 1) {
    throw Object.assign(new Error('Select one converted image by its content checksum.'), {
      code: 'SERIES_SELECTION_REQUIRED', candidates: details.map(entry => entry.descriptor),
    });
  }
  if (selected.length < (input.minimum ?? 1) || selected.length > (input.maximum ?? Infinity)) {
    throw new Error(`Input image cardinality mismatch: received ${selected.length}`);
  }
  return {
    files: selected.map(entry => entry.file),
    details: {
      sidecars: selected.flatMap(entry => entry.sidecars),
      conversion: { converter: dicom.length ? 'dcm2niix' : null, candidates: details.map(entry => entry.descriptor), selected: selected.map(entry => entry.descriptor.sha256) },
    },
  };
}
