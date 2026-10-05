import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
globalThis.__SYNCRO_PACKAGE_VERSION__=packageJson.version;
const {configureNativeDownloads,syncroRelease}=await import('../src/native-release.js');

async function standaloneContent() {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  return new JSDOM(html).window.document.querySelector('#standaloneContent').content;
}

test('the Standalone dialog offers every release target with its own commands',async()=>{
  const root=await standaloneContent();
  configureNativeDownloads(root);
  const version=packageJson.version;
  const commands=system=>root.querySelector(`#native${system}Commands`).textContent.split('\n');
  for(const [system,archive] of [['Macos','macos-arm64.pkg'],['Windows','windows-x64.zip'],['Linux','linux-x64.tar.gz']]) {
    const link=root.querySelector(`#native${system}Download`);
    assert.equal(link.getAttribute('href'),`https://github.com/neurodesk/webapps/releases/download/syncro-v${version}/syncro-${version}-${archive}`);
    assert.equal(root.querySelector(`#native${system}Checksum`).getAttribute('href'),`${link.getAttribute('href')}.sha256`);
  }
  const pkg=`syncro-${version}-macos-arm64.pkg`;
  assert.deepEqual(commands('Macos').slice(2),[
    `shasum -a 256 -c ${pkg}.sha256`,
    `sudo installer -pkg ${pkg} -target /`,
    'syncro self-check',
    'syncro input.nii.gz results --threads 4',
  ]);
  assert.deepEqual(commands('Linux').slice(-2),[
    `./syncro-${version}-linux-x64/syncro self-check`,
    `./syncro-${version}-linux-x64/syncro input.nii.gz results --threads 4`,
  ]);
  assert.deepEqual(commands('Windows').slice(-2),[
    `.\\syncro-${version}-windows-x64\\syncro.exe self-check`,
    `.\\syncro-${version}-windows-x64\\syncro.exe input.nii.gz results --threads 4`,
  ]);
});

test('a release target without controls in the dialog fails loudly',async()=>{
  const root=await standaloneContent();
  root.querySelector('#nativeMacosCommands').remove();
  assert.throws(()=>configureNativeDownloads(root,syncroRelease),/nativeMacosCommands/);
});
