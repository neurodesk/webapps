import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

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

async function loadGhAwActionsLockVersions() {
  const versions = new Map();
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
    assert.ok(!existing || existing === major, `conflicting actions-lock.json majors for ${key}: ${existing} vs ${major}`);
    versions.set(key, major);
  }
  return versions;
}

test('active workflows use Node 24 action runtimes', async () => {
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) =>
    name.endsWith('.yml') || name.endsWith('.yaml')
  );
  const lockVersions = await loadGhAwActionsLockVersions();
  const seen = new Set();

  for (const workflowName of workflowNames) {
    const workflow = await readFile(new URL(workflowName, workflowsDirectory), 'utf8');
    const isGhAwLock = workflowName.endsWith('.lock.yml') && workflow.startsWith('# gh-aw-metadata:');
    const matches = [...workflow.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)(?:[ \t]+#[ \t]*(v\d+)(?:\.\d+)*)?/g)];
    const fileShaVersions = new Map();
    if (isGhAwLock) {
      for (const [, action, ref, pinnedVersion] of matches) {
        if (!pinnedVersion || !FULL_SHA.test(ref)) continue;
        const key = `${action}@${ref.toLowerCase()}`;
        const existing = fileShaVersions.get(key);
        assert.ok(!existing || existing === pinnedVersion, `${workflowName} has conflicting major comments for ${key}`);
        fileShaVersions.set(key, pinnedVersion);
      }
    }

    // Accept `action@vN` and commit pins written as `action@<sha> # vN` (plus bare 40-hex SHAs
    // emitted by gh-aw in verified `.lock.yml` files when `.github/aw/actions-lock.json` or another
    // commented pin in the same lockfile unambiguously identifies the major version).
    for (const [, action, ref, pinnedVersion] of matches) {
      const key = `${action}@${ref.toLowerCase()}`;
      const resolvedShaVersion = isGhAwLock && FULL_SHA.test(ref)
        ? (fileShaVersions.get(key) || lockVersions.get(key))
        : undefined;
      const version = pinnedVersion || resolvedShaVersion || ref;
      const expectedVersion = node24Actions.get(action);
      if (!expectedVersion) continue;
      seen.add(action);
      assert.equal(
        version,
        expectedVersion,
        `${workflowName} must use ${action}@${expectedVersion}`,
      );
    }
  }

  assert.deepEqual(seen, new Set(node24Actions.keys()));
});
