import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeRasterImage, probeRasterImage } from '../src/file-io/raster-image.js';
import { InputTooLargeError } from '../src/file-io/input-limits.js';

function png(width, height, colourType = 2, bitDepth = 8) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  const rows = Buffer.alloc(height * (1 + width * 3));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

// SOI, an APP1 segment larger than 64 KB, a DQT segment, then SOF2 (progressive).
function jpeg(width, height, appBytes = 70000) {
  const segment = (marker, length) => {
    const out = Buffer.alloc(2 + length);
    out[0] = 0xff;
    out[1] = marker;
    out.writeUInt16BE(length, 2);
    return out;
  };
  const app1 = Buffer.concat(Array.from({ length: Math.ceil(appBytes / 60000) }, () => segment(0xe1, 60000)));
  const sof = segment(0xc2, 17);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xff]), segment(0xdb, 67), sof, Buffer.from([0xff, 0xda, 0, 2])]));
}

test('a PNG header gives its size, bit depth and colour type', () => {
  assert.deepEqual(probeRasterImage(png(1249, 972, 3, 4)), { format: 'png', width: 1249, height: 972, bitDepth: 4, colourType: 3 });
});

test('a JPEG frame header is found by walking segments past large metadata and fill bytes', () => {
  assert.deepEqual(probeRasterImage(jpeg(5184, 3973)), { format: 'jpeg', width: 5184, height: 3973, bitDepth: 8, components: 3 });
  const noFrame = jpeg(10, 10).slice(0, 2 + 2 * 60002);
  assert.throws(() => probeRasterImage(noFrame), /no frame header/);
});

test('other formats are not PNG or JPEG', () => {
  assert.equal(probeRasterImage(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0])), null);
});

test('decoding refuses an image from its header before decoding it', async () => {
  const file = new Blob([png(4000, 4000)]);
  await assert.rejects(decodeRasterImage(file, { maxBytes: 4000 * 4000 * 4 - 1 }), InputTooLargeError);
  await assert.rejects(decodeRasterImage(new Blob([new Uint8Array([1, 2, 3])])), /not a PNG or JPEG/);
});
