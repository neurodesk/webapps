import assert from 'node:assert/strict';
import test from 'node:test';
import { rankDuplicateGroups } from '../scripts/lib/duplicate-groups.mjs';

const file = (path, hash, size) => ({ path, hash, size });

test('duplicate groups rank by the bytes their extra copies cost', () => {
  const groups = rankDuplicateGroups([
    file('dist/b/big.wasm', 'big', 100),
    file('dist/a/big.wasm', 'big', 100),
    file('dist/a/small.js', 'small', 30),
    file('dist/b/small.js', 'small', 30),
    file('dist/c/small.js', 'small', 30),
    file('dist/a/unique.js', 'unique', 500),
  ]);
  assert.deepEqual(groups, [
    { wastedBytes: 100, copies: 2, sha256: 'big', size: 100, paths: ['dist/a/big.wasm', 'dist/b/big.wasm'] },
    { wastedBytes: 60, copies: 3, sha256: 'small', size: 30, paths: ['dist/a/small.js', 'dist/b/small.js', 'dist/c/small.js'] },
  ]);
});

test('copies a declared app-scoped family keeps do not count as waste', () => {
  const files = [
    file('dist/_runtime/ort/ort.mjs', 'ort', 40),
    file('dist/a/ort.mjs', 'ort', 40),
    file('dist/b/ort.mjs', 'ort', 40),
    file('dist/a/x.js', 'x', 10),
    file('dist/b/x.js', 'x', 10),
  ];
  const declaredPaths = new Set(['dist/a/ort.mjs', 'dist/b/ort.mjs']);
  assert.deepEqual(rankDuplicateGroups(files, { declaredPaths }).map(group => group.sha256), ['x']);
  assert.equal(rankDuplicateGroups(files, { declaredPaths: new Set(['dist/a/ort.mjs']) })[0].wastedBytes, 40);
});

test('the listing stops at its limit', () => {
  const files = [];
  for (let index = 0; index < 5; index += 1) {
    files.push(file(`dist/a/${index}`, `h${index}`, index + 1));
    files.push(file(`dist/b/${index}`, `h${index}`, index + 1));
  }
  assert.deepEqual(rankDuplicateGroups(files, { limit: 2 }).map(group => group.wastedBytes), [5, 4]);
});
