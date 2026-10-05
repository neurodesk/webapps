import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createSyncroRelease} from '../release.mjs';

const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
const appPackage=JSON.parse(await readFile(new URL('../../../apps/syncro/package.json',import.meta.url)));

test('portable release names and commands derive from the package version',()=>{
  const release=createSyncroRelease(packageJson.version);
  assert.equal(release.tag,`syncro-v${packageJson.version}`);
  assert.deepEqual(Object.keys(release.targets),['windows-x64','linux-x64','macos-arm64']);
  assert.equal(release.targets['windows-x64'].archiveName,`syncro-${packageJson.version}-windows-x64.zip`);
  assert.equal(release.targets['linux-x64'].archiveName,`syncro-${packageJson.version}-linux-x64.tar.gz`);
  assert.equal(release.targets['macos-arm64'].archiveName,`syncro-${packageJson.version}-macos-arm64.pkg`);
  for(const target of Object.values(release.targets)) {
    assert.equal(target.checksumName,`${target.archiveName}.sha256`);
    assert.equal(target.validationName,`${target.archiveName}.validation.txt`);
    assert.equal(target.url,`https://github.com/neurodesk/webapps/releases/download/${release.tag}/${target.archiveName}`);
    assert.equal(target.checksumUrl,`${target.url}.sha256`);
    assert.match(target.run,/syncro(?:\.exe)? input\.nii\.gz results --threads 4/);
  }
});

test('the macOS installer puts syncro on PATH instead of in an extracted directory',()=>{
  const target=createSyncroRelease(packageJson.version).targets['macos-arm64'];
  assert.equal(target.setup.at(-1),`sudo installer -pkg ${target.archiveName} -target /`);
  assert.ok(target.setup.includes(`shasum -a 256 -c ${target.checksumName}`));
  assert.equal(target.selfCheck,'syncro self-check');
  assert.equal(target.run,'syncro input.nii.gz results --threads 4');
});

test('a release target with an unknown archive kind is rejected',()=>{
  const spec={tagPrefix:'syncro-v',repository:'neurodesk/webapps',run:'in out',targets:{'linux-x64':{label:'Linux',archive:'rar',executable:'syncro'}}};
  assert.throws(()=>createSyncroRelease(packageJson.version,spec),/archive/);
});

test('portable release rejects unsafe versions and app version drift',()=>{
  assert.throws(()=>createSyncroRelease('../latest'),/version/i);
  assert.equal(appPackage.version,packageJson.version);
});
