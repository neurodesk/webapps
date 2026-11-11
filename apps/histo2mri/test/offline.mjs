import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync, gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';

// A brightfield-looking PNG of the fixture's middle k slice, three pixels per voxel, so the
// installed app has a section that truly comes from its MRI.
function sectionFrom(fixtureBytes) {
  const raw = gunzipSync(fixtureBytes);
  const { imageData, dims } = parseNiftiVolume(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const [nx, ny] = dims;
  const k = Math.floor(dims[2] / 2);
  let maximum = 0;
  for (let i = 0; i < nx * ny; i++) maximum = Math.max(maximum, imageData[k * nx * ny + i]);
  const width = nx * 3;
  const height = ny * 3;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    rows[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const t = imageData[k * nx * ny + Math.floor(y / 3) * nx + Math.floor(x / 3)] / maximum;
      const at = y * (1 + width * 3) + 1 + x * 3;
      rows[at] = Math.round(255 - 150 * t);
      rows[at + 1] = Math.round(255 - 210 * t);
      rows[at + 2] = Math.round(255 - 90 * t);
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return { png, k };
}

// The installed desktop app registers that section to the fixture and reports its plane.
export async function verifyOffline(page, { fixture, download }) {
  const bytes = await readFile(fixture);
  const { png, k } = sectionFrom(bytes);
  await page.locator('#mriInput').setInputFiles([{ name: 'small.nii.gz', mimeType: 'application/gzip', buffer: bytes }, { name: 'section.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#axis').selectOption('2');
  await page.locator('#sliceIndex').fill(String(k));
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Registered 1 section', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Registration report") .nd-download-btn');
  assert.equal(result.filename, 'section_registration.json');
  const report = JSON.parse(result.bytes.toString('utf8'));
  assert.equal(report.plane.axis, 2);
  assert.ok(Math.abs(report.plane.index - k) <= 0.5);
  assert.ok(report.nmi.final > report.nmi.initial, `NMI ${report.nmi.initial} → ${report.nmi.final}`);
  return { filename: result.filename, nmi: report.nmi.final };
}
