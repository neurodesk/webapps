import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import test from 'node:test';
import { resolveSiteFile } from '../validation/site-path.mjs';

for (const [name, paths, root, nested] of [
  ['POSIX', posix, '/build/seedseg/dist', '/build/seedseg/dist/js/app.js'],
  ['Windows', win32, 'D:\\build\\seedseg\\dist', 'D:\\build\\seedseg\\dist\\js\\app.js'],
]) {
  test(`${name} browser server accepts nested production assets and refuses escapes`, () => {
    assert.equal(resolveSiteFile(root, '/js/app.js', paths), nested);
    assert.equal(resolveSiteFile(root, '/', paths), paths.join(root, 'index.html'));
    assert.throws(() => resolveSiteFile(root, '/../secret.txt', paths), /Outside site/);
    assert.throws(() => resolveSiteFile(root, '/../dist-other/secret.txt', paths), /Outside site/);
    assert.throws(() => resolveSiteFile(root, '/js/../../secret.txt', paths), /Outside site/);
    if (name === 'Windows') {
      assert.throws(() => resolveSiteFile(root, '/..\\secret.txt', paths), /Outside site/);
    }
  });
}
