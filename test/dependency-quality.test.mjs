import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareFindings, dependencyFindings, dependencyGraph } from '@neurodesk/dependency-quality';

async function checkFixture(t, files, manifests = new Map(), runtimeContracts = []) {
  const root = await mkdtemp(join(tmpdir(), 'dependency-canary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return dependencyFindings(await dependencyGraph(root, Object.keys(files)), manifests, runtimeContracts);
}

const leaf = 'export const value = 1;\n';

test('shared production modules cannot import apps, but validation fixtures can', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/index.js': "import '../../../apps/example/src/index.js';\n",
    'packages/example/validation/check.mjs': "import '../../../apps/example/src/index.js';\n",
    'apps/example/src/index.js': leaf,
  });
  assert.equal(findings.filter(({ rule }) => rule === 'shared-to-app').length, 1);
  assert.equal(findings[0].from, 'packages/example/src/index.js');
});

test('an app cannot import another app, including through a worker URL', async (t) => {
  const findings = await checkFixture(t, {
    'apps/first/src/main.js': "new Worker(new URL('../../second/src/worker.js', import.meta.url));\n",
    'apps/second/src/worker.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'app-to-other-app'));
});

test('TypeScript and TSX imports are analyzed by the pinned parser', async (t) => {
  const findings = await checkFixture(t, {
    'apps/first/src/main.tsx': "import { value } from '../../second/src/model';\nconst element = <div>{value}</div>;\n",
    'apps/second/src/model.ts': 'export const value: number = 1;\n',
  });
  assert.ok(findings.some(({ rule }) => rule === 'app-to-other-app'));
});

test('volume and core helpers cannot acquire UI imports', async (t) => {
  const findings = await checkFixture(t, {
    'packages/components/src/volume/model.js': "import '../ui/widget.js';\n",
    'packages/components/src/core/dom.js': "import '../ui/widget.js';\n",
    'packages/components/src/ui/widget.js': leaf,
  });
  assert.equal(findings.filter(({ rule }) => rule === 'core-to-ui').length, 2);
});

test('browser paths cannot reach Node code through shared helpers', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../../../packages/example/src/index.js';\n",
    'packages/example/src/index.js': "import './node.js';\n",
    'packages/example/src/node.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule, from }) => rule === 'browser-to-node' && from === 'packages/example/src/index.js'));
});

test('Node entries cannot reach browser runtime or UI through shared helpers', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/node.js': "import './index.js';\n",
    'packages/example/src/index.js': "import '../../runtime-support/src/niimath/index.js';\n",
    'packages/runtime-support/src/niimath/index.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'node-to-browser'));
});

test('conditional NIfTI zlib fallback does not exempt other Node imports', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../../../packages/components/src/file-io/NiftiUtils.js';\n",
    'packages/components/src/file-io/NiftiUtils.js': "await import('node:zlib');\nawait import('node:fs');\n",
  });
  assert.deepEqual(findings.filter(({ rule }) => rule === 'browser-to-node').map(({ to }) => to), ['fs']);
});

test('undeclared runtime dependencies fail even when the root declares them', async (t) => {
  const findings = await checkFixture(t, {
    'package.json': JSON.stringify({ devDependencies: { 'some-root-tool': '1.0.0' } }),
    'node_modules/some-root-tool/package.json': JSON.stringify({ name: 'some-root-tool', main: 'index.js' }),
    'node_modules/some-root-tool/index.js': leaf,
    'packages/example/src/node.js': "import 'some-root-tool';\nimport.meta.resolve('runtime-assets/package.json');\n",
  }, new Map([['packages/example', { name: '@neurodesk/example' }]]));
  assert.deepEqual(findings.filter(({ rule }) => rule === 'undeclared-runtime').map(({ to }) => to), ['runtime-assets', 'some-root-tool']);
});

test('relative workspace imports require a declared runtime dependency', async (t) => {
  const files = {
    'packages/first/src/index.js': "import '../../second/src/index.js';\n",
    'packages/second/src/index.js': leaf,
  };
  const manifests = new Map([
    ['packages/first', { name: '@neurodesk/first' }],
    ['packages/second', { name: '@neurodesk/second' }],
  ]);
  const findings = await checkFixture(t, files, manifests);
  assert.ok(findings.some(({ rule, to }) => rule === 'undeclared-runtime' && to === '@neurodesk/second'));
  manifests.get('packages/first').dependencies = { '@neurodesk/second': 'workspace:*' };
  const declared = await checkFixture(t, files, manifests);
  assert.equal(declared.filter(({ rule }) => rule === 'undeclared-runtime').length, 0);
});

test('Vite asset queries resolve without hiding missing or undeclared assets', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import existing from './asset.wasm?url';\nimport missing from './missing.wasm?url';\n",
    'apps/example/src/asset.wasm': 'fixture',
  });
  assert.deepEqual(findings.filter(({ rule }) => rule === 'unresolved').map(({ to }) => to), ['./missing.wasm?url']);
});

test('cycles include worker URL edges and a new cycle cannot replace an old one', async (t) => {
  const old = await checkFixture(t, {
    'packages/example/src/a.js': "import './b.js';\n",
    'packages/example/src/b.js': "import './a.js';\n",
  });
  const changed = await checkFixture(t, {
    'packages/example/src/a.js': "new Worker(new URL('./c.js', import.meta.url));\n",
    'packages/example/src/c.js': "import './a.js';\n",
  });
  assert.equal(old.filter(({ rule }) => rule === 'cycle').length, 2);
  assert.equal(changed.filter(({ rule }) => rule === 'cycle').length, 2);
  const comparison = compareFindings(changed, old);
  assert.equal(comparison.added.length, 2);
  assert.equal(comparison.removed.length, 2);
});

test('malformed sources fail analysis rather than entering the baseline', async (t) => {
  await assert.rejects(checkFixture(t, { 'apps/example/src/main.ts': 'const = ;\n' }));
});


test('runtime staging exceptions apply only to the exact source and import', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import './staged.mjs';\nimport './missing.mjs';\n",
    'apps/example/src/other.js': "import './staged.mjs';\n",
  }, new Map(), [{ from: 'apps/example/src/main.js', to: './staged.mjs' }]);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'unresolved').map(({ from, to }) => [from, to]), [
    ['apps/example/src/main.js', './missing.mjs'],
    ['apps/example/src/other.js', './staged.mjs'],
  ]);
});

test('generated glue exceptions do not exempt nearby handwritten wrappers', async (t) => {
  const findings = await checkFixture(t, {
    'packages/runtime-support/src/niimath/niimath.js': "import 'node:fs';\n",
    'packages/runtime-support/src/niimath/niimath.js-wrapper.js': "import 'node:fs';\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'browser-to-node').length, 1);
  assert.equal(findings[0].from, 'packages/runtime-support/src/niimath/niimath.js-wrapper.js');
});

test('the desktop browser automation adapter runs in Node', async (t) => {
  const findings = await checkFixture(t, {
    'packages/desktop/src/main.js': "import './browser-automation.js';\n",
    'packages/desktop/src/browser-automation.js': "import 'node:fs';\n",
  });
  assert.equal(findings.length, 0);
});


test('production cannot evade runtime rules by importing test helpers', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../test/helper.js';\n",
    'apps/example/test/helper.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule }) => rule === 'runtime-to-tooling'));
});


test('application validation components are production code', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/components/validation/Editor.tsx': "import 'node:fs';\nexport const Editor = () => <div />;\n",
  });
  assert.ok(findings.some(({ rule }) => rule === 'browser-to-node'));
});


test('handwritten vendor modules cannot bypass package-to-app boundaries', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/index.js': "import '../../../apps/example/vendor/helper.js';\n",
    'apps/example/vendor/helper.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'shared-to-app'));
});

test('known staged mirrors follow canonical shared sources before build', async (t) => {
  const findings = await checkFixture(t, {
    'apps/calmar/web/js/main.js': "import '../vendor/webapp-components/src/volume/model.js';\n",
    'packages/components/src/volume/model.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule, from }) => rule === 'browser-to-node' && from === 'packages/components/src/volume/model.js'));
  assert.equal(findings.filter(({ rule }) => rule === 'unresolved').length, 0);
});


test('explicit type imports do not create runtime cycles', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import type { Shape } from './b';\nexport const value = 1;\n",
    'packages/example/src/b.ts': "import { value } from './a';\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 0);
});

test('mixed type and runtime imports still create runtime cycles', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import { type Shape, value } from './b';\nexport const other = 1;\n",
    'packages/example/src/b.ts': "import { other } from './a';\nexport const value = other;\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('a type import cannot hide a dynamic runtime import of the same module', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import type { Shape } from './b';\nexport const other = () => import('./b');\n",
    'packages/example/src/b.ts': "import { other } from './a';\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('Node builtin type imports do not enter the browser runtime graph', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.ts': "import type { Stats } from 'node:fs';\nexport interface File { stats: Stats }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'browser-to-node').length, 0);
});
