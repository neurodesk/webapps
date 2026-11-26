import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  DEFAULT_BEADS_REF,
  readBeadsFromRef,
  syncBeadsRef,
} from '../scripts/lib/beads.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';
import {
  DEFAULT_TRIAGE_ACTOR,
  UNUSED_CODE_ITEM_TYPE,
  applyUnusedCodeSafeOutputs,
  discoverFirstPartyApps,
  formatSafeOutputsSummary,
  parseAgentOutput,
  translateUnusedCodeItems,
} from '../scripts/lib/beads-safe-outputs.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'apply-beads-safe-outputs.mjs');

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function configureGitIdentity(cwd) {
  runGit(cwd, ['config', 'user.name', 'Test User']);
  runGit(cwd, ['config', 'user.email', 'test@example.com']);
}

function createFixtureRepo(t) {
  const scratchRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'beads-safe-outputs-'));
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

  const remoteDir = join(scratchRoot, 'remote.git');
  const workDir = join(scratchRoot, 'work');
  const outsideFile = join(scratchRoot, 'outside.txt');
  writeFileSync(outsideFile, 'secret\n', 'utf8');

  runGit(scratchRoot, ['init', '--bare', remoteDir]);
  runGit(scratchRoot, ['clone', remoteDir, workDir]);
  configureGitIdentity(workDir);

  mkdirSync(join(workDir, 'apps', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'apps', 'beta', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'apps', 'upstreamapp', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'packages', 'shared', 'src'), { recursive: true });

  writeFileSync(join(workDir, 'apps', 'alpha', 'src', 'unused.js'), 'export const dead = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'alpha', 'src', 'other.js'), 'export const two = 2;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'beta', 'src', 'unused.js'), 'export const b = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'upstreamapp', 'src', 'unused.js'), 'export const u = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'upstreamapp', 'upstream.json'), '{"repo":"example/upstream"}\n', 'utf8');
  writeFileSync(join(workDir, 'packages', 'shared', 'src', 'index.js'), 'export const s = 1;\n', 'utf8');
  symlinkSync(outsideFile, join(workDir, 'apps', 'alpha', 'src', 'escape.js'));

  runGit(workDir, ['add', '.']);
  runGit(workDir, ['commit', '-m', 'init fixture']);
  runGit(workDir, ['push', '-u', 'origin', 'HEAD']);

  const verifyDir = join(scratchRoot, 'verify');
  runGit(scratchRoot, ['clone', remoteDir, verifyDir]);
  configureGitIdentity(verifyDir);

  return {
    scratchRoot,
    remoteDir,
    workDir,
    verifyDir,
    allowedApps: new Set(['alpha', 'beta']),
  };
}

test('discoverFirstPartyApps includes registered first-party apps and excludes upstream-tracked apps', async () => {
  const apps = await discoverFirstPartyApps(REPO_ROOT);
  assert.ok(apps.has('topofit'), 'first-party app topofit should be included');
  assert.ok(apps.has('syncro'), 'first-party app syncro should be included');
  assert.ok(!apps.has('qsmbly'), 'upstream app qsmbly must be excluded');
  assert.ok(!apps.has('seedseg'), 'upstream app seedseg must be excluded');
  assert.ok(!apps.has('dicompare'), 'upstream app dicompare must be excluded');
});

test('parseAgentOutput validates top-level structure and filters by item type', () => {
  assert.throws(() => parseAgentOutput(null), /must be an object/);
  assert.throws(() => parseAgentOutput([]), /must be an object/);
  assert.throws(() => parseAgentOutput({}), /missing an "items" array/);

  const parsed = parseAgentOutput({
    items: [
      { type: 'noop', message: 'nothing' },
      { type: UNUSED_CODE_ITEM_TYPE, app: 'alpha' },
      null,
      'noise',
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].app, 'alpha');
});

test('translateUnusedCodeItems enforces single-app containment, file existence, and bounds', (t) => {
  const { workDir, allowedApps } = createFixtureRepo(t);
  const validItem = {
    type: UNUSED_CODE_ITEM_TYPE,
    app: 'alpha',
    dedupe_key: 'knip:apps/alpha/src/unused.js:dead',
    title: 'Remove unused export dead in alpha',
    summary: 'Confirmed via rg that dead is never imported inside apps/alpha.',
    evidence: 'apps/alpha/src/unused.js, quality-artifacts/unused-code/knip.json',
    priority: '2',
    note: 'Checked imports across apps/alpha/src',
  };

  const { operations, skipped } = translateUnusedCodeItems([
    validItem,
    // Duplicate key in same batch
    { ...validItem },
    // Valid item with colon in symbol name and numeric expected_revision
    {
      ...validItem,
      dedupe_key: 'knip:apps/alpha/src/other.js:ns:two',
      evidence: 'apps/alpha/src/other.js',
      priority: 3,
      expected_revision: 1,
    },
    // Upstream / unregistered app
    { ...validItem, app: 'upstreamapp', dedupe_key: 'knip:apps/upstreamapp/src/unused.js:u', evidence: 'apps/upstreamapp/src/unused.js' },
    // Cross-app dedupe_key spoofing
    { ...validItem, app: 'alpha', dedupe_key: 'knip:apps/beta/src/unused.js:b', evidence: 'apps/alpha/src/unused.js' },
    // Symlink escape outside apps/alpha/
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/escape.js:leak', evidence: 'apps/alpha/src/escape.js' },
    // Directory instead of file
    { ...validItem, dedupe_key: 'knip:apps/alpha/src:dir', evidence: 'apps/alpha/src' },
    // Nonexistent file
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/missing.js:x', evidence: 'apps/alpha/src/missing.js' },
    // Evidence citing only knip.json without any file under apps/alpha/
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:onlyknip', evidence: 'quality-artifacts/unused-code/knip.json' },
    // Out-of-range priority
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:badprio', priority: 0 },
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:floatprio', priority: 2.5 },
    // Shared package path in evidence
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:shared', evidence: 'apps/alpha/src/other.js, packages/shared/src/index.js' },
  ], { cwd: workDir, allowedApps });

  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0].scope, { type: 'app', targets: ['alpha'] });
  assert.deepEqual(operations[0].links.evidence, ['apps/alpha/src/unused.js', 'quality-artifacts/unused-code/knip.json']);
  assert.equal(operations[0].priority, 2);
  assert.equal(operations[1].expectedRevision, 1);
  assert.equal(operations[1].priority, 3);

  assert.equal(skipped.length, 10);
  assert.match(skipped[0].reason, /duplicate dedupe_key/);
  assert.match(skipped[1].reason, /not a registered first-party/);
  assert.match(skipped[2].reason, /must start with "knip:apps\/alpha\/"/);
  assert.match(skipped[3].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[4].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[5].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[6].reason, /must include at least one file under apps\/alpha/);
  assert.match(skipped[7].reason, /priority must be an integer/);
  assert.match(skipped[8].reason, /priority must be an integer/);
  assert.match(skipped[9].reason, /must stay under apps\/alpha/);
});

test('applyUnusedCodeSafeOutputs supports staged preview, live remote push, idempotent replay, and atomic limits', async (t) => {
  const { workDir, remoteDir, verifyDir, allowedApps } = createFixtureRepo(t);
  const rawOutput = {
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/unused.js:dead',
        title: 'Remove unused export dead in alpha',
        summary: 'Verified unused export in apps/alpha/src/unused.js.',
        evidence: 'apps/alpha/src/unused.js',
        priority: 2,
      },
      // Invalid item mixed into the same batch must be skipped without aborting valid items
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'upstreamapp',
        dedupe_key: 'knip:apps/upstreamapp/src/unused.js:u',
        title: 'Should be skipped',
        summary: 'Upstream app must be skipped.',
        evidence: 'apps/upstreamapp/src/unused.js',
      },
    ],
  };

  // Empty/noop output
  const noopResult = await applyUnusedCodeSafeOutputs({ items: [{ type: 'noop' }] }, { cwd: workDir, allowedApps });
  assert.equal(noopResult.status, 'skipped');
  assert.equal(noopResult.pushed, false);

  // Staged / dry-run preview writes nothing locally or remotely
  const dryResult = await applyUnusedCodeSafeOutputs(rawOutput, {
    cwd: workDir,
    allowedApps,
    dryRun: true,
    now: new Date('2026-11-26T08:00:00Z'),
  });
  assert.equal(dryResult.status, 'skipped');
  assert.equal(dryResult.staged, true);
  assert.equal(dryResult.pushed, false);
  assert.equal(dryResult.createdIds.length, 1);
  assert.equal(dryResult.skipped.length, 1);
  assert.equal(runGit(remoteDir, ['for-each-ref', DEFAULT_BEADS_REF]).trim(), '', 'dry-run must not push to remote');

  // Live write commits and pushes to bare remote refs/heads/memory/beads
  const liveResult = await applyUnusedCodeSafeOutputs(rawOutput, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:01:00Z'),
  });
  assert.equal(liveResult.status, 'success');
  assert.equal(liveResult.staged, false);
  assert.equal(liveResult.pushed, true);
  assert.equal(liveResult.createdIds.length, 1);
  assert.equal(liveResult.skipped.length, 1);

  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  const remoteTree = readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF);
  assert.equal(remoteTree.sha, liveResult.commitSha);
  assert.equal(remoteTree.beads.size, 1);
  const created = remoteTree.beads.get(liveResult.createdIds[0]);
  assert.equal(created.journal[0].actor, DEFAULT_TRIAGE_ACTOR);
  assert.deepEqual(created.scope, { type: 'app', targets: ['alpha'] });

  // Idempotent replay with expected_revision produces untouchedIds and skips remote push
  const replayOutput = {
    items: [
      {
        ...rawOutput.items[0],
        expected_revision: created.revision,
      },
    ],
  };
  const replayResult = await applyUnusedCodeSafeOutputs(replayOutput, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:02:00Z'),
  });
  assert.equal(replayResult.status, 'success');
  assert.equal(replayResult.pushed, false);
  assert.deepEqual(replayResult.untouchedIds, [created.id]);

  // All-invalid batch rejects without touching remote
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs({ items: [rawOutput.items[1]] }, { cwd: workDir, allowedApps }),
    /All 1 upsert_unused_code_bead item\(s\) failed validation/,
  );

  // Exceeding maxCreates rejects atomically without writing
  const tooMany = {
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:sym1',
        title: 'Unused sym1',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:sym2',
        title: 'Unused sym2',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
    ],
  };
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs(tooMany, { cwd: workDir, allowedApps, maxCreates: 1 }),
    /maxCreates/,
  );
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  assert.equal(readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF).beads.size, 1);
});

test('apply-beads-safe-outputs CLI honors env vars, writes step summary/outputs, and sanitizes annotations', (t) => {
  const scratchRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'beads-safe-cli-'));
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

  const inputFile = join(scratchRoot, 'agent_output.json');
  const summaryFile = join(scratchRoot, 'summary.md');
  const outputFile = join(scratchRoot, 'github_output.txt');

  writeFileSync(inputFile, JSON.stringify({
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'topofit',
        dedupe_key: 'knip:apps/topofit/package.json:unused-demo',
        title: 'Remove unused dependency demo in topofit',
        summary: 'Verified unused in apps/topofit.',
        evidence: 'apps/topofit/package.json',
      },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'qsmbly',
        dedupe_key: 'knip:apps/qsmbly/package.json:bad\n::error::injected%0A',
        title: 'Should be skipped',
        summary: 'Upstream app.',
        evidence: 'apps/qsmbly/package.json',
      },
    ],
  }), 'utf8');

  const res = execFileSync(process.execPath, [CLI_PATH, '--no-sync', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_AW_AGENT_OUTPUT: inputFile,
      GH_AW_SAFE_OUTPUTS_STAGED: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKFLOW: 'unused-code-triage',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(res);
  assert.equal(parsed.status, 'skipped');
  assert.equal(parsed.staged, true);
  assert.equal(parsed.createdIds.length, 1);
  assert.equal(parsed.skipped.length, 1);

  const summary = readFileSync(summaryFile, 'utf8');
  assert.match(summary, /staged preview \(no writes\)/);
  assert.match(summary, /Skipped invalid items:\*\* 1/);
  assert.ok(!summary.includes('\n::error::'), 'summary must not contain injected lines');

  const outputs = readFileSync(outputFile, 'utf8');
  assert.match(outputs, /^status=skipped$/m);
  assert.match(outputs, /^created_count=1$/m);
  assert.match(outputs, /^skipped_count=1$/m);
  assert.match(outputs, /^pushed=false$/m);

  // formatSafeOutputsSummary sanitizes backticks and newlines in skipped items
  const formatted = formatSafeOutputsSummary({
    status: 'skipped',
    staged: true,
    pushed: false,
    createdIds: [],
    updatedIds: [],
    untouchedIds: [],
    skipped: [{ index: 0, dedupeKey: 'bad`key\ninject', reason: 'bad\nreason' }],
  });
  assert.ok(!formatted.includes('\ninject'));
  assert.ok(!formatted.includes('bad`key'));
});

test('unused-code-triage gh-aw workflow keeps agent read-only and gates writes through detection + deterministic applier', () => {
  const lockText = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'unused-code-triage.lock.yml'), 'utf8');
  assert.ok(lockText.startsWith('# gh-aw-metadata:'), 'lockfile must carry gh-aw metadata header');
  const flow = YAML.parse(lockText);

  assert.equal(flow.name, 'unused-code-triage');
  assert.deepEqual(flow.permissions, {}, 'workflow-level permissions must default to empty');
  assert.equal(flow.on?.pull_request, undefined, 'triage workflow must not run on pull_request');
  assert.equal(flow.on?.push, undefined, 'triage workflow must not run on push');
  assert.equal(flow.on?.workflow_run, undefined, 'triage workflow must not listen to workflow_run');

  assert.equal(flow.jobs.agent.permissions.contents, 'read', 'agent job must keep contents: read');
  assert.equal(flow.jobs.agent.permissions['copilot-requests'], 'write', 'agent job uses Copilot inference');

  const jobsWithContentsWrite = Object.entries(flow.jobs)
    .filter(([, job]) => job?.permissions?.contents === 'write')
    .map(([id]) => id);
  assert.deepEqual(jobsWithContentsWrite, ['upsert_unused_code_bead'], 'only the deterministic safe-outputs job may hold contents: write');

  const safeJob = flow.jobs.upsert_unused_code_bead;
  assert.ok(safeJob.needs.includes('agent') && safeJob.needs.includes('detection'));
  assert.match(safeJob.if, /needs\.detection\.result == 'success'/);
  const checkoutStep = safeJob.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  assert.equal(checkoutStep?.with?.['persist-credentials'], false, 'checkout must not persist credentials on disk');
  assert.equal(checkoutStep?.with?.ref, '${{ github.event.repository.default_branch }}');
  const applyStep = safeJob.steps.find((step) => step.id === 'apply');
  assert.match(applyStep?.run ?? '', /node scripts\/apply-beads-safe-outputs\.mjs/);
  assert.equal(typeof applyStep?.['timeout-minutes'], 'number');
});

test('gh-aw triage workflow and safe-outputs bridge select no apps or site builds in app-plan', async () => {
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(REPO_ROOT);
  const plan = createAppPlan(registry, [
    '.github/workflows/unused-code-triage.md',
    '.github/workflows/unused-code-triage.lock.yml',
    '.github/aw/actions-lock.json',
    'scripts/lib/beads-safe-outputs.mjs',
    'scripts/apply-beads-safe-outputs.mjs',
    'test/beads-safe-outputs.test.mjs',
    'test/ci-policy.test.mjs',
    'test/workflow-action-runtimes.test.mjs',
    'scripts/lib/ci-measures.mjs',
    'docs/architecture/beads-memory.md',
  ], graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
});
