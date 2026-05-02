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

export function categorizeNeuroFile(file) {
  const name = getName(file).toLowerCase();
  if (isJsonFile(name)) return 'json';
  if (!isNiftiFile(name)) return isDicomFile(name) ? 'dicom' : 'extra';
  if (/phase|_ph[\._-]/.test(name)) return 'phase';
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
