import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const page = await readFile(new URL('../site/404.html', import.meta.url), 'utf8');
const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');

function visit(route) {
  const location = new URL(route, 'https://webapps.neurodesk.org');
  let redirected;
  location.replace = value => { redirected = value; };
  vm.runInNewContext(inline, { location });
  return redirected;
}

for (const [route, expected] of [
  ['/dicom2vid', '/mri2vid'],
  ['/dicom2vid/', '/mri2vid/'],
  ['/dicom2vid/index.html?x=1#about', '/mri2vid/index.html?x=1#about'],
]) {
  test(`404 page sends ${route} to its renamed app`, () => {
    assert.equal(visit(route), expected);
  });
}

for (const route of ['/', '/missing', '/dicom2video/', '/mri2vid/missing', '/dicompare/schema']) {
  test(`404 page leaves ${route} alone`, () => {
    assert.equal(visit(route), undefined);
  });
}
