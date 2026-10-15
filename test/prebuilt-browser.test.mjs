import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withBrowserBuild } from '../test-utils/playwright-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'test-utils/run-browser-tests.mjs');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('browser server commands build locally and only serve the CI bundle when prebuilt', () => {
  assert.equal(withBrowserBuild('preview', undefined, {}), 'pnpm build && preview');
  assert.equal(withBrowserBuild('preview', 'stage && build', {}), 'stage && build && preview');
  assert.equal(withBrowserBuild('preview', 'stage && build', { NEURODESK_E2E_PREBUILT: '1' }), 'preview');
  assert.equal(withBrowserBuild('preview', undefined, { NEURODESK_E2E_PREBUILT: 'true' }), 'pnpm build && preview');
});

for (const prebuilt of ['', '1']) {
  test(`a multi-stage suite shares exactly one build with every driver (prebuilt=${prebuilt || 'no'})`, () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'browser-build-'));
    try {
      writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\nprintf "build\\n" >> "$BUILD_LOG"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'driver.mjs'), `
        import { appendFileSync } from 'node:fs';
        import { withBrowserBuild } from ${JSON.stringify(new URL('../test-utils/playwright-build.mjs', import.meta.url).href)};
        if (withBrowserBuild('preview') !== 'preview') process.exit(1);
        appendFileSync(process.env.BUILD_LOG, 'driver\\n');
      `);
      const driver = `${shellQuote(process.execPath)} driver.mjs`;
      execFileSync(process.execPath, [helper, `${driver} && ${driver}`], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          BUILD_LOG: join(dir, 'build.log'),
          NEURODESK_E2E_PREBUILT: prebuilt,
        },
      });
      assert.equal(readFileSync(join(dir, 'build.log'), 'utf8'), prebuilt ? 'driver\ndriver\n' : 'build\ndriver\ndriver\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a failed build stops the browser suite and returns its exit code', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'browser-build-'));
  try {
    writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [helper, 'exit 99'], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, NEURODESK_E2E_PREBUILT: '' },
    });
    assert.equal(result.status, 23);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every production Playwright server omits its build only in prebuilt mode', async () => {
  const { readdir } = await import('node:fs/promises');
  const apps = await readdir(join(root, 'apps'));
  const configs = [];
  for (const app of apps) {
    const files = await readdir(join(root, 'apps', app));
    for (const file of files.filter(name => /^playwright\.config\./.test(name))) configs.push(join(root, 'apps', app, file));
  }
  const script = `
    const commands = [];
    for (const file of ${JSON.stringify(configs)}) {
      const config = (await import(file)).default;
      for (const server of [config.webServer].flat().filter(Boolean)) commands.push([file, server.command]);
    }
    console.log(JSON.stringify(commands));
  `;
  const commands = prebuilt => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, NEURODESK_E2E_PREBUILT: prebuilt },
    encoding: 'utf8',
  }));
  const local = commands('');
  const prebuilt = new Map(commands('1').map(([file, command]) => [`${file}:${command.split(' && ').at(-1)}`, command]));
  let checked = 0;
  for (const [file, command] of local) {
    if (!/\bbuild\b|build-static\.mjs/.test(command)) continue;
    const serve = command.split(' && ').at(-1);
    assert.equal(prebuilt.get(`${file}:${serve}`), serve, file);
    checked++;
  }
  assert.ok(checked >= 20, `Checked ${checked} production server configs`);
});

test('SynthSeg resolves its local model URL at build time, including builds outside Playwright', () => {
  const define = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const config = await (await import('./apps/synthseg/vite.config.js')).default;
    console.log(JSON.stringify(config.define || {}));
  `], {
    cwd: root,
    env: { ...process.env, SYNTHSEG_ASSET_DIR: '', VITE_SYNTHSEG_ASSET_BASE: '', ...env },
    encoding: 'utf8',
  }));
  assert.deepEqual(define({}), {});
  assert.deepEqual(define({ SYNTHSEG_ASSET_DIR: '/models' }), {
    'import.meta.env.VITE_SYNTHSEG_ASSET_BASE': JSON.stringify('/synthseg/model-assets/'),
  });
  assert.deepEqual(define({ SYNTHSEG_ASSET_DIR: '/models', VITE_SYNTHSEG_ASSET_BASE: '/custom/' }), {
    'import.meta.env.VITE_SYNTHSEG_ASSET_BASE': JSON.stringify('/custom/'),
  });
});

test('prebuilt mode preserves the collected browser test inventory', () => {
  for (const app of ['synthseg', 'brain-extraction', 'white-matter-lesions']) {
    const collect = prebuilt => JSON.parse(execFileSync(process.execPath, [
      join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--list', '--reporter=json',
    ], {
      cwd: join(root, 'apps', app),
      env: { ...process.env, NEURODESK_E2E_PREBUILT: prebuilt, PW_TEST_REPORTER: '' },
      encoding: 'utf8',
    }));
    const local = collect('');
    const prebuilt = collect('1');
    assert.deepEqual(local.errors, [], app);
    assert.deepEqual(prebuilt.errors, [], app);
    assert.deepEqual(prebuilt.suites, local.suites, app);
  }
});

test('a missing prebuilt bundle fails the suite without a fallback build', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'browser-build-'));
  try {
    writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\nprintf "unexpected build" > build.log\n', { mode: 0o755 });
    writeFileSync(join(dir, 'preview.mjs'), "import { readFileSync } from 'node:fs'; readFileSync('dist/index.html');\n");
    const result = spawnSync(process.execPath, [helper, `${shellQuote(process.execPath)} preview.mjs`], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, NEURODESK_E2E_PREBUILT: '1' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /ENOENT/);
    assert.throws(() => readFileSync(join(dir, 'build.log')), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
