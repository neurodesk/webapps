import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createSyncroRelease} from '../release.mjs';

const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
const appPackage=JSON.parse(await readFile(new URL('../../../apps/syncro/package.json',import.meta.url)));

// Written out for one fixed version: these are the names users download and the
// URLs the app links to, so they are spelled here rather than rebuilt from templates.
test('a release publishes these archive names, checksum files and download URLs',()=>{
  const release=createSyncroRelease('0.2.20260808');
  const base='https://github.com/neurodesk/webapps/releases/download/syncro-v0.2.20260808';
  assert.equal(release.tag,'syncro-v0.2.20260808');
  assert.deepEqual(Object.keys(release.targets),['windows-x64','linux-x64']);
  const windows=release.targets['windows-x64'];
  assert.equal(windows.archiveName,'syncro-0.2.20260808-windows-x64.zip');
  assert.equal(windows.checksumName,'syncro-0.2.20260808-windows-x64.zip.sha256');
  assert.equal(windows.validationName,'syncro-0.2.20260808-windows-x64.zip.validation.txt');
  assert.equal(windows.url,`${base}/syncro-0.2.20260808-windows-x64.zip`);
  assert.equal(windows.checksumUrl,`${base}/syncro-0.2.20260808-windows-x64.zip.sha256`);
  assert.match(windows.run,/syncro\.exe input\.nii\.gz results --threads 4/);
  const linux=release.targets['linux-x64'];
  assert.equal(linux.archiveName,'syncro-0.2.20260808-linux-x64.tar.gz');
  assert.equal(linux.checksumName,'syncro-0.2.20260808-linux-x64.tar.gz.sha256');
  assert.equal(linux.validationName,'syncro-0.2.20260808-linux-x64.tar.gz.validation.txt');
  assert.equal(linux.url,`${base}/syncro-0.2.20260808-linux-x64.tar.gz`);
  assert.equal(linux.checksumUrl,`${base}/syncro-0.2.20260808-linux-x64.tar.gz.sha256`);
  assert.match(linux.run,/syncro input\.nii\.gz results --threads 4/);
  assert.doesNotMatch(linux.run,/\.exe/);
});

test('the published release follows the package version',()=>{
  assert.equal(createSyncroRelease(packageJson.version).tag,`syncro-v${packageJson.version}`);
});

test('portable release rejects unsafe versions and app version drift',()=>{
  assert.throws(()=>createSyncroRelease('../latest'),/version/i);
  assert.equal(appPackage.version,packageJson.version);
});
