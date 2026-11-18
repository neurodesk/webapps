import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { auditAppExamples } from '../scripts/lib/webmcp-examples.mjs';

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
  assert.deepEqual(await auditAppExamples('demo', root), { app: 'demo', problems: [], examples: [{ id: 'head', loads: 1, of: 2, omitted: 'The sidecar holds nothing the run reads.' }] });
  await write({ roles: { image: 'images', metadata: null }, reason: 'Unused.', parameters: { sigma: 2 } });
  assert.match((await auditAppExamples('demo', root)).problems[0], /automation.parameters names sigma, which no operation takes/);
  await write({ unavailable: 'It needs a server.' });
  assert.deepEqual((await auditAppExamples('demo', root)).examples, [{ id: 'head', unavailable: 'It needs a server.' }]);
});
