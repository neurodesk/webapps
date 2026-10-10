import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the production CLI bundles workspace helpers without adding browser runtime dependencies', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'syncro-build-closure-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const prefix = join(scratch, 'graph');
  execFileSync(process.execPath, [root + 'scripts/build.mjs', '--metafile', prefix, '--outdir', join(scratch, 'dist')], { cwd: root });
  const graph = JSON.parse(await readFile(prefix + '-node.json', 'utf8'));
  const inputs = Object.keys(graph.inputs);
  for (const owner of ['synthsr', 'synthstrip', 'registration']) {
    assert.ok(inputs.some((path) => path.includes(`/${owner}/src/`)), `${owner} helpers must be bundled`);
  }
  const external = [...new Set(Object.values(graph.outputs).flatMap(({ imports }) =>
    imports.filter(({ external }) => external).map(({ path }) => path)).filter((path) => !isBuiltin(path)))].sort();
  assert.deepEqual(external, ['nifti-reader-js', 'onnxruntime-node']);
  const manifest = JSON.parse(await readFile(root + 'package.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), external);
  const browserInputs = inputs.filter((path) => /runtime-support|onnxruntime-web|components\/src\/(ui|viewer|elements)/.test(path));
  assert.deepEqual(browserInputs, [], 'Portable CLI must not bundle browser runtimes or UI');
});
