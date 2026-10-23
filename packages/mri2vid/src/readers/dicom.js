// DICOM header parsing for the video pipeline, and the series reader.
//
// Headers are read here for series grouping: any little-endian transfer syntax, since a
// header is never compressed. Pixels come from dcm2niix, which decodes compressed and
// vendor-specific DICOM (Siemens mosaics included). readDicomFrames still decodes
// uncompressed pixels itself for DICOM View's frames that share no plane.
//
// readDicomSeries lays the volume out as MRI2vid.py reads a series: [rows, cols, slices],
// slices in ascending order along the slice normal.

import { makeVolume } from '../volume.js';
import { VOLUME_REDUCTIONS, readNifti, volumeNote } from './nifti.js';

// ---- transfer syntaxes ----
const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';
const TS_DEFLATED_LE = '1.2.840.10008.1.2.1.99';

// ---- tags (group * 0x10000 + element) ----
const T = {
  TransferSyntaxUID: 0x00020010,
  SOPClassUID: 0x00080016,
  ImageType: 0x00080008,
  SeriesDescription: 0x0008103e,
  SliceThickness: 0x00180050,
  RepetitionTime: 0x00180080,
  EchoTime: 0x00180081,
  InversionTime: 0x00180082,
  MRAcquisitionType: 0x00180023,
  FlipAngle: 0x00181314,
  StudyInstanceUID: 0x0020000d,
  SeriesInstanceUID: 0x0020000e,
  SeriesNumber: 0x00200011,
  InstanceNumber: 0x00200013,
  ImagePositionPatient: 0x00200032,
  ImageOrientationPatient: 0x00200037,
  FrameContentSequence: 0x00209111,
  PlanePositionSequence: 0x00209113,
  PlaneOrientationSequence: 0x00209116,
  PixelMeasuresSequence: 0x00289110,
  // Siemens private: how many real slices are tiled into one mosaic frame.
  NumberOfImagesInMosaic: 0x0019100a,
  SamplesPerPixel: 0x00280002,
  PhotometricInterpretation: 0x00280004,
  PlanarConfiguration: 0x00280006,
  NumberOfFrames: 0x00280008,
  PixelSpacing: 0x00280030,
  Rows: 0x00280010,
  Columns: 0x00280011,
  BitsAllocated: 0x00280100,
  BitsStored: 0x00280101,
  HighBit: 0x00280102,
  PixelRepresentation: 0x00280103,
  RescaleIntercept: 0x00281052,
  RescaleSlope: 0x00281053,
  PixelValueTransformationSequence: 0x00289145,
  SharedFunctionalGroupsSequence: 0x52009229,
  PerFrameFunctionalGroupsSequence: 0x52009230,
  FloatPixelData: 0x7fe00008,
  DoubleFloatPixelData: 0x7fe00009,
  PixelData: 0x7fe00010,
  ItemStart: 0xfffee000,
  ItemEnd: 0xfffee00d,
  SeqEnd: 0xfffee0dd,
};

// The header ends at whichever pixel data element the image has, as for pydicom's
// stop_before_pixels.
const PIXEL_TAGS = new Set([T.FloatPixelData, T.DoubleFloatPixelData, T.PixelData]);

// VRs that carry a 2-byte reserved field then a 4-byte length in Explicit VR.
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR', 'SV', 'UV']);
const NUM_VR = new Set(['US', 'SS', 'UL', 'SL', 'FL', 'FD', 'AT']);
// Binary values kept as bytes: pixel-like data, unknown elements and 64-bit integers.
const BYTES_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN', 'SV', 'UV']);

// Minimal VR dictionary used only for Implicit VR decoding.
const IMPLICIT_VR = new Map([
  [T.TransferSyntaxUID, 'UI'], [T.SOPClassUID, 'UI'], [T.SeriesDescription, 'LO'],
  [T.ImageType, 'CS'], [T.SliceThickness, 'DS'], [T.PixelSpacing, 'DS'],
  [T.NumberOfImagesInMosaic, 'US'],
  [T.RepetitionTime, 'DS'], [T.EchoTime, 'DS'], [T.InversionTime, 'DS'],
  [T.MRAcquisitionType, 'CS'], [T.FlipAngle, 'DS'],
  [T.StudyInstanceUID, 'UI'], [T.SeriesInstanceUID, 'UI'],
  [T.SeriesNumber, 'IS'], [T.InstanceNumber, 'IS'],
  [T.ImagePositionPatient, 'DS'], [T.ImageOrientationPatient, 'DS'],
  [T.FrameContentSequence, 'SQ'], [T.PlanePositionSequence, 'SQ'],
  [T.PlaneOrientationSequence, 'SQ'], [T.PixelValueTransformationSequence, 'SQ'],
  [T.PixelMeasuresSequence, 'SQ'],
  [T.SharedFunctionalGroupsSequence, 'SQ'], [T.PerFrameFunctionalGroupsSequence, 'SQ'],
  [T.SamplesPerPixel, 'US'], [T.PhotometricInterpretation, 'CS'],
  [T.PlanarConfiguration, 'US'], [T.NumberOfFrames, 'IS'],
  [T.Rows, 'US'], [T.Columns, 'US'], [T.BitsAllocated, 'US'],
  [T.BitsStored, 'US'], [T.HighBit, 'US'], [T.PixelRepresentation, 'US'],
  [T.RescaleIntercept, 'DS'], [T.RescaleSlope, 'DS'], [T.PixelData, 'OW'],
]);

function decodeString(bytes) {
  // Trim trailing NUL/space padding with a linear scan on the raw bytes. An
  // anchored greedy regex (/[\x00 ]+$/) is O(n^2) in V8, so a crafted value of
  // many padding bytes followed by a non-pad byte can hang the tab (ReDoS). Also
  // cap the length far above any DICOM string VR we actually read.
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) end--;
  if (end > 65536) end = 65536;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function decodeNumbers(vr, view, off, len, littleEndian) {
  const out = [];
  if (vr === 'US') { for (let i = 0; i + 2 <= len; i += 2) out.push(view.getUint16(off + i, littleEndian)); }
  else if (vr === 'SS') { for (let i = 0; i + 2 <= len; i += 2) out.push(view.getInt16(off + i, littleEndian)); }
  else if (vr === 'UL') { for (let i = 0; i + 4 <= len; i += 4) out.push(view.getUint32(off + i, littleEndian)); }
  else if (vr === 'SL') { for (let i = 0; i + 4 <= len; i += 4) out.push(view.getInt32(off + i, littleEndian)); }
  else if (vr === 'FL') { for (let i = 0; i + 4 <= len; i += 4) out.push(view.getFloat32(off + i, littleEndian)); }
  else if (vr === 'FD') { for (let i = 0; i + 8 <= len; i += 8) out.push(view.getFloat64(off + i, littleEndian)); }
  else if (vr === 'AT') { for (let i = 0; i + 4 <= len; i += 4) out.push((view.getUint16(off + i, littleEndian) * 0x10000 + view.getUint16(off + i + 2, littleEndian)) >>> 0); }
  return out;
}

// Parse a dataset (a run of elements) into a Map keyed by numeric tag.
// Returns { map, next, stop }. `end` is an absolute byte offset limit. `ctx` carries the
// buffer and encoding ({ view, bytes, implicitVR, littleEndian }), plus:
//   stopGroupAbove: stop at the first tag of a higher group. DICOM elements are stored in
//     ascending tag order, so this is a safe header-only fast path.
//   header: stop before the top-level pixel data and skip, rather than reject, encapsulated
//     pixel data in nested items (an icon image); `stop` then reports why parsing ended.
//   vrOf(tag): the VR of an Implicit VR element this reader does not know.
function parseDataset(ctx, start, end, { stopGroupAbove = null, topLevel = false } = {}) {
  const { view, bytes, implicitVR, littleEndian } = ctx;
  const map = new Map();
  let off = start;
  while (off + 8 <= end) {
    const group = view.getUint16(off, littleEndian);
    const element = view.getUint16(off + 2, littleEndian);
    const tag = (group * 0x10000 + element) >>> 0;
    if (stopGroupAbove !== null && group !== 0xfffe && group > stopGroupAbove) {
      return { map, next: off, stop: 'group' };
    }
    if (ctx.header && topLevel && PIXEL_TAGS.has(tag)) {
      return { map, next: off, stop: 'pixels' };
    }
    // Item/sequence delimiters handled by the caller; stop if we hit one.
    if (group === 0xfffe) {
      return { map, next: off, stop: 'delimiter' };
    }
    const elementStart = off;
    off += 4;

    let vr;
    let length;
    if (implicitVR) {
      length = view.getUint32(off, littleEndian);
      off += 4;
      vr = IMPLICIT_VR.get(tag) || ctx.vrOf?.(tag) || (length === 0xffffffff ? 'SQ' : 'UN');
    } else {
      vr = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1));
      off += 2;
      if (LONG_VR.has(vr)) {
        if (off + 6 > end) return { map, next: elementStart, stop: 'truncated' };
        off += 2; // reserved
        length = view.getUint32(off, littleEndian);
        off += 4;
      } else {
        length = view.getUint16(off, littleEndian);
        off += 2;
      }
    }

    if (vr === 'SQ') {
      const seqEnd = length === 0xffffffff ? end : Math.min(off + length, end);
      const { items, next, truncated } = parseSequence(ctx, off, seqEnd, length === 0xffffffff);
      map.set(tag, { vr, items });
      // A header prefix can end inside a sequence; what follows the cut is not an element.
      if ((truncated || (length !== 0xffffffff && off + length > end)) && ctx.header) return { map, next, stop: 'truncated' };
      off = next;
      continue;
    }

    if (length === 0xffffffff) {
      // Undefined length on a non-SQ element: encapsulated (compressed) pixel data
      // or an undefined-length item. We do not support compressed pixels.
      if (tag === T.PixelData) {
        map.set(tag, { vr, encapsulated: true });
        if (!ctx.header) throw new DicomError('This DICOM uses a compressed transfer syntax (encapsulated pixel data). Decode it to uncompressed DICOM/NIfTI locally first.');
      }
      // Skip to sequence delimiter.
      off = skipUndefinedLength(view, off, end, littleEndian);
      continue;
    }

    const valEnd = off + length;
    if (valEnd > end) {
      // Truncated element; stop parsing gracefully.
      return { map, next: off, stop: 'truncated' };
    }

    if (tag === T.PixelData) {
      map.set(tag, { vr, pixelOffset: off, pixelLength: length });
    } else if (NUM_VR.has(vr)) {
      map.set(tag, { vr, numbers: decodeNumbers(vr, view, off, length, littleEndian) });
    } else if (BYTES_VR.has(vr)) {
      map.set(tag, { vr, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset + off, length) });
    } else {
      const str = decodeString(new Uint8Array(bytes.buffer, bytes.byteOffset + off, length));
      map.set(tag, { vr, str });
    }
    off = valEnd;
  }
  return { map, next: off, stop: off >= end ? 'end' : 'truncated' };
}

function parseSequence(ctx, start, end, undefinedLength) {
  const { view, littleEndian } = ctx;
  const items = [];
  let off = start;
  while (off + 8 <= end) {
    const group = view.getUint16(off, littleEndian);
    const element = view.getUint16(off + 2, littleEndian);
    const len = view.getUint32(off + 4, littleEndian);
    off += 8;
    const tag = (group * 0x10000 + element) >>> 0;
    if (tag === T.SeqEnd) {
      return { items, next: off };
    }
    if (tag !== T.ItemStart) {
      // Unexpected; bail out of this sequence.
      return { items, next: off - 8 };
    }
    const itemEnd = len === 0xffffffff ? end : Math.min(off + len, end);
    const { map, next, stop } = parseDataset(ctx, off, itemEnd);
    items.push(map);
    if (stop === 'truncated' || (len !== 0xffffffff && off + len > end)) return { items, next, truncated: true };
    if (len === 0xffffffff) {
      // next points at the item delimiter (fffe,e00d); consume it.
      off = consumeDelimiter(view, next, end, littleEndian, T.ItemEnd);
    } else {
      off = itemEnd;
    }
  }
  return { items, next: off, truncated: undefinedLength };
}

function consumeDelimiter(view, off, end, littleEndian, expectedTag) {
  if (off + 8 <= end) {
    const group = view.getUint16(off, littleEndian);
    const element = view.getUint16(off + 2, littleEndian);
    const tag = (group * 0x10000 + element) >>> 0;
    if (tag === expectedTag) return off + 8;
  }
  return off;
}

function skipUndefinedLength(view, off, end, littleEndian) {
  // Walk to the matching sequence delimiter (fffe,e0dd).
  let p = off;
  while (p + 8 <= end) {
    const group = view.getUint16(p, littleEndian);
    const element = view.getUint16(p + 2, littleEndian);
    const len = view.getUint32(p + 4, littleEndian);
    const tag = (group * 0x10000 + element) >>> 0;
    p += 8;
    if (tag === T.SeqEnd) return p;
    if (len !== 0xffffffff) p = Math.min(p + len, end);
  }
  return end;
}

export class DicomError extends Error {}

// Parse one DICOM file (ArrayBuffer) into a dataset Map plus the DataView/bytes.
// Pass { headerOnly: true } to stop after the image-pixel group (0x0028); this
// allows parsing a small prefix of a file for series grouping without decoding
// pixel data or per-frame sequences.
export function parseDicom(arrayBuffer, { headerOnly = false } = {}) {
  const { meta, dataStart, transferSyntax } = parseFileMeta(arrayBuffer);
  if (transferSyntax === TS_EXPLICIT_BE) {
    throw new DicomError('Explicit VR Big Endian is not supported. Convert to Little Endian first.');
  }
  const uncompressed = transferSyntax === TS_IMPLICIT_LE || transferSyntax === TS_EXPLICIT_LE;
  // Encapsulated syntaxes compress only the pixels; their header is Explicit VR Little Endian.
  if (!uncompressed && !(headerOnly && transferSyntax !== TS_DEFLATED_LE)) {
    throw new DicomError(`Unsupported (likely compressed) transfer syntax ${transferSyntax}. Decode to uncompressed DICOM/NIfTI locally first.`);
  }
  const implicitVR = transferSyntax === TS_IMPLICIT_LE;
  const ctx = { view: meta.view, bytes: meta.bytes, implicitVR, littleEndian: true };
  const { map } = parseDataset(ctx, dataStart, meta.bytes.length, { stopGroupAbove: headerOnly ? 0x0028 : null });
  return { map, view: meta.view, bytes: meta.bytes, transferSyntax, implicitVR };
}

// Every element before the pixel data: the file meta group and the dataset, with nested
// sequence items. Any little-endian transfer syntax is read, compressed ones included,
// because the pixels are never touched, and a deflated dataset is inflated first; a buffer
// may be just the start of a file. vrOf(tag) supplies the VR of Implicit VR elements, e.g.
// from a DICOM dictionary. complete is false when the buffer ended before the pixel data;
// headerBytes is the file offset of the pixel data, null when unknown.
export async function parseDicomHeader(arrayBuffer, { vrOf } = {}) {
  const { meta, dataStart, transferSyntax } = parseFileMeta(arrayBuffer);
  if (transferSyntax === TS_EXPLICIT_BE) {
    throw new DicomError(`Transfer syntax ${transferSyntax} is not supported.`);
  }
  const deflated = transferSyntax === TS_DEFLATED_LE;
  const bytes = deflated ? await inflateDataset(meta.bytes, dataStart) : meta.bytes;
  const view = deflated ? new DataView(bytes.buffer) : meta.view;
  const implicitVR = transferSyntax === TS_IMPLICIT_LE;
  const ctx = { view, bytes, implicitVR, littleEndian: true, vrOf, header: true };
  const { map, stop, next } = parseDataset(ctx, dataStart, bytes.length, { topLevel: true });
  const complete = stop === 'pixels';
  return { meta: meta.map, map, transferSyntax, implicitVR, complete, headerBytes: complete && !deflated ? next : null };
}

// Inflating stops here: a prefix of highly compressed pixels could expand without bound.
const INFLATED_LIMIT = 64 * 1024 * 1024;

// The file meta group, then the dataset inflated; as much as inflates when the buffer is a
// prefix that cuts the deflate stream.
async function inflateDataset(bytes, dataStart) {
  const stream = new Blob([bytes.subarray(dataStart)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [bytes.subarray(0, dataStart)];
  let size = dataStart;
  try {
    while (size < INFLATED_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
  } catch {
    // The stream ends where the prefix was cut.
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

// The preamble, the file meta group (always Explicit VR Little Endian) and the transfer
// syntax it names. A file without a preamble may still open on its file meta group;
// without either, the first element says which: an Explicit VR element has its VR, two
// capital letters, where an Implicit VR one has the low bytes of its length.
function parseFileMeta(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes.length < 132) {
    throw new DicomError('File too small to be a DICOM image');
  }
  const hasPreamble = bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
  const hasMeta = hasPreamble || view.getUint16(0, true) === 0x0002;
  if (!hasMeta) {
    const explicitVR = /^[A-Z]{2}$/.test(String.fromCharCode(bytes[4], bytes[5]));
    return { meta: { map: new Map(), view, bytes }, dataStart: 0, transferSyntax: explicitVR ? TS_EXPLICIT_LE : TS_IMPLICIT_LE };
  }
  const ctx = { view, bytes, implicitVR: false, littleEndian: true };
  const { map, next } = parseDataset(ctx, hasPreamble ? 132 : 0, bytes.length, { stopGroupAbove: 0x0002 });
  const transferSyntax = map.get(T.TransferSyntaxUID)?.str ?? TS_EXPLICIT_LE;
  return { meta: { map, view, bytes }, dataStart: next, transferSyntax };
}

// ---- accessors ----
function elNumbers(map, tag) {
  const e = map.get(tag);
  if (!e) return null;
  if (e.numbers) return e.numbers;
  if (e.str !== undefined) return e.str.split('\\').map((s) => parseFloat(s));
  return null;
}
function elNumber(map, tag, def = null) {
  const n = elNumbers(map, tag);
  return n && n.length ? n[0] : def;
}
function elString(map, tag, def = null) {
  const e = map.get(tag);
  if (!e) return def;
  if (e.str !== undefined) return e.str;
  if (e.numbers) return String(e.numbers[0]);
  return def;
}
function firstItem(map, tag) {
  const e = map.get(tag);
  if (e && e.items && e.items.length) return e.items[0];
  return null;
}

function readNumberSafe(v, def) {
  const f = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(f) ? f : def;
}

// Pull rescale/geometry/instance for a frame, using per-frame functional groups
// with a fall-back to shared groups then top-level tags (enhanced multiframe).
function frameMeta(map, perFrameItem, sharedItem, frameIndex) {
  const groups = [perFrameItem, sharedItem].filter(Boolean);

  const fromGroups = (seqTag, tag) => {
    for (const g of groups) {
      const item = firstItem(g, seqTag);
      if (item && item.has(tag)) return elNumbers(item, tag);
    }
    return null;
  };

  let ipp = fromGroups(T.PlanePositionSequence, T.ImagePositionPatient) || elNumbers(map, T.ImagePositionPatient);
  let iop = fromGroups(T.PlaneOrientationSequence, T.ImageOrientationPatient) || elNumbers(map, T.ImageOrientationPatient);
  const spacing = fromGroups(T.PixelMeasuresSequence, T.PixelSpacing) || elNumbers(map, T.PixelSpacing);
  const thickness = fromGroups(T.PixelMeasuresSequence, T.SliceThickness)?.[0] ?? elNumber(map, T.SliceThickness, null);

  let slope = 1.0;
  let intercept = 0.0;
  const pvtSlope = fromGroups(T.PixelValueTransformationSequence, T.RescaleSlope);
  const pvtInter = fromGroups(T.PixelValueTransformationSequence, T.RescaleIntercept);
  if (pvtSlope) slope = readNumberSafe(pvtSlope[0], 1.0);
  else slope = readNumberSafe(elNumber(map, T.RescaleSlope, 1.0), 1.0);
  if (pvtInter) intercept = readNumberSafe(pvtInter[0], 0.0);
  else intercept = readNumberSafe(elNumber(map, T.RescaleIntercept, 0.0), 0.0);

  let instanceNumber;
  if (groups.length) {
    // Enhanced multiframe: per-frame FrameContentSequence.InstanceNumber, else the
    // frame index (mirrors convert_to_2d's getattr(..., slice_idx)).
    instanceNumber = frameIndex;
    for (const g of groups) {
      const fc = firstItem(g, T.FrameContentSequence);
      if (fc && fc.has(T.InstanceNumber)) { instanceNumber = elNumber(fc, T.InstanceNumber, frameIndex); break; }
    }
  } else {
    // Ordinary single-frame file: the top-level InstanceNumber (0020,0013), null when absent.
    const n = elNumber(map, T.InstanceNumber, null);
    instanceNumber = n === null ? null : readNumberSafe(n, null);
  }

  return { ipp, iop, spacing, thickness, slope, intercept, instanceNumber };
}

// Decode raw pixels of one frame into a typed array of length rows*cols*spp.
function decodeFramePixels(ctx, rows, cols, spp, bitsAllocated, pixelRep, planar, frameIndex) {
  const { view, bytes, map } = ctx;
  const pd = map.get(T.PixelData);
  if (!pd || pd.pixelOffset === undefined) throw new DicomError('Missing pixel data');
  const nPix = rows * cols;
  const perFrame = nPix * spp;
  const bytesPerSample = bitsAllocated === 8 ? 1 : 2;
  const frameBytes = perFrame * bytesPerSample;
  const base = pd.pixelOffset + frameIndex * frameBytes;
  if (base + frameBytes > pd.pixelOffset + pd.pixelLength) {
    throw new DicomError('Pixel data shorter than declared frame geometry');
  }

  if (spp === 1) {
    const out = bitsAllocated === 8
      ? (pixelRep ? new Int8Array(nPix) : new Uint8Array(nPix))
      : (pixelRep ? new Int16Array(nPix) : new Uint16Array(nPix));
    if (bytesPerSample === 1) {
      for (let i = 0; i < nPix; i++) out[i] = pixelRep ? view.getInt8(base + i) : view.getUint8(base + i);
    } else {
      for (let i = 0; i < nPix; i++) out[i] = pixelRep ? view.getInt16(base + i * 2, true) : view.getUint16(base + i * 2, true);
    }
    return out;
  }

  // Color: return interleaved RGB uint8 (rows*cols*3).
  const out = new Uint8Array(nPix * 3);
  if (planar === 1) {
    // Planar: all R, then all G, then all B for this frame.
    for (let ch = 0; ch < 3; ch++) {
      const cbase = base + ch * nPix;
      for (let p = 0; p < nPix; p++) out[p * 3 + ch] = view.getUint8(cbase + p);
    }
  } else {
    for (let p = 0; p < nPix; p++) {
      out[p * 3] = view.getUint8(base + p * 3);
      out[p * 3 + 1] = view.getUint8(base + p * 3 + 1);
      out[p * 3 + 2] = view.getUint8(base + p * 3 + 2);
    }
  }
  return out;
}

function ybrFullToRgb(rgb) {
  for (let i = 0; i < rgb.length; i += 3) {
    const y = rgb[i], cb = rgb[i + 1], cr = rgb[i + 2];
    let r = y + 1.402 * (cr - 128);
    let g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
    let b = y + 1.772 * (cb - 128);
    rgb[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    rgb[i + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    rgb[i + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  }
  return rgb;
}

// Expand a parsed dataset into an array of slice records.
function datasetToSlices(parsed, name) {
  const { map } = parsed;
  const rows = elNumber(map, T.Rows);
  const cols = elNumber(map, T.Columns);
  if (!rows || !cols) throw new DicomError(`${name}: missing Rows/Columns`);
  const spp = elNumber(map, T.SamplesPerPixel, 1);
  const bitsAllocated = elNumber(map, T.BitsAllocated, 16);
  const pixelRep = elNumber(map, T.PixelRepresentation, 0);
  const planar = elNumber(map, T.PlanarConfiguration, 0);
  const photometric = elString(map, T.PhotometricInterpretation, 'MONOCHROME2');
  const nFrames = elNumber(map, T.NumberOfFrames, 1) || 1;

  const perFrameSeq = map.get(T.PerFrameFunctionalGroupsSequence);
  const sharedSeq = map.get(T.SharedFunctionalGroupsSequence);
  const sharedItem = sharedSeq && sharedSeq.items && sharedSeq.items[0] ? sharedSeq.items[0] : null;

  const ctx = { view: parsed.view, bytes: parsed.bytes, map };
  const isColor = spp === 3;
  const slices = [];
  for (let f = 0; f < nFrames; f++) {
    const perFrameItem = perFrameSeq && perFrameSeq.items ? perFrameSeq.items[f] : null;
    const meta = frameMeta(map, perFrameItem, sharedItem, f);
    let pixels = decodeFramePixels(ctx, rows, cols, spp, bitsAllocated, pixelRep, planar, f);
    if (isColor && /^YBR_FULL$/.test(photometric)) pixels = ybrFullToRgb(pixels);
    slices.push({
      name, frameIndex: f, rows, cols, spp, photometric, isColor,
      slope: meta.slope, intercept: meta.intercept,
      ipp: meta.ipp, iop: meta.iop, instanceNumber: meta.instanceNumber,
      spacing: meta.spacing, thickness: meta.thickness,
      pixels,
    });
  }
  return { slices, multiframe: nFrames > 1 };
}

// Every frame of one file as a slice record, each with its own position, orientation,
// pixel spacing and rescale, in file order: for frames that share no plane, such as the
// differently oriented slices of an MPR localizer, which no single volume can hold.
export function readDicomFrames(buffer, name) {
  return datasetToSlices(parseDicom(buffer), name).slices;
}

// ---- Siemens mosaic ----
//
// An EPI series (fMRI, DWI) is often exported with every slice of one volume
// tiled into a single large square frame; a run of files is then 4D. dcm2niix
// splits the tiles. The header says how many slices a file holds, which the
// series list shows.
export function mosaicInfo(map) {
  const imageType = elString(map, T.ImageType, '') || '';
  if (!/(^|\\)MOSAIC(\\|$)/i.test(imageType)) return null;
  const n = elNumber(map, T.NumberOfImagesInMosaic, null);
  if (!n || !Number.isFinite(n) || n < 2) return null;
  if (elNumber(map, T.SamplesPerPixel, 1) !== 1) return null;
  const rows = elNumber(map, T.Rows);
  const cols = elNumber(map, T.Columns);
  const grid = Math.ceil(Math.sqrt(n));
  if (!rows || !cols || rows % grid !== 0 || cols % grid !== 0) return null;
  return { n, grid, tileH: rows / grid, tileW: cols / grid, rows, cols };
}

// Read a set of DICOM files (one series) into a canonical Volume.
// files: [{ name, buffer (ArrayBuffer) }].
// convertDicom(files) runs dcm2niix on [{ name, bytes }] and resolves to its outputs as
// [{ name, bytes }]; the web app and the command line each supply their own build.
// mosaicReduce picks how a 4D series (a mosaic run, a time series) becomes one volume;
// batchBytes bounds the input of one dcm2niix call on a mosaic run.
export async function readDicomSeries(files, { convertDicom, mosaicReduce = 'first', batchBytes = MOSAIC_BATCH_BYTES }) {
  if (!files || files.length === 0) throw new DicomError('No DICOM files provided');
  const reduce = VOLUME_REDUCTIONS.includes(mosaicReduce) ? mosaicReduce : 'first';
  // MRI2vid.py takes a series in file-name order.
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const mosaic = mosaicRun(ordered[0].buffer);
  let nifti;
  if (mosaic) {
    nifti = await readMosaicRun(ordered, mosaic, reduce, convertDicom, batchBytes);
  } else {
    nifti = await convertSeries(files, reduce, convertDicom);
    nifti.meta.note = joinNotes(splitNote(nifti.meta.images), nifti.meta.note);
  }
  const vol = dicomLayout(nifti, await seriesOrientation(ordered[0].buffer));
  const [rows, cols, slices] = vol.dims;
  vol.meta = { ...nifti.meta, source: 'dicom', rows, cols, slices };
  return vol;
}

// A mosaic file's tiling and acquisition parameters; the files of one run share them. Null for any other file.
function mosaicRun(buffer) {
  try {
    const { map } = parseDicom(buffer, { headerOnly: true });
    const info = mosaicInfo(map);
    if (!info) return null;
    // The acquisition parameters dcm2niix splits a series on.
    const timing = [T.EchoTime, T.RepetitionTime, T.InversionTime, T.FlipAngle].map((tag) => elNumber(map, tag, null));
    return { ...info, key: `${info.n} ${info.rows}x${info.cols} ${timing.join(' ')} ${elString(map, T.ImageType, '')}` };
  } catch {
    return null;
  }
}

const joinNotes = (...notes) => notes.filter(Boolean).join('. ') || null;

// dcm2niix splits a series it cannot stack into one volume, such as one holding
// several echoes; the video shows the first of them.
const splitNote = (images) => (images > 1
  ? `dcm2niix split this series into ${images} images (for example one per echo); showing the first`
  : null);

// Run dcm2niix on one series and read its first image, reduced to one volume;
// meta.images counts the images dcm2niix made.
async function convertSeries(files, reduce, convertDicom, total = null) {
  // dcm2niix reads its inputs from one directory, so files from different folders that
  // share a name must not overwrite each other.
  const inputs = files.map((f, i) => ({ name: `${i}_${f.name.replaceAll('/', '_')}`, bytes: new Uint8Array(f.buffer) }));
  const outputs = (await convertDicom(inputs))
    .filter((o) => /\.nii(\.gz)?$/i.test(o.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!outputs.length) throw new DicomError('dcm2niix found no image in this series');
  const { bytes, name } = outputs[0];
  const nifti = await readNifti(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name, { reduce, total });
  nifti.meta = { ...nifti.meta, images: outputs.length };
  return nifti;
}

// Each file of a Siemens mosaic run is a whole volume. Converting only the files a
// reduction needs, a batch at a time, keeps a long run within the WASM heap.
const MOSAIC_BATCH_BYTES = 256 * 1024 * 1024;

async function readMosaicRun(ordered, first, reduce, convertDicom, batchBytes) {
  // Only files tiled and acquired like the first belong to its run; another echo or an
  // ordinary image in the same series is left out rather than averaged in.
  const run = ordered.filter((file, i) => i === 0 || mosaicRun(file.buffer)?.key === first.key);
  const leftOut = ordered.length - run.length;
  const leftOutNote = leftOut
    ? `${leftOut} file(s) of this series are not part of the first mosaic run (for example another echo) and were left out`
    : null;
  if (reduce === 'first') {
    const nifti = await convertSeries(run.slice(0, 1), reduce, convertDicom);
    const volumes = run.length > 1 ? volumeNote(run.length, 1, reduce) : nifti.meta.note;
    const note = joinNotes(splitNote(nifti.meta.images), leftOutNote, volumes);
    nifti.meta = { ...nifti.meta, volumes: run.length, used: 1, reduce, note };
    return nifti;
  }
  const batches = [[]];
  let bytes = 0;
  for (const file of run) {
    if (bytes + file.buffer.byteLength > batchBytes && batches.at(-1).length) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1).push(file);
    bytes += file.buffer.byteLength;
  }
  // The mean keeps its float64 sum across batches, so batching cannot change a pixel.
  const total = reduce === 'mean' ? new Float64Array(first.n * first.tileH * first.tileW) : null;
  let result = null;
  let used = 0;
  let images = 1;
  for (const batch of batches) {
    const part = await convertSeries(batch, reduce, convertDicom, total);
    images = Math.max(images, part.meta.images);
    if (!result) {
      result = part;
    } else if (part.dims.some((d, i) => d !== result.dims[i])) {
      // Positions may differ: motion-corrected runs move each volume.
      throw new DicomError('The volumes of this mosaic run differ in shape');
    } else if (!total) {
      for (let i = 0; i < part.data.length; i++) if (part.data[i] > result.data[i]) result.data[i] = part.data[i];
    }
    used += part.meta.used;
  }
  if (total) for (let i = 0; i < total.length; i++) result.data[i] = total[i] / used;
  const note = joinNotes(splitNote(images), leftOutNote, volumeNote(run.length, used, reduce));
  result.meta = { ...result.meta, volumes: run.length, used, reduce, note };
  return result;
}

// The row and column directions (LPS) of a series' first frame, null without geometry.
async function seriesOrientation(buffer) {
  const { map } = await parseDicomHeader(buffer);
  const perFrame = map.get(T.PerFrameFunctionalGroupsSequence)?.items?.[0] ?? null;
  const shared = map.get(T.SharedFunctionalGroupsSequence)?.items?.[0] ?? null;
  const { iop } = frameMeta(map, perFrame, shared, 0);
  return iop && iop.length === 6 && iop.every(Number.isFinite) ? iop : null;
}

// Without an orientation dcm2niix cannot reorient, so it stores the columns along i
// and the rows along j, bottom row first, with an identity affine.
const STORED_LAYOUT = { perm: [1, 0, 2], flip: [true, false, false] };

// dcm2niix stores columns along i and rows along j, flipped, and may reverse the slice
// order; which of these it does depends on the orientation. Find, for each axis of the
// DICOM layout, the NIfTI axis that runs the same way, from the NIfTI affine (RAS) and
// the DICOM orientation (LPS).
function axesFromOrientation(A, [rx, ry, rz, cx, cy, cz]) {
  const normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
  const ras = ([x, y, z]) => [-x, -y, z];
  // Rows run along the column direction, columns along the row direction.
  const wanted = [ras([cx, cy, cz]), ras([rx, ry, rz]), ras(normal)];
  const axes = [0, 1, 2].map((a) => [A[a], A[4 + a], A[8 + a]]);
  const perm = [];
  const flip = [];
  for (const w of wanted) {
    let best = -1;
    let bestDot = 0;
    axes.forEach((axis, a) => {
      const dot = (w[0] * axis[0] + w[1] * axis[1] + w[2] * axis[2]) / (Math.hypot(...axis) || 1);
      if (Math.abs(dot) > Math.abs(bestDot)) { best = a; bestDot = dot; }
    });
    perm.push(best);
    flip.push(bestDot < 0);
  }
  if (new Set(perm).size !== 3) throw new DicomError('dcm2niix returned an image whose axes do not follow the DICOM orientation');
  return { perm, flip };
}

// Copy dcm2niix's voxels into the DICOM [rows, cols, slices] layout.
function dicomLayout(vol, iop) {
  const A = vol.affine;
  const { perm, flip } = iop ? axesFromOrientation(A, iop) : STORED_LAYOUT;
  const src = vol.dims;
  const dims = perm.map((a) => src[a]);
  const C = vol.channels;
  const data = new vol.data.constructor(vol.data.length);
  const strides = [src[1] * src[2], src[2], 1];
  const step = perm.map((a, t) => (flip[t] ? -strides[a] : strides[a]));
  const origin = perm.reduce((o, a, t) => o + (flip[t] ? (src[a] - 1) * strides[a] : 0), 0);
  let di = 0;
  for (let i0 = 0; i0 < dims[0]; i0++) {
    for (let i1 = 0; i1 < dims[1]; i1++) {
      let si = origin + i0 * step[0] + i1 * step[1];
      for (let i2 = 0; i2 < dims[2]; i2++, si += step[2]) {
        for (let ch = 0; ch < C; ch++) data[di++] = vol.data[si * C + ch];
      }
    }
  }

  const affine = new Float64Array(16);
  affine[15] = 1;
  for (let r = 0; r < 3; r++) {
    let offset = A[r * 4 + 3];
    perm.forEach((a, t) => {
      affine[r * 4 + t] = flip[t] ? -A[r * 4 + a] : A[r * 4 + a];
      if (flip[t]) offset += (src[a] - 1) * A[r * 4 + a];
    });
    affine[r * 4 + 3] = offset;
  }
  return makeVolume({ dims, channels: C, data, affine, photometric: vol.photometric, meta: vol.meta });
}

// Lightweight per-file header parse for series grouping/ranking (no pixel decode).
export function readDicomHeader(buffer, name) {
  const parsed = parseDicom(buffer, { headerOnly: true });
  const { map } = parsed;
  const mosaic = mosaicInfo(map);
  return {
    name,
    mosaicSlices: mosaic ? mosaic.n : 0,
    seriesInstanceUID: elString(map, T.SeriesInstanceUID, ''),
    studyInstanceUID: elString(map, T.StudyInstanceUID, ''),
    seriesNumber: elNumber(map, T.SeriesNumber, null),
    seriesDescription: elString(map, T.SeriesDescription, ''),
    modality: 'MR',
    repetitionTime: elNumber(map, T.RepetitionTime, null),
    echoTime: elNumber(map, T.EchoTime, null),
    inversionTime: elNumber(map, T.InversionTime, null),
    flipAngle: elNumber(map, T.FlipAngle, null),
    mrAcquisitionType: elString(map, T.MRAcquisitionType, ''),
    samplesPerPixel: elNumber(map, T.SamplesPerPixel, 1),
    photometric: elString(map, T.PhotometricInterpretation, 'MONOCHROME2'),
    numberOfFrames: elNumber(map, T.NumberOfFrames, 1) || 1,
    rows: elNumber(map, T.Rows, null),
    cols: elNumber(map, T.Columns, null),
  };
}
