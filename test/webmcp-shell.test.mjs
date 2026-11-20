import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleClosure } from '../scripts/lib/module-closure.mjs';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { SHELL_COMPONENTS } from '../scripts/lib/standalone.mjs';

const src = 'packages/components/src/';

test('the automation barrel reaches no browser UI or WebMCP module, so command lines stay off them', () => {
  const closure = moduleClosure(repoRoot, [`${src}automation/index.js`]);
  const reached = closure.filter(file => !file.startsWith(`${src}automation/`) && !file.startsWith(`${src}file-io/`));
  assert.deepEqual(reached, []);
});

test('every module the shell copies finds the modules it imports beside it', () => {
  const modules = SHELL_COMPONENTS.filter(name => name.endsWith('.js'));
  const closure = moduleClosure(repoRoot, modules.map(name => `${src}${name}`)).map(file => file.slice(src.length));
  assert.deepEqual(closure.filter(name => !SHELL_COMPONENTS.includes(name)), []);
});
