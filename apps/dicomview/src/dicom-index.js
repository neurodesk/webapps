// From a folder of files to the DICOM series it holds. Each file is read only as far as
// a header prefix; nothing here touches pixels or the DOM, so it runs under Node too.
//
// FileRecord = { file, path, instanceNumber, fields, values, complete, headerBytes }
//   fields: the summary attributes, values: Map<tag, comparable text> of the top-level
//   elements, complete: false when the prefix ended before the pixel data, headerBytes:
//   the file offset of the pixel data when the prefix reached it, else null.
// Series = { uid, studyUid, number, description, protocolName, modality, imageType, rows,
//   cols, kind, files, summary, varyingTags }
// DicomIndex = { series, skipped: [{ path, reason }] }
import { parseDicomHeader } from '@neurodesk/dicom2vid/readers/dicom.js';
import { classifySeries } from '@neurodesk/dicom2vid/series.js';

export const PREFIX_BYTES = 131072;
export const MAX_PREFIX_BYTES = 8 * 1024 * 1024;
const BATCH = 32;

const TAG = {
  ImageType: 0x00080008,
  Modality: 0x00080060,
  SeriesDescription: 0x0008103e,
  SliceThickness: 0x00180050,
  RepetitionTime: 0x00180080,
  EchoTime: 0x00180081,
  InversionTime: 0x00180082,
  MRAcquisitionType: 0x00180023,
  ProtocolName: 0x00181030,
  FlipAngle: 0x00181314,
  StudyInstanceUID: 0x0020000d,
  SeriesInstanceUID: 0x0020000e,
  SeriesNumber: 0x00200011,
  InstanceNumber: 0x00200013,
  NumberOfImagesInMosaic: 0x0019100a,
  SamplesPerPixel: 0x00280002,
  NumberOfFrames: 0x00280008,
  Rows: 0x00280010,
  Columns: 0x00280011,
  PixelSpacing: 0x00280030,
};

// Attributes every instance of a series is expected to differ in; leaving them out keeps
// "varies across the series" about acquisition parameters.
const PER_INSTANCE = new Set([0x00020003, 0x00080018, 0x00200013]);

// An Implicit VR file leaves the reader's unknown string elements (Modality, ProtocolName)
// as bytes; every summary attribute read as bytes is a string.
function text(map, tag) {
  const element = map.get(tag);
  if (!element) return '';
  if (element.bytes) return String.fromCharCode(...element.bytes.subarray(0, 256)).replace(/[\0 ]+$/, '').trim();
  if (element.str !== undefined) return element.str.trim();
  return element.numbers?.join('\\') ?? '';
}

function number(map, tag) {
  const value = Number.parseFloat(text(map, tag));
  return Number.isFinite(value) ? value : null;
}

// FNV-1a: two values compare equal when their bytes do, without keeping the bytes.
function hash(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16);
}

function comparable(element) {
  if (element.items) return `[${element.items.map(datasetKey).join('|')}]`;
  if (element.bytes) return `${element.bytes.length}:${hash(element.bytes)}`;
  if (element.numbers) return element.numbers.join('\\');
  return element.str ?? '';
}

function datasetKey(map) {
  return [...map].map(([tag, element]) => `${tag}=${comparable(element)}`).join(',');
}

// A file without the preamble must open on a file meta (0002) or identifying (0008)
// element, as pydicom also requires; anything else is rejected before it is parsed.
function looksLikeDicom(bytes, name) {
  if (/\.(dcm|ima)$/i.test(name)) return true;
  if (bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d) return true;
  const group = bytes[0] | (bytes[1] << 8);
  return bytes.length >= 8 && (group === 0x0002 || group === 0x0008);
}

const isUid = (value) => /^\d+(\.\d+)*$/.test(value);
const isSize = (value) => Number.isInteger(value) && value > 0;

// The record in this prefix of the file, or null when its series and size tags may lie
// past the end of the prefix.
export async function readRecord(file, path, buffer) {
  const bytes = new Uint8Array(buffer);
  if (!looksLikeDicom(bytes, file.name)) throw new Error('not a DICOM file');
  const { map, complete, headerBytes } = await parseDicomHeader(buffer);
  const found = map.has(TAG.Rows) && map.has(TAG.Columns) && map.has(TAG.SeriesInstanceUID);
  if (!found && !complete && bytes.length < file.size) return null;
  if (!found || !isUid(text(map, TAG.SeriesInstanceUID)) || !isSize(number(map, TAG.Rows)) || !isSize(number(map, TAG.Columns))) {
    throw new Error('no image in this DICOM file');
  }
  const values = new Map();
  for (const [tag, element] of map) {
    if (!PER_INSTANCE.has(tag)) values.set(tag, comparable(element));
  }
  return {
    file,
    path,
    instanceNumber: number(map, TAG.InstanceNumber),
    complete: complete || bytes.length >= file.size,
    headerBytes,
    values,
    fields: {
      seriesUid: text(map, TAG.SeriesInstanceUID),
      studyUid: text(map, TAG.StudyInstanceUID),
      seriesNumber: number(map, TAG.SeriesNumber),
      description: text(map, TAG.SeriesDescription),
      protocolName: text(map, TAG.ProtocolName),
      modality: text(map, TAG.Modality),
      imageType: text(map, TAG.ImageType),
      mrAcquisitionType: text(map, TAG.MRAcquisitionType),
      rows: number(map, TAG.Rows),
      cols: number(map, TAG.Columns),
      frames: number(map, TAG.NumberOfFrames) ?? 1,
      mosaicSlices: number(map, TAG.NumberOfImagesInMosaic) ?? 0,
      samplesPerPixel: number(map, TAG.SamplesPerPixel) ?? 1,
      repetitionTime: number(map, TAG.RepetitionTime),
      echoTime: number(map, TAG.EchoTime),
      inversionTime: number(map, TAG.InversionTime),
      flipAngle: number(map, TAG.FlipAngle),
      sliceThickness: number(map, TAG.SliceThickness),
      pixelSpacing: text(map, TAG.PixelSpacing),
    },
  };
}

// Distinct values in file order: one value, or the range and how many there are.
function distinct(values) {
  const unique = [...new Set(values.filter(value => value !== null && value !== ''))];
  if (unique.length < 2) return unique[0] ?? null;
  if (unique.every(value => typeof value === 'number')) {
    return `${Math.min(...unique)}–${Math.max(...unique)} (${unique.length} values)`;
  }
  return `${unique.length} values`;
}

// Tags whose value differs between instances. A tag past the point where some prefix
// was cut is left out: its absence there says nothing about the file.
function varyingTags(records) {
  const cuts = records.filter(record => !record.complete).map(record => Math.max(...record.values.keys()));
  const frontier = cuts.length ? Math.min(...cuts) : Infinity;
  const tags = new Set(records.flatMap(record => [...record.values.keys()]));
  const varying = new Set();
  for (const tag of tags) {
    if (tag >= frontier) continue;
    const first = records[0].values.get(tag);
    if (records.some(record => record.values.get(tag) !== first)) varying.add(tag);
  }
  return varying;
}

function byInstance(a, b) {
  return (a.instanceNumber ?? Infinity) - (b.instanceNumber ?? Infinity) || a.path.localeCompare(b.path);
}

function toSeries(uid, records) {
  const files = [...records].sort(byInstance);
  const first = files[0].fields;
  const summary = {
    repetitionTime: distinct(files.map(record => record.fields.repetitionTime)),
    echoTime: distinct(files.map(record => record.fields.echoTime)),
    inversionTime: distinct(files.map(record => record.fields.inversionTime)),
    flipAngle: distinct(files.map(record => record.fields.flipAngle)),
    sliceThickness: distinct(files.map(record => record.fields.sliceThickness)),
    pixelSpacing: distinct(files.map(record => record.fields.pixelSpacing)),
  };
  const mosaic = first.mosaicSlices > 1;
  const { label } = classifySeries({
    seriesDescription: first.description,
    isColor: first.samplesPerPixel === 3,
    isMosaic: mosaic,
    sliceCount: mosaic ? first.mosaicSlices : files.reduce((sum, record) => sum + record.fields.frames, 0),
    physics: {
      repetitionTime: first.repetitionTime,
      echoTime: first.echoTime,
      inversionTime: first.inversionTime,
      mrAcquisitionType: first.mrAcquisitionType,
    },
  });
  return {
    uid,
    studyUid: first.studyUid,
    number: first.seriesNumber,
    description: first.description,
    protocolName: first.protocolName,
    modality: first.modality,
    imageType: first.imageType,
    rows: first.rows,
    cols: first.cols,
    kind: label,
    files,
    summary,
    varyingTags: varyingTags(files),
  };
}

function bySeries(a, b) {
  return a.studyUid.localeCompare(b.studyUid)
    || (a.number ?? Infinity) - (b.number ?? Infinity)
    || a.description.localeCompare(b.description)
    || a.uid.localeCompare(b.uid);
}

export function indexDicom(records, skipped = []) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.fields.seriesUid) ?? [];
    group.push(record);
    groups.set(record.fields.seriesUid, group);
  }
  const series = [...groups].map(([uid, group]) => toSeries(uid, group)).sort(bySeries);
  return { series, skipped };
}

function relativePath(file) {
  return file.webkitRelativePath || file._webkitRelativePath || file.name;
}

const nextTask = () => new Promise(resolve => setTimeout(resolve));

// Reads a longer prefix, doubling, until the record's tags are in it; vendors' private
// headers can put them past the first prefix.
async function readFileRecord(file) {
  const path = relativePath(file);
  for (let size = PREFIX_BYTES; size <= MAX_PREFIX_BYTES; size *= 2) {
    const record = await readRecord(file, path, await file.slice(0, size).arrayBuffer());
    if (record) return record;
  }
  throw new Error(`no image tags in the first ${MAX_PREFIX_BYTES / 1024 / 1024} MB`);
}

// The file up to its pixel data, which is all dicompare reads: it parses with pydicom's
// stop_before_pixels. The whole file when the pixel data lies past the read cap or the
// dataset is deflated.
export async function headerBuffer(record) {
  const { file } = record;
  let end = record.headerBytes;
  for (let size = PREFIX_BYTES * 2; end === null && size < file.size && size <= MAX_PREFIX_BYTES; size *= 2) {
    end = (await parseDicomHeader(await file.slice(0, size).arrayBuffer())).headerBytes;
  }
  return file.slice(0, end ?? file.size).arrayBuffer();
}

// Reads the header of every file in batches, yielding between them so thousands of
// files never freeze the page. onProgress(done, total) follows each batch.
export async function indexFiles(files, { signal, onProgress = () => {} } = {}) {
  const records = [];
  const skipped = [];
  for (let start = 0; start < files.length; start += BATCH) {
    signal?.throwIfAborted();
    const batch = files.slice(start, start + BATCH);
    const reads = await Promise.allSettled(batch.map(readFileRecord));
    batch.forEach((file, i) => {
      if (reads[i].status === 'fulfilled') records.push(reads[i].value);
      else skipped.push({ path: relativePath(file), reason: reads[i].reason.message });
    });
    onProgress(Math.min(start + BATCH, files.length), files.length);
    await nextTask();
  }
  signal?.throwIfAborted();
  return indexDicom(records, skipped);
}
