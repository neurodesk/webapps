import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import {
  closureChange,
  compareSelection,
  expectedApps,
  failureCandidates,
  parseableClosure,
  republishedPackages,
  supersededMerges,
  workspaceClosures,
} from '../scripts/lib/app-plan-shadow.mjs';

const app = (id, ci = {}) => ({ id, ci: { browser_test: true, hardware_gpu: false, ...ci } });
const apps = [app('alpha'), app('beta', { hardware_gpu: true, e2e_shards: 2 }), app('gamma', { browser_test: false })];

const manifests = new Map([
  ['apps/alpha', { name: 'alpha', dependencies: { '@x/core': 'workspace:*' } }],
  ['apps/beta', { name: 'beta', devDependencies: { local: 'file:../../packages/local' } }],
  ['apps/gamma', { name: 'gamma', dependencies: { react: '^19.0.0' } }],
  ['packages/core', { name: '@x/core', dependencies: { '@x/util': 'workspace:^', react: '^19.0.0' } }],
  ['packages/util', { name: '@x/util' }],
  ['packages/local', { name: 'local', dependencies: { '@x/util': 'link:../util' } }],
]);
const workspace = { before: workspaceClosures(manifests), after: workspaceClosures(manifests) };

test('workspace closures follow workspace:, file: and link: specifiers transitively', () => {
  const closures = workspaceClosures(manifests);
  assert.deepEqual([...closures.get('apps/alpha')].sort(), ['packages/core', 'packages/util']);
  assert.deepEqual([...closures.get('apps/beta')].sort(), ['packages/local', 'packages/util']);
  assert.deepEqual([...closures.get('apps/gamma')], []);
});

test('a change in a transitive workspace dependency is expected to select every app using it', () => {
  const { expected, unattributed } = expectedApps({ apps, changedPaths: ['packages/util/src/index.js', 'scripts/build.mjs'], workspace });
  assert.deepEqual([...expected.keys()].sort(), ['alpha', 'beta']);
  assert.match(expected.get('alpha')[0], /declared dependency packages\/(?:core|util)/);
  assert.deepEqual(unattributed, ['scripts/build.mjs']);
});

test('a dependency dropped at head still counts through the merge base', () => {
  const head = new Map(manifests);
  head.set('apps/alpha', { name: 'alpha' });
  const { expected } = expectedApps({ apps, changedPaths: ['packages/core/index.js'], workspace: { before: workspaceClosures(manifests), after: workspaceClosures(head) } });
  assert.deepEqual([...expected.keys()], ['alpha']);
});

test('package tests and documents are exempt, not expected', () => {
  const { expected, exempt } = expectedApps({ apps, changedPaths: ['packages/core/test/a.test.js', 'packages/core/README.md'], workspace });
  assert.equal(expected.size, 0);
  assert.deepEqual(exempt.map((entry) => entry.path), ['packages/core/test/a.test.js', 'packages/core/README.md']);
});

test('own files and model manifests select their app', () => {
  const { expected } = expectedApps({ apps, changedPaths: ['apps/gamma/index.html', 'models/beta.manifest.json'], workspace });
  assert.deepEqual([...expected.keys()].sort(), ['beta', 'gamma']);
});

test('pnpm list output keeps virtual-store entries and drops workspace paths', () => {
  const closure = parseableClosure('/repo/apps/alpha\n/repo/packages/core\n.pnpm/react@19.0.0/node_modules/react\n.pnpm/@x+y@1.0.0_react@19.0.0/node_modules/@x/y\n');
  assert.deepEqual([...closure], ['.pnpm/react@19.0.0/node_modules/react', '.pnpm/@x+y@1.0.0_react@19.0.0/node_modules/@x/y']);
});

test('a republished package changes every closure containing it, peers included', () => {
  const lock = (integrity) => stringify({ lockfileVersion: '9.0', packages: { '@x/y@1.0.0': { resolution: { integrity } }, 'z@2.0.0': { resolution: { integrity: 'same' } } } });
  const republished = republishedPackages(lock('sha512-old'), lock('sha512-new'));
  assert.deepEqual(republished, ['.pnpm/@x+y@1.0.0']);
  const closure = new Set(['.pnpm/@x+y@1.0.0_react@19.0.0/node_modules/@x/y', '.pnpm/@x+y@1.0.01/node_modules/@x/y', '.pnpm/z@2.0.0/node_modules/z']);
  assert.deepEqual(closureChange(closure, closure, republished).changed, ['.pnpm/@x+y@1.0.0_react@19.0.0/node_modules/@x/y']);
});

test('a lockfile-only change is expected for the apps whose pnpm closure changed', () => {
  const react = (version) => new Set([`.pnpm/react@${version}/node_modules/react`]);
  const lockClosures = {
    before: new Map([['alpha', react('19.0.0')], ['beta', new Set()], ['gamma', react('19.0.0')]]),
    after: new Map([['alpha', react('19.1.0')], ['beta', new Set()], ['gamma', react('19.0.0')]]),
    republished: [],
  };
  const { expected, unattributed } = expectedApps({ apps, changedPaths: ['pnpm-lock.yaml'], workspace, lockClosures });
  assert.deepEqual([...expected.keys()], ['alpha']);
  assert.match(expected.get('alpha')[0], /adds \.pnpm\/react@19\.1\.0.*drops \.pnpm\/react@19\.0\.0/);
  assert.deepEqual(unattributed, []);
});

test('registry entries and offline asset locks select only the apps they changed', () => {
  const registry = { before: stringify({ apps: [{ id: 'alpha', title: 'A' }, { id: 'beta' }] }), after: stringify({ apps: [{ id: 'alpha', title: 'B' }, { id: 'beta' }] }) };
  const offlineLock = {
    before: JSON.stringify({ apps: { beta: ['u1'], gamma: ['u2'] }, assets: { u1: { sha256: 'a' }, u2: { sha256: 'b' } } }),
    after: JSON.stringify({ apps: { beta: ['u1'], gamma: ['u2'] }, assets: { u1: { sha256: 'c' }, u2: { sha256: 'b' } } }),
  };
  const { expected } = expectedApps({ apps, changedPaths: ['registry/apps.yml', 'registry/offline-assets.lock.json'], workspace, registry, offlineLock });
  assert.deepEqual([...expected.keys()].sort(), ['alpha', 'beta']);
});

test('misses are oracle apps the planner left out; job counts follow shards and GPU flags', () => {
  const oracle = { expected: new Map([['alpha', ['x']], ['beta', ['y']]]) };
  const plan = { selected: [apps[0], apps[2]], reasons: { fallback: null } };
  const result = compareSelection({ catalog: { apps }, plan, oracle });
  assert.deepEqual(result.misses, [{ app: 'beta', reasons: ['y'] }]);
  assert.deepEqual(result.beyondOracle, ['gamma']);
  assert.deepEqual(result.jobs, { planned: { app: 2, browser: 1, gpu: 0 }, full: { app: 3, browser: 3, gpu: 1 } });
});

test('a main failure after a narrowed PR skipped the app is a candidate, once per streak', () => {
  const history = [
    { id: 1, sha: 'a', apps: new Map([['alpha', 'success'], ['beta', 'success']]) },
    { id: 2, sha: 'c', apps: new Map([['alpha', 'failure'], ['beta', 'failure']]) },
    { id: 3, sha: 'd', apps: new Map([['alpha', 'failure']]) },
  ];
  const merges = { 'a..c': ['c', 'b'], 'c..d': ['d'] };
  const selections = new Map([
    ['b', { pr: 10, fallback: null, selected: ['beta'] }],
    ['c', { pr: 11, fallback: 'shared', selected: ['alpha', 'beta'] }],
    ['d', { pr: 12, fallback: null, selected: [] }],
  ]);
  const candidates = failureCandidates({ history, selections, mergesBetween: (from, to) => merges[`${from}..${to}`] ?? [] });
  assert.deepEqual(candidates, [{ app: 'alpha', failedAt: 'c', run: 2, lastPass: 'a', skippedBy: [10] }]);
});

test('a merge whose own push run was cancelled reports the apps it left untested', () => {
  const history = [
    { id: 1, sha: 'm1', event: 'push', conclusion: 'cancelled' },
    { id: 2, sha: 'm2', event: 'push', conclusion: 'success' },
    { id: 3, sha: 'm3', event: 'schedule', conclusion: 'cancelled' },
  ];
  const selections = new Map([
    ['m1', { pr: 1, merge: 'm1', fallback: null, selected: ['alpha'] }],
    ['m2', { pr: 2, merge: 'm2', fallback: null, selected: ['beta'] }],
    ['m3', { pr: 3, merge: 'm3', fallback: 'shared', selected: [] }],
  ]);
  assert.deepEqual(supersededMerges({ history, selections }), [{ pr: 1, run: 1, apps: ['alpha'] }]);
});
