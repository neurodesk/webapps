import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import YAML from 'yaml';

test('KB sync checks both evidence levels and validates before publishing', async () => {
  const source = await readFile(new URL('../.github/workflows/calmar-kb-sync.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source);
  assert.equal(workflow.on.schedule[0].cron, '23 * * * *');
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.jobs.sync.if, "github.repository == 'micmas/webapps'");
  const steps = workflow.jobs.sync.steps;
  const named = name => steps.find(step => step.name === name);
  const check = named('Check the latest KB revision').run;
  assert.match(check, /'aphasia-kb', 'aphasia-kb-drafts'/);
  assert.match(check, /kbSourceCommit/);
  const imported = named('Import both evidence levels from the recorded revision').run;
  assert.match(imported, /checkout --detach "\$SOURCE_SHA"/);
  assert.match(imported, /sync_kb.py .* --both/);
  const validation = steps.indexOf(named('Validate the exported evidence and Python/JavaScript parity'));
  const publish = steps.indexOf(named('Commit the tested snapshot to main'));
  assert.ok(validation < publish);
  assert.match(steps[validation].run, /test:manifest-checksums/);
  assert.match(steps[validation].run, /kb-evidence.test.js/);
  assert.match(named('Version only this KB update').run, /pnpm release --same-day/);
  assert.match(named('Version only this KB update').run, /trap .*EXIT/);
  assert.match(steps[publish].run, /git push origin HEAD:main/);
  assert.doesNotMatch(steps[publish].run, /--force/);
  for (const step of steps.filter(step => step.run && steps.indexOf(step) > 3)) {
    assert.equal(step.if, "steps.source.outputs.changed == 'true'");
  }
});
