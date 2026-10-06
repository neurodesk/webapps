import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { PACKAGE_VERSION_SITE, mergeUpstream } from '../scripts/lib/upstream-sync.mjs';

const pkg = (version, dependencies) => `${JSON.stringify({ name: 'demo', version, dependencies }, null, 2)}\n`;
const lines = (...items) => `${items.join('\n')}\n`;

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

function commit(repo, files) {
  write(repo, files);
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
      'landing.css': lines('body { color: red }'),
      '.github/workflows/ci.yml': lines('ci'),
    });
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
    assert.equal(read('landing.css'), lines('body {}'));
    assert.equal(existsSync(join(app, '.github')), false);
    assert.deepEqual(status, {
      '.github/workflows/ci.yml': 'ignored',
      'controllers/Dicom.js': 'dropped',
      'controllers/Extra.js': 'dropped',
      'landing.css': 'ignored',
      'package.json': 'merged',
      'src/QsmPipelineController.js': 'merged',
      'src/clash.js': 'conflict',
      'src/main.js': 'merged',
      'src/new.js': 'added',
      'src/old.js': 'deleted',
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
