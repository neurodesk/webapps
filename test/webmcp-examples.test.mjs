import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { auditAppExamples } from '../scripts/lib/webmcp-examples.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { readFile } from 'node:fs/promises';

test('every example reaches a browser agent, or examples.json says why it cannot', async () => {
  const apps = (await readdir(join(repoRoot, 'apps'))).sort();
  assert.ok(apps.length >= 60);
  for (const app of apps) {
    const { problems } = await auditAppExamples(app);
    assert.deepEqual(problems, [], `${app}: run node scripts/webmcp-examples.mjs`);
  }
});

test('an example file role the contract does not declare is a problem until it is mapped or explained', async t => {
  const root = join(process.env.TMPDIR ?? repoRoot, `webmcp-examples-${process.pid}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/demo'), { recursive: true });
  await writeFile(join(root, 'apps/demo/automation.json'), JSON.stringify({ operations: { run: { inputs: { images: { source: 'files' } }, parameters: {} } } }));
  const write = (automation) => writeFile(join(root, 'apps/demo/examples.json'), JSON.stringify([{ id: 'head', files: [{ role: 'image', name: 'head.nii' }, { role: 'metadata', name: 'head.json' }], ...(automation && { automation }) }]));
  await write();
  assert.match((await auditAppExamples('demo', root)).problems[0], /file role image is not a file input/);
  await write({ roles: { image: 'images', metadata: null } });
  assert.match((await auditAppExamples('demo', root)).problems[0], /left out without automation.reason/);
  await write({ roles: { image: 'images', metadata: null }, reason: 'The sidecar holds nothing the run reads.' });
  assert.deepEqual(await auditAppExamples('demo', root), { app: 'demo', problems: [], examples: [{ id: 'head', loads: 1, of: 2, operation: 'run', omitted: 'The sidecar holds nothing the run reads.' }] });
  await write({ roles: { image: 'images', metadata: null }, reason: 'Unused.', parameters: { sigma: 2 } });
  assert.match((await auditAppExamples('demo', root)).problems[0], /automation.parameters names sigma, which no operation takes/);
  await write({ unavailable: 'It needs a server.' });
  assert.deepEqual((await auditAppExamples('demo', root)).examples, [{ id: 'head', unavailable: 'It needs a server.' }]);
});

test('an example must give every parameter its operation requires, and translate the page\'s own parameter names', async t => {
  const root = join(process.env.TMPDIR ?? repoRoot, `webmcp-required-${process.pid}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/demo'), { recursive: true });
  await writeFile(join(root, 'apps/demo/automation.json'), JSON.stringify({ defaultOperation: 'correct', operations: { correct: {
    inputs: { uni: { source: 'files', minimum: 1 } },
    parameters: { mp2rage: { type: 'array', items: { type: 'number' }, required: true }, b1Type: { type: 'string' } },
  } } }));
  const write = (fields) => writeFile(join(root, 'apps/demo/examples.json'), JSON.stringify([{ id: 'brain', files: [{ role: 'uni', name: 'uni.nii' }], ...fields }]));
  await write({ parameters: { mp: { tr: 6 } } });
  assert.deepEqual((await auditAppExamples('demo', root)).problems.slice(0, 2), [
    'brain: its parameters mp name no contract parameter; translate them in automation.parameters',
    'brain: correct requires mp2rage, which the example does not give',
  ]);
  await write({ parameters: { mp: { tr: 6 } }, automation: { parameters: { mp2rage: [6], b1Type: 'relative' } } });
  const audit = await auditAppExamples('demo', root);
  assert.deepEqual(audit.problems, []);
  assert.deepEqual(audit.examples[0].parameters, { mp2rage: [6], b1Type: 'relative' });
  assert.equal(audit.examples[0].operation, 'correct');
});

test('every app the full-run smoke may leave unrun is a registered app with the reason it cannot run here', async () => {
  const skips = JSON.parse(await readFile(join(repoRoot, 'test/webmcp-run-skips.json'), 'utf8'));
  const ids = new Set((await loadAppsRegistry()).apps.map(app => app.id));
  for (const [app, { expect, error, reason, ...rest }] of Object.entries(skips)) {
    assert.ok(ids.has(app), `${app} is a registered app`);
    assert.ok(['timed out', 'run failed', 'no loadable example'].includes(expect), `${app} names the outcome it expects`);
    assert.equal(error === undefined, expect !== 'run failed', `${app}: a failed run names the error it expects, and only a failed run`);
    if (error !== undefined) assert.doesNotThrow(() => new RegExp(error, 'i'));
    assert.ok(typeof reason === 'string' && reason.trim().length > 20, `${app} says why its example cannot run here`);
    assert.deepEqual(rest, {}, `${app} has no other fields`);
  }
});
