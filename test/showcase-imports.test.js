import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as publicApi from '../src/index.js';

test('showcase imports only public API exports', async () => {
  const source = await readFile('web/js/showcase.js', 'utf8');
  const match = source.match(/import\s+\{([\s\S]*?)\}\s+from\s+['"]\.\.\/\.\.\/src\/index\.js['"]/);
  assert.ok(match, 'showcase should import public components from src/index.js');
  const names = match[1]
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => name.split(/\s+as\s+/).pop().trim());
  for (const name of names) {
    assert.ok(name in publicApi, `${name} must be exported from src/index.js`);
  }
});
