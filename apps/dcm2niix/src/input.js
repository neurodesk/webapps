// Input adapters preserve nested scanner paths and keep archives in memory.
// Header reading is delegated to the same DICOM reader used by DICOM View.
import { unzip } from 'fflate';
import { parseDicomHeader } from '@neurodesk/dicom2vid/readers/dicom.js';

const MAX_BYTES = 2 * 1024 ** 3;
const HEADER_BYTES = 8 * 1024 ** 2;

function safePath(name) {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((part) => part === '..')) {
    throw new Error('Archive contains an unsafe file path.');
  }
  return path;
}

function unpack(bytes, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let total = 0;
    let problem = null;
    const abort = () => {
      terminate();
      reject(signal.reason);
    };
    const terminate = unzip(bytes, {
      filter(entry) {
        try {
          const path = safePath(entry.name);
          if (path.endsWith('/') || /(^|\/)(__MACOSX|\.[^/]+)/.test(path)) return false;
          total += entry.originalSize;
          if (total > MAX_BYTES) throw new Error('Expanded input exceeds the 2 GiB browser limit.');
          return true;
        } catch (error) {
          problem = error;
          return false;
        }
      },
    }, (error, files) => {
      signal?.removeEventListener('abort', abort);
      if (problem || error) reject(problem || error);
      else resolve(files);
    });
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function expandInputs(inputs, { signal, onProgress = () => {} } = {}) {
  const files = [];
  let total = 0;
  const append = (file, path) => {
    total += file.size;
    if (total > MAX_BYTES) throw new Error('Input exceeds the 2 GiB browser limit. Use a smaller examination.');
    // Do not stamp the user's File itself: retrying must not repeatedly prepend
    // our staging directory to the original scanner path.
    const staged = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
    Object.defineProperty(staged, '_webkitRelativePath', { value: safePath(path) });
    files.push(staged);
  };
  for (const [index, file] of Array.from(inputs).entries()) {
    signal?.throwIfAborted();
    if (/\.zip$/i.test(file.name)) {
      const archive = await unpack(new Uint8Array(await file.arrayBuffer()), signal);
      for (const [path, data] of Object.entries(archive)) {
        append(new File([data], path.split('/').at(-1)), `input${index}/${path}`);
      }
    } else {
      append(file, `input${index}/${file.webkitRelativePath || file._webkitRelativePath || file.name}`);
    }
    onProgress((index + 1) / inputs.length);
  }
  signal?.throwIfAborted();
  if (!files.length) throw new Error('Choose nonempty DICOM files, a folder or a ZIP archive.');
  return files;
}

function text(map, tag) {
  const element = map.get(tag);
  if (element?.str !== undefined) return element.str.trim();
  if (element?.bytes) return new TextDecoder().decode(element.bytes).replaceAll('\0', '').trim();
  return '';
}

/** Reject mixed examinations before feeding their image files to dcm2niix. */
export async function examinationFiles(files, { signal } = {}) {
  const studies = new Set();
  const patients = new Set();
  const images = [];
  let skipped = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const prefix = await file.slice(0, HEADER_BYTES).arrayBuffer();
    signal?.throwIfAborted();
    const bytes = new Uint8Array(prefix);
    const preamble = bytes.length >= 132 && new TextDecoder().decode(bytes.subarray(128, 132)) === 'DICM';
    const group = bytes.length >= 2 ? bytes[0] | bytes[1] << 8 : 0;
    if (!preamble && group !== 2 && group !== 8 && !/\.(dcm|ima)$/i.test(file.name)) {
      skipped++;
      continue;
    }
    const { map, complete } = await parseDicomHeader(prefix);
    if (!map.has(0x00280010) || !map.has(0x00280011)) {
      if (!complete && file.size > HEADER_BYTES) throw new Error('A DICOM header exceeds the supported 8 MiB prefix.');
      skipped++;
      continue;
    }
    const modality = text(map, 0x00080060);
    if (modality && modality !== 'MR') throw new Error('This converter accepts MRI examinations only.');
    const study = text(map, 0x0020000d);
    const patient = text(map, 0x00100020);
    if (!study) throw new Error('A DICOM image is missing its StudyInstanceUID.');
    studies.add(study);
    if (patient) patients.add(patient);
    if (studies.size > 1 || patients.size > 1) throw new Error('Choose one patient and one examination per import.');
    images.push(file);
  }
  if (!images.length) throw new Error('No MRI DICOM images found in the selected input.');
  return { files: images, skipped };
}
