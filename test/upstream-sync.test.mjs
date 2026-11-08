import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { PACKAGE_VERSION_SITE, latestRelease, mergeUpstream } from '../scripts/lib/upstream-sync.mjs';

const pkg = (version, dependencies) => `${JSON.stringify({ name: 'demo', version, dependencies }, null, 2)}\n`;
const lines = (...items) => `${items.join('\n')}\n`;

test('conflicted sync refreshes confirm draft status before pushing', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8'));
  const script = workflow.jobs.sync.steps.find(step => step.name === 'Open or refresh the pull request').run;
  const mocks = `
    git() {
      case "$1" in
        diff) return 1 ;;
        rev-parse) echo old-head ;;
        push) echo PUSH ;;
      esac
    }
    gh() {
      case "$2" in
        list) echo 123 ;;
        view) echo "$DRAFT" ;;
        ready) echo DRAFT; [ "$DENY" = 0 ] || return 1; DRAFT=true ;;
        edit|comment) : ;;
        *) return 1 ;;
      esac
    }
  `;
  const run = (conflicts, draft, deny = '0') => execFileSync('bash', ['-e', '-c', mocks + script], {
    encoding: 'utf8',
    env: { ...process.env, CONFLICTS: conflicts, DRAFT: draft, DENY: deny, BRANCH: 'upstream/demo', APP: 'demo', TARGET: 'abc' },
  });
  assert.equal(run('1', 'false'), 'DRAFT\nPUSH\n');
  assert.equal(run('1', 'true'), 'PUSH\n');
  assert.equal(run('0', 'false'), 'PUSH\n');
  assert.throws(() => run('1', 'false', '1'), error => {
    assert.equal(error.stdout, 'DRAFT\n');
    return true;
  });
});

test('the workflow preserves human amendments to commits authored by the bot', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'upstream-guard-test-'));
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    const base = commit(repo, { 'source.js': lines('base') });
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('update-ref', 'refs/remotes/origin/main', base);
    write(repo, { 'source.js': lines('upstream change') });
    git('add', '-A');
    git('-c', 'user.name=sync[bot]', '-c', 'user.email=bot@example.test', 'commit', '-qm', 'sync');
    git('update-ref', 'refs/remotes/origin/upstream/browserqc', git('rev-parse', 'HEAD'));
    const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8'));
    const guard = workflow.jobs.sync.steps.find(step => step.id === 'guard').run;
    const output = join(root, 'output');
    const runGuard = () => {
      writeFileSync(output, '');
      execFileSync('bash', ['-c', guard], {
        cwd: repo,
        env: { ...process.env, BOT: 'sync[bot]', BASE: 'main', BRANCH: 'upstream/browserqc', GITHUB_OUTPUT: output },
      });
      return readFileSync(output, 'utf8');
    };
    assert.equal(runGuard(), '');
    write(repo, { 'source.js': lines('human conflict resolution') });
    git('add', '-A');
    git('-c', 'user.name=maintainer', '-c', 'user.email=human@example.test', 'commit', '--amend', '--no-edit');
    git('update-ref', 'refs/remotes/origin/upstream/browserqc', git('rev-parse', 'HEAD'));
    assert.equal(git('log', '-1', '--format=%an'), 'sync[bot]');
    assert.match(runGuard(), /skip=true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (content === null) rmSync(join(root, path));
    else writeFileSync(join(root, path), content);
  }
}

function commit(repo, files, executable = []) {
  write(repo, files);
  for (const path of executable) chmodSync(join(repo, path), 0o755);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c']);
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

test('merges upstream into a monorepo copy that diverged on purpose', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'upstream-sync-test-'));
  try {
    const upstream = join(root, 'upstream');
    const app = join(root, 'app');
    mkdirSync(upstream);
    execFileSync('git', ['init', '-q', upstream]);
    const base = commit(upstream, {
      'package.json': pkg('1.0.0', { a: '1' }),
      'src/main.js': lines('header', 'one', 'two', 'three', 'four', 'footer'),
      'src/clash.js': lines('value = 1'),
      'src/PipelineExecutor.js': lines('class PipelineExecutor {}', 'run()'),
      'src/old.js': lines('old'),
      'controllers/Dicom.js': lines('upstream dicom'),
      'landing.css': lines('body {}'),
      '.github/workflows/deploy.yml': lines('deploy'),
    });
    const target = commit(upstream, {
      'package.json': pkg('1.4.0', { a: '1', b: '2' }),
      'src/main.js': lines('header', 'one', 'two', 'three', 'four', 'footer', 'upstream tail'),
      'src/clash.js': lines('value = 3'),
      'src/PipelineExecutor.js': lines('class PipelineExecutor {}', 'run({ fast: true })'),
      'src/old.js': null,
      'src/new.js': lines('import { PipelineExecutor } from "./PipelineExecutor.js"'),
      'controllers/Dicom.js': lines('upstream dicom v2'),
      'controllers/Extra.js': lines('needs Dicom.js'),
      'controllers/helpers/nested.js': lines('deeper inside a replaced directory'),
      'src/run.sh': lines('#!/bin/sh', 'echo run'),
      'landing.css': lines('body { color: red }'),
      '.github/workflows/ci.yml': lines('ci'),
    }, ['src/run.sh']);
    write(app, {
      'package.json': pkg('0.3.20261004', { a: '1', '@neurodesk/webapp-components': 'workspace:*' }),
      'src/main.js': lines('monorepo header', 'one', 'two', 'three', 'four', 'footer'),
      'src/clash.js': lines('value = 2'),
      'src/QsmPipelineController.js': lines('class QsmPipelineController {}', 'run()'),
      'src/old.js': lines('old'),
      'landing.css': lines('body {}'),
    });

    const report = mergeUpstream({
      upstream, base, target, appDir: app,
      config: { ignore: ['.github/**', 'landing.css'], rewrite: { PipelineExecutor: 'QsmPipelineController' } },
      versionSites: [PACKAGE_VERSION_SITE],
    });
    const status = Object.fromEntries(report.map(item => [item.path, item.status]));
    const read = path => readFileSync(join(app, path), 'utf8');

    assert.deepEqual(JSON.parse(read('package.json')), {
      name: 'demo', version: '0.3.20261004', dependencies: { a: '1', '@neurodesk/webapp-components': 'workspace:*', b: '2' },
    });
    assert.equal(read('src/main.js'), lines('monorepo header', 'one', 'two', 'three', 'four', 'footer', 'upstream tail'));
    assert.equal(status['src/clash.js'], 'conflict');
    assert.match(read('src/clash.js'), /<<<<<<< monorepo\nvalue = 2\n[\s\S]*value = 3\n>>>>>>> upstream/);
    assert.equal(read('src/QsmPipelineController.js'), lines('class QsmPipelineController {}', 'run({ fast: true })'));
    assert.equal(read('src/new.js'), lines('import { QsmPipelineController } from "./QsmPipelineController.js"'));
    assert.equal(existsSync(join(app, 'src/old.js')), false);
    assert.equal(existsSync(join(app, 'controllers')), false, 'a directory the monorepo replaced stays gone');
    assert.equal(statSync(join(app, 'src/run.sh')).mode & 0o111, 0o111, 'an executable upstream file stays executable');
    assert.equal(read('landing.css'), lines('body {}'));
    assert.equal(existsSync(join(app, '.github')), false);
    assert.deepEqual(status, {
      '.github/workflows/ci.yml': 'ignored',
      'controllers/Dicom.js': 'dropped',
      'controllers/Extra.js': 'dropped',
      'controllers/helpers/nested.js': 'dropped',
      'landing.css': 'ignored',
      'package.json': 'merged',
      'src/QsmPipelineController.js': 'merged',
      'src/clash.js': 'conflict',
      'src/main.js': 'merged',
      'src/new.js': 'added',
      'src/old.js': 'deleted',
      'src/run.sh': 'added',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BrowserQC merges science changes while preserving shared UI, assets and its release version', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'browserqc-sync-test-'));
  try {
    const upstream = join(root, 'upstream');
    const app = join(root, 'app');
    mkdirSync(upstream);
    execFileSync('git', ['init', '-q', upstream]);
    const config = JSON.parse(readFileSync(new URL('../apps/browserqc/upstream.json', import.meta.url), 'utf8'));
    const baseFiles = {
      'package.json': pkg('1.3.0', { niimath: '1' }),
      'src/main.ts': lines('shared entry', 'load image', 'run science', 'download'),
      'src/qc.ts': lines('metric = 1'),
      'src/rate.ts': lines('rating = 1'),
      'src/models.ts': lines('model = 1'),
      'index.html': lines('upstream shell'),
      'src/style.css': lines('upstream styling'),
      'src/dcm2niix/import.ts': lines('upstream DICOM importer'),
      'public/models/weights.bin': Buffer.from([0, 1, 2, 3]),
    };
    const base = commit(upstream, baseFiles);
    const target = commit(upstream, {
      'package.json': pkg('1.4.0', { niimath: '2' }),
      'src/main.ts': lines('shared entry', 'load image', 'run science', 'download', 'new upstream feature'),
      'src/qc.ts': lines('metric = 2'),
      'src/rate.ts': lines('rating = 2'),
      'src/models.ts': lines('model = 2'),
      'index.html': lines('new upstream shell'),
      'src/style.css': lines('new upstream styling'),
      'src/dcm2niix/import.ts': lines('new upstream DICOM importer'),
      'public/models/weights.bin': Buffer.from([0, 5, 6, 7]),
      'public/example.nii.gz': Buffer.from([0, 8, 9]),
    });
    write(app, {
      'package.json': pkg('1.3.20261004', { niimath: '1', '@neurodesk/webapp-components': 'workspace:*' }),
      'src/main.ts': baseFiles['src/main.ts'],
      'src/qc.ts': lines('metric = 3'),
      'src/rate.ts': baseFiles['src/rate.ts'],
      'src/models.ts': baseFiles['src/models.ts'],
      'index.html': lines('shared shell'),
      'src/style.css': lines('shared design system'),
      'src/segmentation-worker.ts': lines('local worker cancellation'),
    });
    const report = mergeUpstream({ upstream, base, target, appDir: app, config, versionSites: [PACKAGE_VERSION_SITE] });
    const status = Object.fromEntries(report.map(item => [item.path, item.status]));
    const read = path => readFileSync(join(app, path), 'utf8');
    assert.equal(status['src/qc.ts'], 'conflict');
    assert.match(read('src/qc.ts'), /<<<<<<< monorepo[\s\S]*metric = 3[\s\S]*metric = 2[\s\S]*>>>>>>> upstream/);
    assert.equal(read('src/main.ts'), lines('shared entry', 'load image', 'run science', 'download', 'new upstream feature'));
    assert.equal(read('src/rate.ts'), lines('rating = 2'));
    assert.equal(read('src/models.ts'), lines('model = 2'));
    assert.equal(read('src/segmentation-worker.ts'), lines('local worker cancellation'));
    assert.deepEqual(JSON.parse(read('package.json')), {
      name: 'demo', version: '1.3.20261004', dependencies: { niimath: '2', '@neurodesk/webapp-components': 'workspace:*' },
    });
    assert.equal(read('index.html'), lines('shared shell'));
    assert.equal(read('src/style.css'), lines('shared design system'));
    assert.equal(existsSync(join(app, 'public')), false);
    assert.equal(existsSync(join(app, 'src/dcm2niix')), false);
    for (const path of ['index.html', 'src/style.css', 'src/dcm2niix/import.ts', 'public/models/weights.bin', 'public/example.nii.gz']) {
      assert.equal(status[path], 'ignored', `${path} must be listed for manual review`);
    }
    const before = read('src/main.ts');
    assert.deepEqual(mergeUpstream({ upstream, base: target, target, appDir: app, config }), []);
    assert.equal(read('src/main.ts'), before, 'a target already synced writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('QSMbly imports its engine while retaining the shared workspace and input owner', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'qsmbly-sync-test-'));
  try {
    const upstream = join(root, 'upstream');
    const app = join(root, 'app');
    mkdirSync(upstream);
    execFileSync('git', ['init', '-q', upstream]);
    const config = JSON.parse(readFileSync(new URL('../apps/qsmbly/upstream.json', import.meta.url), 'utf8'));
    const index = '<div id="citationsModal"><a href="https://doi.org/10.1/qsm">QSM</a></div>\n';
    const base = commit(upstream, {
      'index.html': index,
      'rust-wasm/src/lib.rs': lines('old bindings'),
      'js/controllers/FileIOController.js': lines('upstream inputs'),
    });
    const target = commit(upstream, {
      'rust-wasm/src/lib.rs': lines('engine bindings'),
      'rust-wasm/src/engine.rs': lines('QSMxT engine'),
      'js/controllers/FileIOController.js': lines('upstream inputs with sidecars'),
      'next.html': lines('alternate shell'),
      'css/next.css': lines('alternate palette'),
      'js/next/components/App.js': lines('alternate controls'),
      'js/next/engine/worker.js': lines('alternate UI worker'),
      'vendor/preact/preact.module.js': lines('preview framework'),
      'tests/e2e/run.spec.js': lines('preview tests'),
    });
    write(app, {
      'index.html': lines('canonical shared workspace'),
      'rust-wasm/src/lib.rs': lines('old bindings'),
      'js/controllers/QsmInputSet.js': lines('shared input adapter'),
    });
    const report = mergeUpstream({ upstream, base, target, appDir: app, config });
    const read = path => readFileSync(join(app, path), 'utf8');
    assert.equal(read('rust-wasm/src/lib.rs'), lines('engine bindings'));
    assert.equal(read('rust-wasm/src/engine.rs'), lines('QSMxT engine'));
    assert.equal(read('index.html'), lines('canonical shared workspace'));
    assert.equal(read('js/controllers/QsmInputSet.js'), lines('shared input adapter'));
    assert.equal(existsSync(join(app, 'js/controllers/FileIOController.js')), false);
    assert.equal(report.find(item => item.path === 'js/controllers/FileIOController.js').status, 'dropped');
    for (const item of report.filter(item => item.status === 'ignored')) {
      assert.equal(existsSync(join(app, item.path)), false, item.path);
    }
    assert.equal(report.filter(item => item.status === 'ignored').length, 6);
    assert.equal(JSON.parse(read('upstream-citations.json')).commit, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync records target citations even when the local upstream modal was removed', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'upstream-citations-test-'));
  try {
    const upstream = join(root, 'upstream');
    const appDir = join(root, 'app');
    execFileSync('git', ['init', '-q', upstream]);
    const base = commit(upstream, { 'index.html': '<div id="citationsModal"><a href="https://doi.org/10.1/old">Old</a></div>\n' });
    const target = commit(upstream, { 'index.html': '<div id="citationsModal"><a href="https://doi.org/10.1/old">Old</a><a href="https://doi.org/10.1/new">New</a></div>\n' });
    write(appDir, { 'index.html': '<main>Shared shell</main>\n' });
    mergeUpstream({ upstream, base, target, appDir, config: { citationSnapshot: { file: 'index.html', selector: '#citationsModal', output: 'upstream-citations.json' } } });
    assert.deepEqual(JSON.parse(readFileSync(join(appDir, 'upstream-citations.json'), 'utf8')), { commit: target, dois: ['10.1/new', '10.1/old'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release tracking picks the newest vX.Y.Z tag, not the branch tip or a pre-release', () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'upstream-release-test-'));
  try {
    const upstream = join(root, 'upstream');
    execFileSync('git', ['init', '-q', upstream]);
    const tag = (name) => execFileSync('git', ['-C', upstream, 'tag', name]);
    assert.equal(latestRelease(upstream), undefined);
    commit(upstream, { 'a.txt': 'one\n' });
    tag('v0.9.0');
    commit(upstream, { 'a.txt': 'two\n' });
    tag('v0.10.0');
    commit(upstream, { 'a.txt': 'three\n' });
    tag('v0.11.0-rc.1');
    tag('nightly');
    commit(upstream, { 'a.txt': 'four\n' });
    assert.equal(latestRelease(upstream), 'v0.10.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
