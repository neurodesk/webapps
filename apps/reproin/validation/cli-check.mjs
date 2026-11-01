#!/usr/bin/env node
// Runs a released reproinx on a ReproIn session and compares its BIDS tree with the web app's ZIP for the
// same DICOMs, under reproin-rs's tests/golden/browser_compare.py contract: paths and bytes match, JSON
// structurally, .gz decompressed. Native and WASM dcm2niix may still differ in NIfTI float orientation
// fields (bytes 256-327, relative 1e-4), .bvec values (1e-5, same shape) and provenance rows (a multiset;
// the WASM converter repeats the header line per series).
// Usage: REPROIN_E2E_DICOM_DIR=xa60 node cli-check.mjs --executable reproinx --web-zip bids.zip
// The ZIP is the web app's download (REPROIN_E2E_ZIP_OUT in apps/reproin/e2e/smoke.spec.js). reproinx
// needs dcm2niix >= v1.0.20261011 on PATH or in $DCM2NIIX. Built-ins only.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const { values } = parseArgs({ options: { executable: { type: 'string' }, 'web-zip': { type: 'string' }, dicom: { type: 'string' } } });
const dicom = values.dicom ?? process.env.REPROIN_E2E_DICOM_DIR;
if (!values.executable || !values['web-zip'] || !dicom) throw new Error('Usage: cli-check.mjs --executable reproinx --web-zip bids.zip [--dicom dir | REPROIN_E2E_DICOM_DIR]');

// Stored and deflated entries from the central directory; the web app writes no zip64 or encryption.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const files = new Map();
  for (let at = buffer.readUInt32LE(end + 16), n = buffer.readUInt16LE(end + 10); n--;) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

// Every file (and empty folder, as "dir/") below root, as relative path -> bytes.
async function tree(root) {
  const files = new Map();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path).split('\\').join('/');
    if (name.split('/').includes('.reproinx-undo')) continue;
    if (entry.isFile()) files.set(name, await readFile(path));
    else if (entry.isDirectory() && !(await readdir(path)).length) files.set(`${name}/`, Buffer.alloc(0));
  }
  return files;
}

const gunzip = (bytes) => { try { return gunzipSync(bytes); } catch { return null; } };
const close = (x, y, rel) => x === y || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= rel * Math.max(1, Math.abs(x), Math.abs(y)));

function same(a, b, path) {
  if (path.endsWith('/') || a.equals(b)) return true;
  if (path.endsWith('.json')) { try { return isDeepStrictEqual(JSON.parse(a), JSON.parse(b)); } catch { return false; } }
  if (path.endsWith('.gz')) { const [x, y] = [gunzip(a), gunzip(b)]; return Boolean(x && y && x.equals(y)); }
  return false;
}

function niftiClose(a, b) {
  const [x, y] = [gunzip(a), gunzip(b)];
  if (!x || !y || x.length !== y.length || x.length < 352 || !x.subarray(0, 256).equals(y.subarray(0, 256)) || !x.subarray(328).equals(y.subarray(328))) return false;
  for (let o = 256; o < 328; o += 4) if (!close(x.readFloatLE(o), y.readFloatLE(o), 1e-4)) return false;
  return true;
}

function bvecClose(a, b) {
  const [x, y] = [a, b].map((bytes) => bytes.toString().split('\n').map((line) => line.split(/\s+/).filter(Boolean).map(Number)));
  return x.length === y.length && x.every((row, i) => row.length === y[i].length && row.every((value, j) => close(value, y[i][j], 1e-5)));
}

function provenanceClose(a, b) {
  const [x, y] = [a, b].map((bytes) => bytes.toString().split(/\r?\n/).filter(Boolean));
  const rows = (lines) => lines.filter((line) => line !== lines[0]).sort();
  return x.length > 0 && x[0] === y[0] && isDeepStrictEqual(rows(x), rows(y));
}

const out = await mkdtemp(join(tmpdir(), 'reproin-cli-check-'));
try {
  // The web app's defaults: no anonymisation, date shift or derivatives; subject and session from the DICOMs.
  const run = spawnSync(values.executable, [dicom, out], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`reproinx exited with ${run.status}: ${run.stderr.slice(-2000)}`);
  const native = await tree(out);
  const web = new Map();
  const zipped = unzip(await readFile(values['web-zip']));
  for (const [name, bytes] of zipped) {
    if (!name.startsWith('bids/') || name === 'bids/') continue;
    // A folder entry counts only when it is empty, as on disk.
    if (name.endsWith('/') && [...zipped.keys()].some((other) => other !== name && other.startsWith(name))) continue;
    web.set(name.slice(5), bytes);
  }
  const bad = [...native.keys()].filter((path) => !web.has(path)).sort().map((path) => `only in native: ${path}`);
  bad.push(...[...web.keys()].filter((path) => !native.has(path)).sort().map((path) => `only in web:    ${path}`));
  let allowed = 0;
  for (const path of [...native.keys()].filter((key) => web.has(key)).sort()) {
    const [a, b] = [native.get(path), web.get(path)];
    if (same(a, b, path)) continue;
    const ok = (path.endsWith('.nii.gz') && niftiClose(a, b)) || (path.endsWith('.bvec') && bvecClose(a, b)) || (path.endsWith('.reproin_provenance.tsv') && provenanceClose(a, b));
    if (ok) {
      allowed += 1;
      console.log(`  converter-level: ${path}`);
    } else bad.push(`DIFFERS: ${path}`);
  }
  for (const line of bad) console.log(line);
  console.log(bad.length ? `FAIL ${bad.length} unexpected difference(s)` : `PASS ${native.size} paths match the web app (${allowed} converter-level)`);
  process.exitCode = bad.length ? 1 : 0;
} finally {
  await rm(out, { recursive: true, force: true });
}
