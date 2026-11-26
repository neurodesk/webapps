import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url);
const actionsLockPath = new URL('../.github/aw/actions-lock.json', import.meta.url);
const FULL_SHA = /^[0-9a-f]{40}$/i;

const node24Actions = new Map([
  ['actions/cache', 'v6'],
  ['actions/checkout', 'v7'],
  ['actions/configure-pages', 'v6'],
  ['actions/deploy-pages', 'v5'],
  ['actions/setup-node', 'v7'],
  ['actions/setup-python', 'v7'],
  ['actions/upload-artifact', 'v7'],
  ['actions/download-artifact', 'v8'],
  ['actions/upload-pages-artifact', 'v5'],
  ['pnpm/action-setup', 'v6'],
]);

// Reviewed Node 24 action SHAs built into gh-aw v1.2.2 (which are not emitted into .github/aw/actions-lock.json).
const REVIEWED_GH_AW_BUILTIN_SHAS = new Map([
  ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7'],
  ['actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7'],
  ['actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'v7'],
  ['actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333', 'v8'],
]);

async function loadReviewedActionShaVersions() {
  const versions = new Map(REVIEWED_GH_AW_BUILTIN_SHAS);
  let lock;
  try {
    lock = JSON.parse(await readFile(actionsLockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return versions;
    throw error;
  }
  for (const entry of Object.values(lock?.entries ?? {})) {
    if (!entry || typeof entry.repo !== 'string' || typeof entry.sha !== 'string' || typeof entry.version !== 'string') continue;
    const major = entry.version.match(/^(v\d+)(?:\.|$)/)?.[1];
    if (!major || !FULL_SHA.test(entry.sha)) continue;
    const key = `${entry.repo}@${entry.sha.toLowerCase()}`;
    const existing = versions.get(key);
    assert.ok(!existing || existing === major, `conflicting reviewed majors for ${key}: ${existing} vs ${major}`);
    versions.set(key, major);
  }
  return versions;
}

function collectExecutableUses(workflowName, workflowText) {
  const doc = YAML.parseDocument(workflowText);
  const flow = doc.toJS();
  const usesEntries = [];
  const jobsNode = doc.get('jobs', true);
  if (!jobsNode || typeof flow?.jobs !== 'object') return usesEntries;

  for (const [jobId, job] of Object.entries(flow.jobs ?? {})) {
    if (typeof job?.uses === 'string') {
      const node = doc.getIn(['jobs', jobId, 'uses'], true);
      usesEntries.push({ uses: job.uses, comment: node?.comment ?? '' });
    }
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (typeof step?.uses === 'string') {
        const node = doc.getIn(['jobs', jobId, 'steps', i, 'uses'], true);
        usesEntries.push({ uses: step.uses, comment: node?.comment ?? '' });
      }
    }
  }
  return usesEntries;
}

function validateWorkflowRuntimes(workflowEntries, reviewedShaVersions) {
  const seen = new Set();
  for (const { workflowName, workflowText } of workflowEntries) {
    const isGhAwLock = workflowName.endsWith('.lock.yml') && workflowText.startsWith('# gh-aw-metadata:');
    for (const { uses, comment } of collectExecutableUses(workflowName, workflowText)) {
      const atIndex = uses.lastIndexOf('@');
      if (atIndex <= 0) continue;
      const action = uses.slice(0, atIndex);
      const ref = uses.slice(atIndex + 1);
      const expectedVersion = node24Actions.get(action);
      if (!expectedVersion) continue;
      seen.add(action);

      const inlineMajor = comment.trim().match(/^(v\d+)(?:\.\d+)*\b/)?.[1];
      let resolvedVersion;

      if (FULL_SHA.test(ref)) {
        const key = `${action}@${ref.toLowerCase()}`;
        const reviewedMajor = reviewedShaVersions.get(key);
        if (isGhAwLock) {
          assert.ok(
            reviewedMajor,
            `${workflowName} uses unreviewed SHA pin ${key} (must be recorded in .github/aw/actions-lock.json or REVIEWED_GH_AW_BUILTIN_SHAS)`,
          );
          if (inlineMajor) {
            assert.equal(
              inlineMajor,
              reviewedMajor,
              `${workflowName} inline comment # ${inlineMajor} disagrees with reviewed metadata ${reviewedMajor} for ${key}`,
            );
          }
          resolvedVersion = reviewedMajor;
        } else {
          if (reviewedMajor && inlineMajor) {
            assert.equal(
              inlineMajor,
              reviewedMajor,
              `${workflowName} inline comment # ${inlineMajor} disagrees with reviewed metadata ${reviewedMajor} for ${key}`,
            );
          }
          resolvedVersion = reviewedMajor || inlineMajor || ref;
        }
      } else {
        resolvedVersion = ref;
      }

      assert.equal(
        resolvedVersion,
        expectedVersion,
        `${workflowName} must use ${action}@${expectedVersion}`,
      );
    }
  }
  return seen;
}

test('active workflows use Node 24 action runtimes', async () => {
  const workflowNames = (await readdir(workflowsDirectory))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const reviewedShaVersions = await loadReviewedActionShaVersions();
  const entries = await Promise.all(
    workflowNames.map(async (workflowName) => ({
      workflowName,
      workflowText: await readFile(new URL(workflowName, workflowsDirectory), 'utf8'),
    })),
  );

  const seen = validateWorkflowRuntimes(entries, reviewedShaVersions);
  assert.deepEqual(seen, new Set(node24Actions.keys()));
});

test('runtime validator catches quoted YAML uses keys, unreviewed lockfile SHAs, and conflicting comments', () => {
  const reviewed = new Map([
    ['pnpm/action-setup@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'v5'],
    ['pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115', 'v6'],
  ]);

  // Quoted YAML `uses` key with outdated runtime is caught.
  assert.throws(
    () => validateWorkflowRuntimes([{
      workflowName: 'quoted.yml',
      workflowText: 'jobs:\n  build:\n    steps:\n      - "uses": actions/checkout@v4\n',
    }], reviewed),
    /quoted\.yml must use actions\/checkout@v7/,
  );

  // Same-file comment cannot certify an unreviewed bare SHA in a .lock.yml.
  assert.throws(
    () => validateWorkflowRuntimes([{
      workflowName: 'fake.lock.yml',
      workflowText: [
        '# gh-aw-metadata: {"strict":true}',
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: pnpm/action-setup@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v6',
        '      - uses: pnpm/action-setup@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ].join('\n'),
    }], reviewed),
    /unreviewed SHA pin pnpm\/action-setup@b{40}/,
  );

  // Comment claiming v6 cannot override reviewed lock metadata saying v5.
  assert.throws(
    () => validateWorkflowRuntimes([{
      workflowName: 'conflict.lock.yml',
      workflowText: [
        '# gh-aw-metadata: {"strict":true}',
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: pnpm/action-setup@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v6',
      ].join('\n'),
    }], reviewed),
    /disagrees with reviewed metadata v5/,
  );
});
