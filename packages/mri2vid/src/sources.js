// From a set of files to the volumes they hold: DICOM files are grouped into series,
// NIfTI and MGZ files are one volume each. The web app and the command line both pick
// their input through this module; each supplies how a file's bytes are read.

import {
  detectKind, sniffDicom, readDicomHeader, readDicomSeries, readNifti, readMgz,
} from './readers/index.js';
import { groupSeries } from './series.js';

// Header bytes read to group a DICOM file without loading its pixels.
const DICOM_HEADER_BYTES = 262144;

// records: [{ name, ... }] in any shape the callbacks understand.
// readPrefix(record, bytes) resolves to the first `bytes` bytes as an ArrayBuffer.
// onSkip(record, error) hears about each DICOM file that could not be grouped.
// Returns { sources, unreadable }; each source has { id, kind, label, recs } and, for a
// DICOM series, its UID, classification and slice counts, and isDefault on the likeliest
// structural scan.
export async function discoverSources(records, { readPrefix, onSkip = () => {}, signal } = {}) {
  const dicomRecords = [];
  const volumeRecords = [];
  let unreadable = 0;
  for (const rec of records) {
    signal?.throwIfAborted();
    const kind = detectKind(rec.name);
    if (kind === 'dicom') dicomRecords.push(rec);
    else if (kind === 'nifti' || kind === 'mgz') volumeRecords.push({ rec, kind });
    else {
      try {
        const prefix = await readPrefix(rec, 200);
        if (sniffDicom(new Uint8Array(prefix))) dicomRecords.push(rec);
      } catch (_) { unreadable++; }
    }
  }

  const sources = [];
  if (dicomRecords.length) {
    const headers = [];
    const byRecord = new Map();
    for (const rec of dicomRecords) {
      try {
        const h = readDicomHeader(await readPrefix(rec, DICOM_HEADER_BYTES), rec.name);
        if (!h.rows || !h.cols) continue; // skip DICOMDIR / non-image DICOM
        const id = String(headers.length);
        headers.push({ ...h, name: id });
        byRecord.set(id, rec);
      } catch (e) {
        unreadable++;
        onSkip(rec, e);
      }
    }
    if (headers.length) {
      const { series, defaultIndex } = groupSeries(headers);
      series.forEach((s, i) => {
        sources.push({
          id: `dicom-${i}`,
          seriesUid: s.seriesInstanceUID,
          kind: 'dicom-series',
          label: s.seriesDescription || `Series ${s.seriesNumber ?? i + 1}`,
          classification: s.classification,
          sliceCount: s.sliceCount,
          isColor: s.isColor,
          isMosaic: s.isMosaic,
          mosaicSlices: s.mosaicSlices,
          volumes: s.volumes,
          recs: s.files.map((id) => byRecord.get(id)),
          isDefault: i === defaultIndex,
        });
      });
    }
  }
  volumeRecords.forEach(({ rec, kind }, i) => {
    sources.push({ id: `vol-${i}`, kind, label: rec.name, recs: [rec] });
  });
  return { sources, unreadable };
}

// Reads a source into a volume. readBytes(record) resolves to the whole file as an ArrayBuffer;
// convertDicom runs dcm2niix (see readDicomSeries).
export async function loadSource(source, { readBytes, convertDicom, mosaicReduce = 'first' }) {
  if (source.kind === 'dicom-series') {
    const files = [];
    for (const rec of source.recs) files.push({ name: rec.name, buffer: await readBytes(rec) });
    return readDicomSeries(files, { convertDicom, mosaicReduce });
  }
  if (source.kind === 'nifti') return readNifti(await readBytes(source.recs[0]), source.label);
  if (source.kind === 'mgz') return readMgz(await readBytes(source.recs[0]), source.label);
  throw new Error(`Unknown source kind: ${source.kind}`);
}

// The download's base name: the source label without its image extension.
export function outputBaseName(label) {
  return String(label).replace(/\.(dcm|ima|nii\.gz|nii|mgz|mgh)$/i, '').replace(/[^\w.-]+/g, '_') || 'video';
}

export function outputFileName(label, orientation, container) {
  return `${outputBaseName(label)}_${orientation}.${container}`;
}
