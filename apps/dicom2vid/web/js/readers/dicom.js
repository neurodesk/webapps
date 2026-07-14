// Minimal DICOM reader for the video pipeline.
//
// Scope: uncompressed Explicit VR Little Endian and Implicit VR Little Endian,
// single-frame and enhanced multiframe, grayscale (8/16-bit, signed/unsigned)
// and RGB (interleaved or planar, RGB or YBR_FULL). Compressed transfer syntaxes
// and Explicit VR Big Endian are rejected with a clear error rather than a crash.
//
// The series assembler mirrors MRI2vid.py: per-slice rescale, geometry sort,
// and a [rows, cols, slices] volume.

import { makeVolume } from '../volume.js';

// ---- transfer syntaxes ----
const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

// ---- tags (group * 0x10000 + element) ----
const T = {
  TransferSyntaxUID: 0x00020010,
  SOPClassUID: 0x00080016,
  SeriesDescription: 0x0008103e,
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
  SamplesPerPixel: 0x00280002,
  PhotometricInterpretation: 0x00280004,
  PlanarConfiguration: 0x00280006,
  NumberOfFrames: 0x00280008,
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
  PixelData: 0x7fe00010,
  ItemStart: 0xfffee000,
  ItemEnd: 0xfffee00d,
  SeqEnd: 0xfffee0dd,
};

// VRs that carry a 2-byte reserved field then a 4-byte length in Explicit VR.
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR', 'SV', 'UV']);
const NUM_VR = new Set(['US', 'SS', 'UL', 'SL', 'FL', 'FD', 'AT', 'OW', 'OB', 'OL', 'OF', 'OD']);

// Minimal VR dictionary used only for Implicit VR decoding.
const IMPLICIT_VR = new Map([
  [T.TransferSyntaxUID, 'UI'], [T.SOPClassUID, 'UI'], [T.SeriesDescription, 'LO'],
  [T.RepetitionTime, 'DS'], [T.EchoTime, 'DS'], [T.InversionTime, 'DS'],
  [T.MRAcquisitionType, 'CS'], [T.FlipAngle, 'DS'],
  [T.StudyInstanceUID, 'UI'], [T.SeriesInstanceUID, 'UI'],
  [T.SeriesNumber, 'IS'], [T.InstanceNumber, 'IS'],
  [T.ImagePositionPatient, 'DS'], [T.ImageOrientationPatient, 'DS'],
  [T.FrameContentSequence, 'SQ'], [T.PlanePositionSequence, 'SQ'],
  [T.PlaneOrientationSequence, 'SQ'], [T.PixelValueTransformationSequence, 'SQ'],
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
  return out;
}

// Parse a dataset (a run of elements) into a Map keyed by numeric tag.
// Returns the Map. `end` is an absolute byte offset limit. When stopGroupAbove is
// set, parsing stops as soon as a tag with a higher group number is seen; DICOM
// elements are stored in ascending tag order, so this is a safe header-only fast
// path (all tags we need for grouping/geometry are group <= 0x0028).
function parseDataset(view, start, end, implicitVR, littleEndian, bytes, stopGroupAbove = null) {
  const map = new Map();
  let off = start;
  while (off + 8 <= end) {
    const group = view.getUint16(off, littleEndian);
    const element = view.getUint16(off + 2, littleEndian);
    const tag = (group * 0x10000 + element) >>> 0;
    if (stopGroupAbove !== null && group !== 0xfffe && group > stopGroupAbove) {
      return { map, next: off };
    }
    off += 4;

    // Item/sequence delimiters handled by the caller; stop if we hit one.
    if (group === 0xfffe) {
      // length follows (4 bytes); consume and return so caller can react.
      off -= 4;
      return { map, next: off };
    }

    let vr;
    let length;
    if (implicitVR) {
      length = view.getUint32(off, littleEndian);
      off += 4;
      vr = IMPLICIT_VR.get(tag) || (length === 0xffffffff ? 'SQ' : 'UN');
    } else {
      vr = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1));
      off += 2;
      if (LONG_VR.has(vr)) {
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
      const { items, next } = parseSequence(view, off, seqEnd, length === 0xffffffff, implicitVR, littleEndian, bytes);
      map.set(tag, { vr, items });
      off = next;
      continue;
    }

    if (length === 0xffffffff) {
      // Undefined length on a non-SQ element: encapsulated (compressed) pixel data
      // or an undefined-length item. We do not support compressed pixels.
      if (tag === T.PixelData) {
        map.set(tag, { vr, encapsulated: true });
        throw new DicomError('This DICOM uses a compressed transfer syntax (encapsulated pixel data). Decode it to uncompressed DICOM/NIfTI locally first.');
      }
      // Skip to sequence delimiter.
      off = skipUndefinedLength(view, off, end, littleEndian);
      continue;
    }

    const valEnd = off + length;
    if (valEnd > end) {
      // Truncated element; stop parsing gracefully.
      break;
    }

    if (tag === T.PixelData) {
      map.set(tag, { vr, pixelOffset: off, pixelLength: length });
    } else if (NUM_VR.has(vr) && vr !== 'OB' && vr !== 'OW') {
      map.set(tag, { vr, numbers: decodeNumbers(vr, view, off, length, littleEndian) });
    } else if (vr === 'OB' || vr === 'OW' || vr === 'UN') {
      map.set(tag, { vr, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset + off, length) });
    } else {
      const str = decodeString(new Uint8Array(bytes.buffer, bytes.byteOffset + off, length));
      map.set(tag, { vr, str });
    }
    off = valEnd;
  }
  return { map, next: off };
}

function parseSequence(view, start, end, undefinedLength, implicitVR, littleEndian, bytes) {
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
    const { map, next } = parseDataset(view, off, itemEnd, implicitVR, littleEndian, bytes);
    items.push(map);
    if (len === 0xffffffff) {
      // next points at the item delimiter (fffe,e00d); consume it.
      off = consumeDelimiter(view, next, end, littleEndian, T.ItemEnd);
    } else {
      off = itemEnd;
    }
  }
  return { items, next: off };
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
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes.length < 132) {
    throw new DicomError('File too small to be a DICOM image');
  }

  let start = 0;
  let hasMeta = false;
  if (bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d) {
    start = 132;
    hasMeta = true;
  }

  let transferSyntax = TS_EXPLICIT_LE;
  let dataStart = start;

  if (hasMeta) {
    // File meta group is always Explicit VR Little Endian. Parse until group != 2.
    let off = start;
    while (off + 8 <= bytes.length) {
      const group = view.getUint16(off, true);
      if (group !== 0x0002) break;
      const element = view.getUint16(off + 2, true);
      const tag = (group * 0x10000 + element) >>> 0;
      const vr = String.fromCharCode(bytes[off + 4], bytes[off + 5]);
      let len;
      let valOff;
      if (LONG_VR.has(vr)) { len = view.getUint32(off + 8, true); valOff = off + 12; }
      else { len = view.getUint16(off + 6, true); valOff = off + 8; }
      if (tag === T.TransferSyntaxUID) {
        transferSyntax = decodeString(new Uint8Array(arrayBuffer, valOff, len));
      }
      off = valOff + len;
      dataStart = off;
    }
  }

  if (transferSyntax === TS_EXPLICIT_BE) {
    throw new DicomError('Explicit VR Big Endian is not supported. Convert to Little Endian first.');
  }
  const uncompressed = transferSyntax === TS_IMPLICIT_LE || transferSyntax === TS_EXPLICIT_LE;
  if (!uncompressed) {
    throw new DicomError(`Unsupported (likely compressed) transfer syntax ${transferSyntax}. Decode to uncompressed DICOM/NIfTI locally first.`);
  }
  const implicitVR = transferSyntax === TS_IMPLICIT_LE;

  const { map } = parseDataset(view, dataStart, bytes.length, implicitVR, true, bytes,
    headerOnly ? 0x0028 : null);
  return { map, view, bytes, transferSyntax, implicitVR };
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
    // Ordinary single-frame file: sort by the top-level InstanceNumber (0020,0013)
    // like load_and_sort_dicoms. Null when absent, so sortSlices falls back to
    // filename order exactly as the reference's final else branch does.
    const n = elNumber(map, T.InstanceNumber, null);
    instanceNumber = n === null ? null : readNumberSafe(n, null);
  }

  return { ipp, iop, slope, intercept, instanceNumber };
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
      pixels,
    });
  }
  return { slices, multiframe: nFrames > 1 };
}

// Sort slice records like load_and_sort_dicoms.
function sortSlices(slices) {
  const first = slices[0];
  if (first.ipp && first.iop) {
    const rc = first.iop.slice(0, 3);
    const cc = first.iop.slice(3, 6);
    const normal = [
      rc[1] * cc[2] - rc[2] * cc[1],
      rc[2] * cc[0] - rc[0] * cc[2],
      rc[0] * cc[1] - rc[1] * cc[0],
    ];
    slices.forEach((s, i) => { s._i = i; s._key = s.ipp[0] * normal[0] + s.ipp[1] * normal[1] + s.ipp[2] * normal[2]; });
  } else if (first.ipp) {
    slices.forEach((s, i) => { s._i = i; s._key = s.ipp[2]; });
  } else if (first.instanceNumber !== undefined && first.instanceNumber !== null) {
    slices.forEach((s, i) => { s._i = i; s._key = s.instanceNumber; });
  } else {
    slices.forEach((s, i) => { s._i = i; s._key = s.name; });
  }
  slices.sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : a._i - b._i));
  return slices;
}

// Read a set of DICOM files (one series) into a canonical Volume.
// `files` is an array of { name, buffer (ArrayBuffer) }.
export function readDicomSeries(files) {
  if (!files || files.length === 0) throw new DicomError('No DICOM files provided');

  // Reference reads files in sorted-filename order before the geometry sort.
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let allSlices = [];
  let anyMultiframe = false;
  const parsedList = [];
  for (const f of ordered) {
    const parsed = parseDicom(f.buffer);
    parsedList.push(parsed);
    const { slices, multiframe } = datasetToSlices(parsed, f.name);
    if (multiframe) anyMultiframe = true;
    allSlices = allSlices.concat(slices);
  }
  if (anyMultiframe && ordered.length > 1) {
    throw new DicomError('Multiple files contain multiframe (3D) pixel data; provide a single multiframe file or a set of single-frame files.');
  }

  sortSlices(allSlices);

  const first = allSlices[0];
  const rows = first.rows;
  const cols = first.cols;
  const spp = first.spp;
  for (const s of allSlices) {
    if (s.rows !== rows || s.cols !== cols || s.spp !== spp) {
      throw new DicomError('Slice geometry (rows/cols/channels) is not consistent across the series');
    }
  }

  const N = allSlices.length;
  const isColor = spp === 3;

  if (!isColor) {
    // Grayscale: apply per-slice rescale to real float32 values in [rows, cols, slices].
    const data = new Float32Array(rows * cols * N);
    for (let s = 0; s < N; s++) {
      const sl = allSlices[s];
      const px = sl.pixels;
      const slope = sl.slope;
      const intercept = sl.intercept;
      let p = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          data[(r * cols + c) * N + s] = px[p++] * slope + intercept;
        }
      }
    }
    return buildVolume(data, 1, rows, cols, N, 'MONOCHROME2', first, allSlices);
  }

  // Color: interleaved RGB uint8 in [rows, cols, slices] with 3 channels.
  const data = new Uint8Array(rows * cols * N * 3);
  for (let s = 0; s < N; s++) {
    const px = allSlices[s].pixels;
    let p = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const di = ((r * cols + c) * N + s) * 3;
        data[di] = px[p++];
        data[di + 1] = px[p++];
        data[di + 2] = px[p++];
      }
    }
  }
  return buildVolume(data, 3, rows, cols, N, 'RGB', first, allSlices);
}

function buildVolume(data, channels, rows, cols, N, photometric, first, slices) {
  const affine = affineFromSlices(first, slices);
  return makeVolume({
    dims: [rows, cols, N],
    channels,
    data,
    affine,
    photometric,
    meta: {
      source: 'dicom',
      rows, cols, slices: N,
      seriesDescription: undefined,
    },
  });
}

// Build a 4x4 affine (LPS) from the sorted slice geometry, if available. This is
// used only for the optional NiiVue preview, not for the reslice.
function affineFromSlices(first, slices) {
  if (!first.ipp || !first.iop) return null;
  const rc = first.iop.slice(0, 3);
  const cc = first.iop.slice(3, 6);
  let normal = [
    rc[1] * cc[2] - rc[2] * cc[1],
    rc[2] * cc[0] - rc[0] * cc[2],
    rc[0] * cc[1] - rc[1] * cc[0],
  ];
  let dz = 1;
  if (slices.length > 1 && slices[1].ipp) {
    dz = Math.sqrt(
      (slices[1].ipp[0] - first.ipp[0]) ** 2 +
      (slices[1].ipp[1] - first.ipp[1]) ** 2 +
      (slices[1].ipp[2] - first.ipp[2]) ** 2,
    ) || 1;
  }
  const A = [
    rc[0], cc[0], normal[0] * dz, first.ipp[0],
    rc[1], cc[1], normal[1] * dz, first.ipp[1],
    rc[2], cc[2], normal[2] * dz, first.ipp[2],
    0, 0, 0, 1,
  ];
  return Float64Array.from(A);
}

// Lightweight per-file header parse for series grouping/ranking (no pixel decode).
export function readDicomHeader(buffer, name) {
  const parsed = parseDicom(buffer, { headerOnly: true });
  const { map } = parsed;
  return {
    name,
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
