export function isNiftiFile(fileOrName) {
  const name = getName(fileOrName).toLowerCase();
  return name.endsWith('.nii') || name.endsWith('.nii.gz');
}

export function isJsonFile(fileOrName) {
  return getName(fileOrName).toLowerCase().endsWith('.json');
}

export function isDicomFile(fileOrName) {
  const name = getName(fileOrName).toLowerCase();
  if (name.endsWith('.dcm') || name.endsWith('.dicom') || name.endsWith('.ima')) return true;
  return !isNiftiFile(name) && !isJsonFile(name) && !name.includes('.');
}

export function detectFileKind(fileOrName) {
  if (isNiftiFile(fileOrName)) return 'nifti';
  if (isJsonFile(fileOrName)) return 'json';
  if (isDicomFile(fileOrName)) return 'dicom';
  return 'unknown';
}

/**
 * Classify an MR image as 'magnitude', 'phase' or 'extra' from its JSON sidecar
 * (ImageType, ComplexImageComponent), then from unambiguous name conventions (BIDS part-,
 * dcm2niix _ph and _e<n> suffixes). Returns null when nothing reliable is known.
 */
export function classifyImageComponent(fileOrName, metadata) {
  const types = Array.isArray(metadata?.ImageType)
    ? metadata.ImageType.map(type => String(type).toUpperCase())
    : [];
  const component = String(metadata?.ComplexImageComponent || '').toUpperCase();
  if (types.some(type => ['LOCALIZER', 'SWI', 'REAL', 'IMAGINARY', 'R', 'I'].includes(type))) return 'extra';
  if (['REAL', 'IMAGINARY'].includes(component)) return 'extra';
  if (types.some(type => type === 'P' || type === 'PHASE') || component === 'PHASE') return 'phase';
  if (types.some(type => type === 'M' || type === 'MAGNITUDE') || component === 'MAGNITUDE') return 'magnitude';

  // Match output suffixes, never "phaseimage" embedded in a protocol name.
  const base = getName(fileOrName).replace(/^.*\//, '').replace(/\.nii(\.gz)?$/i, '');
  // The BIDS part- entity is unambiguous, even when the sidecar omits a component.
  const part = base.match(/(?:^|_)part-(mag|phase|real|imag)(?:_|$)/i);
  if (part) {
    const value = part[1].toLowerCase();
    if (value === 'mag') return 'magnitude';
    if (value === 'phase') return 'phase';
    return 'extra';
  }
  if (/_ph(?:_[a-z0-9]+)?$/i.test(base)) return 'phase';
  // Bruker enhanced multi-echo magnitude omits MAGNITUDE in dcm2niix's sidecar.
  const bruker = String(metadata?.Manufacturer || '').toLowerCase() === 'bruker';
  if (bruker && ['ORIGINAL', 'MULTIECHO', 'NONE'].every(type => types.includes(type))) return 'magnitude';
  if (types.length) return 'extra';
  // A dcm2niix echo suffix marks magnitude only when no phase token names the file otherwise.
  if (/(^|[_\-.])phase([_\-.]|$)/i.test(base)) return 'phase';
  if (/_e\d+$/i.test(base)) return 'magnitude';
  return null;
}

export function categorizeNeuroFile(file, metadata) {
  const name = getName(file).toLowerCase();
  if (isJsonFile(name)) return 'json';
  if (!isNiftiFile(name)) return isDicomFile(name) ? 'dicom' : 'extra';
  const component = classifyImageComponent(name, metadata);
  if (component) return component;
  if (/(^|[_\-.])phase([_\-.]|$)|_ph[._-]/.test(name)) return 'phase';
  if (/total|b0|fieldmap|field_map/.test(name)) return 'totalField';
  if (/local|chi/.test(name)) return 'localField';
  if (/mag|magnitude/.test(name)) return 'magnitude';
  if (/mask|seg/.test(name)) return 'mask';
  return 'extra';
}

export async function filesFromDataTransferItems(items) {
  if (!items) return [];
  const entries = [];
  const directFiles = [];
  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile?.();
      if (file) directFiles.push(file);
    }
  }
  const files = [...directFiles];
  for (const entry of entries) await traverseEntry(entry, '', files);
  return files;
}

function getName(fileOrName) {
  return typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '';
}

function traverseEntry(entry, path, files) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(file => {
        file._webkitRelativePath = path + file.name;
        files.push(file);
        resolve();
      });
      return;
    }
    if (!entry.isDirectory) {
      resolve();
      return;
    }
    const reader = entry.createReader();
    const readBatch = () => {
      reader.readEntries(async entries => {
        if (!entries.length) {
          resolve();
          return;
        }
        await Promise.all(entries.map(child => traverseEntry(child, `${path}${entry.name}/`, files)));
        readBatch();
      });
    };
    readBatch();
  });
}
