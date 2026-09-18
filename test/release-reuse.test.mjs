import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveHash, recordUrls, reuseCandidate, reusePlan } from '../scripts/lib/release-reuse.mjs';

const base = 'https://github.com/neurodesk/webapps/releases/download';
const pack = version => ({
  kind: 'models',
  platform: 'any',
  version,
  bytes: 2_100_000_000,
  url: `${base}/webapps-v${version}/webapps-${version}-models.tar.gz.install.txt`,
  archiveSha256: 'a'.repeat(64),
  parts: [
    { filename: `webapps-${version}-models.tar.gz.part01`, url: `${base}/webapps-v${version}/webapps-${version}-models.tar.gz.part01`, sha256: 'b'.repeat(64) },
    { filename: `webapps-${version}-models.tar.gz.part02`, url: `${base}/webapps-v${version}/webapps-${version}-models.tar.gz.part02`, sha256: 'c'.repeat(64) },
  ],
});
const platform = (version, sha256) => ({
  kind: 'desktop',
  platform: 'linux-x64',
  version,
  bytes: 670_000_000,
  url: `${base}/webapps-v${version}/webapps-${version}-linux-x64.tar.gz`,
  sha256,
});

test('the complete archive hash comes from the reassembled archive when the release is split', () => {
  assert.equal(archiveHash(pack('0.8.20260917')), 'a'.repeat(64));
  assert.equal(archiveHash(platform('0.8.20260917', 'd'.repeat(64))), 'd'.repeat(64));
});

test('an unchanged model pack is reused with the URLs that were actually published', () => {
  const previous = { version: '0.8.20260917', downloads: [platform('0.8.20260917', 'd'.repeat(64))], models: pack('0.8.20260917') };
  const reused = reuseCandidate(previous, pack('0.9.20260918'));
  assert.equal(reused.version, '0.8.20260917');
  assert.deepEqual(recordUrls(reused), [
    `${base}/webapps-v0.8.20260917/webapps-0.8.20260917-models.tar.gz.install.txt`,
    `${base}/webapps-v0.8.20260917/webapps-0.8.20260917-models.tar.gz.part01`,
    `${base}/webapps-v0.8.20260917/webapps-0.8.20260917-models.tar.gz.part02`,
  ]);
});

test('a pack whose models changed is not reused', () => {
  const previous = { downloads: [], models: pack('0.8.20260917') };
  const rebuilt = { ...pack('0.9.20260918'), archiveSha256: 'e'.repeat(64) };
  assert.equal(reuseCandidate(previous, rebuilt), null);
});

test('a platform archive is only reused for the same platform and kind', () => {
  const previous = { downloads: [platform('0.8.20260917', 'd'.repeat(64))] };
  assert.equal(reuseCandidate(previous, platform('0.9.20260918', 'd'.repeat(64))).version, '0.8.20260917');
  assert.equal(reuseCandidate(previous, { ...platform('0.9.20260918', 'd'.repeat(64)), platform: 'windows-x64' }), null);
  assert.equal(reuseCandidate(previous, { ...platform('0.9.20260918', 'd'.repeat(64)), kind: 'container' }), null);
});

test('the first suite and a suite that published no pack reuse nothing', () => {
  assert.equal(reuseCandidate(undefined, pack('0.9.20260918')), null);
  assert.equal(reuseCandidate({ downloads: [] }, pack('0.9.20260918')), null);
});

test('the plan keeps the built records in order beside their candidates', () => {
  const previous = { downloads: [platform('0.8.20260917', 'd'.repeat(64))], models: pack('0.8.20260917') };
  const built = [platform('0.9.20260918', 'f'.repeat(64)), pack('0.9.20260918')];
  const plan = reusePlan(previous, built);
  assert.deepEqual(plan.map(entry => entry.record.platform), ['linux-x64', 'any']);
  assert.equal(plan[0].candidate, null);
  assert.equal(plan[1].candidate.version, '0.8.20260917');
});
