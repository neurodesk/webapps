// Synthetic, uncompressed MR slices. Values encode slice order for conversion checks.
// `patient` adds demographics: { birthDate, sex, age, studyDate } as DICOM DA/CS/AS strings.
// `fieldStrength` adds MagneticFieldStrength in tesla as a DICOM DS string.
export function dicomSeries({ series = 1, slices = 4, extension = '.dcm', patient = {}, fieldStrength } = {}) {
  const uid = `1.2.826.0.1.3680043.10.543.99.${series}`;
  const us = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  function tag(group, element, vr, value) {
    let data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
    const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
    const head = Buffer.alloc(long ? 12 : 8);
    head.writeUInt16LE(group); head.writeUInt16LE(element, 2); head.write(vr, 4);
    if (long) head.writeUInt32LE(data.length, 8); else head.writeUInt16LE(data.length, 6);
    return Buffer.concat([head, data]);
  }
  return Array.from({ length: slices }, (_, slice) => {
    const pixels = Buffer.alloc(16 * 16 * 2);
    for (let i = 0; i < 256; i++) pixels.writeUInt16LE((slice + 1) * 100 + i, i * 2);
    const instance = `${uid}.${slice + 1}`;
    const body = [
      tag(2, 1, 'OB', Buffer.from([0, 1])),
      tag(2, 2, 'UI', '1.2.840.10008.5.1.4.1.1.4'),
      tag(2, 3, 'UI', instance), tag(2, 0x10, 'UI', '1.2.840.10008.1.2.1'),
      tag(8, 8, 'CS', 'ORIGINAL\\PRIMARY\\M'),
      tag(8, 0x16, 'UI', '1.2.840.10008.5.1.4.1.1.4'), tag(8, 0x18, 'UI', instance),
      ...(patient.studyDate ? [tag(8, 0x20, 'DA', patient.studyDate), tag(8, 0x22, 'DA', patient.studyDate), tag(8, 0x32, 'TM', '101500')] : []),
      tag(8, 0x60, 'CS', 'MR'), tag(8, 0x70, 'LO', 'Synthetic'),
      tag(8, 0x103e, 'LO', `test_scan_${series}`), tag(0x10, 0x10, 'PN', 'Synthetic^Phantom'),
      ...(patient.birthDate ? [tag(0x10, 0x30, 'DA', patient.birthDate)] : []),
      ...(patient.sex ? [tag(0x10, 0x40, 'CS', patient.sex)] : []),
      ...(patient.age ? [tag(0x10, 0x1010, 'AS', patient.age)] : []),
      tag(0x18, 0x1030, 'LO', `test_scan_${series}`),
      tag(0x18, 0x50, 'DS', '1'), tag(0x18, 0x80, 'DS', '2000'), tag(0x18, 0x81, 'DS', '20'),
      ...(fieldStrength ? [tag(0x18, 0x87, 'DS', fieldStrength)] : []),
      tag(0x20, 0x0d, 'UI', '1.2.826.0.1.3680043.10.543.99'), tag(0x20, 0x0e, 'UI', uid),
      tag(0x20, 0x11, 'IS', series), tag(0x20, 0x13, 'IS', slice + 1),
      tag(0x20, 0x32, 'DS', `0\\0\\${slice}`), tag(0x20, 0x37, 'DS', '1\\0\\0\\0\\1\\0'),
      tag(0x28, 2, 'US', us(1)), tag(0x28, 4, 'CS', 'MONOCHROME2'),
      tag(0x28, 0x10, 'US', us(16)), tag(0x28, 0x11, 'US', us(16)),
      tag(0x28, 0x30, 'DS', '1\\1'), tag(0x28, 0x100, 'US', us(16)),
      tag(0x28, 0x101, 'US', us(16)), tag(0x28, 0x102, 'US', us(15)), tag(0x28, 0x103, 'US', us(0)),
      tag(0x7fe0, 0x10, 'OW', pixels),
    ];
    return { name: `scan${series}_${slice + 1}${extension}`, mimeType: 'application/dicom',
      buffer: Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), ...body]) };
  });
}

// Element builders for headers the series fixture does not cover: nested sequences,
// private groups, Implicit VR and other transfer syntaxes.
const LONG = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

// An Explicit VR element; an SQ value from undefinedSequence() keeps its undefined length.
export function explicit(group, element, vr, value) {
  let data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
  const undefinedLength = vr === 'SQ' && value.undefinedLength;
  const head = Buffer.alloc(LONG.has(vr) ? 12 : 8);
  head.writeUInt16LE(group);
  head.writeUInt16LE(element, 2);
  head.write(vr, 4);
  if (LONG.has(vr)) head.writeUInt32LE(undefinedLength ? 0xffffffff : data.length, 8);
  else head.writeUInt16LE(data.length, 6);
  return Buffer.concat([head, data]);
}

export function implicit(group, element, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const head = Buffer.alloc(8);
  head.writeUInt16LE(group);
  head.writeUInt16LE(element, 2);
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

export function item(body, undefinedLength = false) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0xfffe);
  head.writeUInt16LE(0xe000, 2);
  head.writeUInt32LE(undefinedLength ? 0xffffffff : body.length, 4);
  const end = Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
  return Buffer.concat([head, body, ...(undefinedLength ? [end] : [])]);
}

export function undefinedSequence(items) {
  const end = Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
  return Object.assign(Buffer.concat([...items, end]), { undefinedLength: true });
}

export function dicomFile(transferSyntax, body) {
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM'),
    explicit(2, 0x10, 'UI', transferSyntax),
    ...body,
  ]);
}

export const uint16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

export function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
