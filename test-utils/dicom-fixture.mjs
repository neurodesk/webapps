// Synthetic, uncompressed MR slices. Values encode slice order for conversion checks.
export function dicomSeries({ series = 1, slices = 4, extension = '.dcm' } = {}) {
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
      tag(8, 0x60, 'CS', 'MR'), tag(8, 0x70, 'LO', 'Synthetic'),
      tag(8, 0x103e, 'LO', `test_scan_${series}`), tag(0x10, 0x10, 'PN', 'Synthetic^Phantom'),
      tag(0x18, 0x1030, 'LO', `test_protocol_${series}`),
      tag(0x18, 0x50, 'DS', '1'), tag(0x18, 0x80, 'DS', '2000'), tag(0x18, 0x81, 'DS', '20'),
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
