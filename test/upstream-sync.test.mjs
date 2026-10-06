import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PACKAGE_VERSION_SITE, mergeUpstream } from '../scripts/lib/upstream-sync.mjs';

const pkg = (version, dependencies) => `${JSON.stringify({ name: 'demo', version, dependencies }, null, 2)}\n`;
const lines = (...items) => `${items.join('\n')}\n`;

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
