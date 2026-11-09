import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInstallationNotes } from '../../../scripts/desktop/release-notes.mjs';

const suite = { release: 'webapps', title: 'Neurodesk Webapps', executable: 'neurodesk-webapps' };
const base = 'https://github.com/neurodesk/webapps/releases/download/webapps-v0.6.20260916/';
const download = {
  version: '0.6.20260916', platform: 'windows-x64', kind: 'desktop',
  url: base + 'suite.zip.install.txt', sha256: 'a'.repeat(64),
  archiveFilename: 'suite.zip', archiveSha256: 'b'.repeat(64),
  parts: [{ url: base + 'suite.zip.part01' }, { url: base + 'suite.zip.part02' }],
};

test('multipart instructions download binary parts, join in order and verify the archive before extracting', () => {
  const notes = renderInstallationNotes([download], undefined, suite);
  assert.match(notes, /Invoke-WebRequest.*suite.zip.part01/);
  assert.match(notes, /copy \/b suite.zip.part01\+suite.zip.part02 suite.zip/);
  assert.match(notes, new RegExp('Get-FileHash.*' + download.archiveSha256));
  assert.doesNotMatch(notes, /install\.txt|aaaaaaaa/);
  assert.ok(notes.indexOf('Get-FileHash') < notes.indexOf('Expand-Archive'));
  assert.match(notes, /Start-Process/);
  assert.doesNotMatch(notes, /models included|without models/i);
});

test('single-file and Apptainer downloads need no concatenation or archive extraction', () => {
  const notes = renderInstallationNotes([{
    version: download.version, platform: 'linux-x64-apptainer', kind: 'container',
    url: base + 'suite.sif', sha256: 'c'.repeat(64),
  }], undefined, suite);
  assert.match(notes, /curl --fail --location --retry 3/);
  assert.match(notes, /sha256sum -c -/);
  assert.match(notes, /apptainer run 'suite.sif' --verify/);
  assert.match(notes, /keep the SIF for Apptainer/);
  assert.doesNotMatch(notes, /cat '|tar -x|unzip|Expand-Archive/);
});

test('the model pack is offered once for every platform and names the directory variable', () => {
  const notes = renderInstallationNotes([], {
    version: download.version, platform: 'any', kind: 'models',
    url: base + 'webapps-0.6.20260916-models.tar.gz.install.txt', sha256: 'd'.repeat(64),
    archiveFilename: 'webapps-0.6.20260916-models.tar.gz', archiveSha256: 'e'.repeat(64),
    parts: [{ url: base + 'webapps-0.6.20260916-models.tar.gz.part01' }, { url: base + 'webapps-0.6.20260916-models.tar.gz.part02' }],
  }, suite);
  assert.equal(notes.match(/Model pack/g).length, 1);
  assert.match(notes, /cat 'webapps-0.6.20260916-models.tar.gz.part01' 'webapps-0.6.20260916-models.tar.gz.part02' > 'webapps-0.6.20260916-models.tar.gz'/);
  assert.match(notes, /tar -xzf 'webapps-0.6.20260916-models.tar.gz' -C models/);
  assert.match(notes, /export NEURODESK_MODELS_DIR="\$PWD\/models"/);
  assert.match(notes, /\$env:NEURODESK_MODELS_DIR = \(Resolve-Path 'models'\).Path/);
  assert.match(notes, /copy \/b webapps-0.6.20260916-models.tar.gz.part01\+webapps-0.6.20260916-models.tar.gz.part02/);
  assert.match(notes, /bind-mounted read-only/);
});

test('installation notes omit the model pack when a suite has not published one', () => {
  assert.doesNotMatch(renderInstallationNotes([download], undefined, suite), /Model pack|NEURODESK_MODELS_DIR/);
});

test('an edition installs and launches its own application from folders named after its release', () => {
  const edition = { release: 'webapps-microscopy', title: 'Microscopy Webapps', executable: 'microscopy-webapps' };
  const url = 'https://github.com/neurodesk/webapps/releases/download/webapps-microscopy-v0.6.20260916/';
  const notes = renderInstallationNotes([
    { ...download, url: url + 'suite.zip.install.txt', parts: [{ url: url + 'suite.zip.part01' }, { url: url + 'suite.zip.part02' }] },
    { version: download.version, platform: 'macos-arm64', kind: 'desktop', url: url + 'mac.zip', sha256: 'f'.repeat(64) },
    { version: download.version, platform: 'linux-x64', kind: 'desktop', url: url + 'linux.tar.gz', sha256: 'f'.repeat(64) },
  ], { version: download.version, platform: 'any', kind: 'models', url: url + 'models.tar.gz', sha256: 'd'.repeat(64) }, edition);
  assert.match(notes, /New-Item -ItemType Directory -Path 'webapps-microscopy-0\.6\.20260916-windows-x64'/);
  assert.match(notes, /Start-Process '\.\\app\\microscopy-webapps\.exe'/);
  assert.match(notes, /open "\$HOME\/Applications\/microscopy-webapps\.app"/);
  assert.match(notes, /\.\/app\/microscopy-webapps\n/);
  assert.match(notes, /mkdir 'webapps-microscopy-0\.6\.20260916-models'/);
  assert.doesNotMatch(notes, /neurodesk-webapps|'webapps-0|SIF/);
});
