import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import sourceParser from '@neurodesk/code-quality';
import { moduleById, modules, smoke, strykerConfig } from '../scripts/lib/mutation-modules.mjs';
import { runMutations, summarizeMutations } from '../scripts/report-mutations.mjs';

const execFileAsync = promisify(execFile);
const JS_MODULE = /\.[cm]?js$/;
const isFile = (path) => existsSync(path) && statSync(path).isFile();

const target = moduleById(smoke.module).file;
const files = modules.map((module) => module.file);
const mutants = (statuses) => ({ mutants: statuses.map((status) => ({ status, location: { start: { line: 11 } }, mutatorName: 'StringLiteral', replacement: '""' })) });
const report = (statuses, paths = files) => ({ files: Object.fromEntries(paths.map((path) => [path, mutants(statuses)])) });
const lines = (spec) => {
  const [path, range] = spec.split(':');
  const [start, end] = range.split('-').map(Number);
  return readFileSync(path, 'utf8').split('\n').slice(start - 1, end).join('\n');
};

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mutation-quality-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'mutation-canary', private: true, type: 'module' }));
  for (const path of ['packages/nii2tvx/src', 'packages/nii2tvx/test']) mkdirSync(join(cwd, path), { recursive: true });
  cpSync(target, join(cwd, target));
  cpSync('packages/nii2tvx/test/disconnectome.test.js', join(cwd, 'packages/nii2tvx/test/disconnectome.test.js'));
  writeFileSync(join(cwd, 'packages/nii2tvx/package.json'), '{"type":"module"}');
  return cwd;
}

test('each module is a separate Stryker run against only its own data-free Node suite', async () => {
  assert.equal(new Set(modules.map((module) => module.id)).size, modules.length);
  assert.equal(new Set(modules.map((module) => module.file)).size, modules.length);
  for (const module of modules) {
    const config = strykerConfig(module);
    assert.deepEqual(config.mutate, [module.mutate]);
    assert.ok(module.mutate.startsWith(module.file), module.file);
    assert.equal(config.commandRunner.command, module.command);
    assert.match(module.command, /^node --test /, module.file);
    assert.deepEqual(config.ignorePatterns, ['**', '!package.json', ...[module.file, ...module.files].map((path) => `!${path}`)]);
    for (const path of [module.file, ...module.files]) readFileSync(path);
    assert.equal(config.testRunner, 'command');
    assert.equal(config.coverageAnalysis, 'off');
    assert.equal(config.concurrency, 2);
    assert.equal(config.thresholds.break, null);
    assert.equal(config.cleanTempDir, 'always');
    assert.equal(config.jsonReporter.fileName, `quality-artifacts/mutations/${module.id}/mutation.json`);
    assert.equal(config.htmlReporter.fileName, `quality-artifacts/mutations/${module.id}/index.html`);
    process.env.MUTATION_MODULE = module.id;
    const { default: selected } = await import(`../stryker.config.mjs?module=${module.id}`);
    assert.deepEqual(selected, config);
  }
  process.env.MUTATION_MODULE = 'missing';
  await assert.rejects(import('../stryker.config.mjs?module=missing'), /Set MUTATION_MODULE to one of disconnectome, basis-select, format-g, date-versions, lockfile-impact, carotid-series, carotid-outputs, workspace-graph, lcmodel-tissue, lcmodel-io, lcmodel-voxel;/);
  // Tools that load the config without the variable (Knip) get the canary's module.
  delete process.env.MUTATION_MODULE;
  const { default: fallback } = await import('../stryker.config.mjs?module=unset');
  assert.deepEqual(fallback, strykerConfig(moduleById(smoke.module)));
});

test('line ranges still cover exactly the functions they name', () => {
  assert.match(lines(smoke.mutate), /^export function tableName\(id, atlasId\) \{[\s\S]*\n\}$/, 'update the smoke range when tableName moves');
  assert.ok(smoke.mutate.startsWith(`${target}:`));
  const formatG = moduleById('format-g');
  assert.match(lines(formatG.mutate), /^export function formatG\(x\) \{[\s\S]*\n\}$/, 'update the formatG range when it moves');
  // Only the formatG tests run: the rest of parity.test.js needs a native build.
  const pattern = new RegExp(formatG.command.match(/--test-name-pattern=(\S+)/)[1]);
  const names = [...readFileSync(formatG.files.at(-1), 'utf8').matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]).filter((name) => pattern.test(name));
  assert.equal(names.length, 2, names.join(', '));
  assert.ok(names.every((name) => /printf\("%g"\)/.test(name)), names.join(', '));
  const dates = lines(moduleById('date-versions').mutate);
  assert.match(dates, /^export function releaseDate\(now = new Date\(\)\) \{[\s\S]*\n\}$/, 'update the date-versions range when the date functions move');
  assert.deepEqual([...dates.matchAll(/^export function (\w+)/gm)].map((match) => match[1]), ['releaseDate', 'validateReleaseDate', 'nextVersion']);
  // lcmodel-io.js up to presentRows: fillGaps stays last and outside the range.
  const io = moduleById('lcmodel-io');
  const ioLines = lines(io.mutate);
  assert.match(ioLines, /\nexport function presentRows\(rows\) \{[^]*\n\}$/, 'update the lcmodel-io range when presentRows moves');
  const [, after] = readFileSync(io.file, 'utf8').split(ioLines);
  assert.deepEqual([...after.matchAll(/^export function (\w+)/gm)].map((match) => match[1]), ['fillGaps']);
  // The voxel suite skips only its three large-grid tests, too slow to run per mutant.
  const voxel = moduleById('lcmodel-voxel');
  const skips = [...voxel.command.matchAll(/--test-skip-pattern=(\S+)/g)].map((match) => new RegExp(match[1]));
  const voxelTests = [...readFileSync(voxel.files.at(-1), 'utf8').matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
  const skipped = voxelTests.filter((name) => skips.some((skip) => skip.test(name)));
  assert.deepEqual(skipped, ['an oblique box keeps its volume on the grid', 'fractions do not depend on how the image grid is oriented', 'oblique boxes keep their volume on average']);
});

test('surviving mutations are reported per module without a score gate', () => {
  const markdown = summarizeMutations(report(['Killed', 'Survived']));
  for (const file of files) assert.match(markdown, new RegExp(`\\| ${file} \\| 50.00% \\| 2 \\| 1 \\| 1 \\|`));
  assert.match(markdown, /StringLiteral/);
  assert.match(markdown, /Scores are report-only/);
});

test('smoke requires actual detection and reports cannot silently contain no mutants', () => {
  assert.throws(() => summarizeMutations(report(['Survived'], [target]), { smoke: true }), /did not detect/);
  assert.match(summarizeMutations(report(['Killed'], [target]), { smoke: true }), /Mutation testing smoke/);
  assert.throws(() => summarizeMutations(report(['Killed']), { smoke: true }), /exactly the configured modules/);
  assert.throws(() => summarizeMutations(report([])), /No mutations/);
  assert.throws(() => summarizeMutations({ files: { ...report(['Killed']).files, [target]: mutants([]) } }), /No mutations were tested in packages\/nii2tvx\/src\/disconnectome\.js/);
  assert.throws(() => summarizeMutations(report(['CompileError'])), /No mutations completed/);
  assert.throws(() => summarizeMutations({}), /mutation report/);
  assert.throws(() => summarizeMutations({ files: {} }), /exactly the configured modules/);
  assert.throws(() => summarizeMutations(report(['Killed'], files.slice(1))), /exactly the configured modules/);
  assert.throws(() => summarizeMutations(report(['Killed'], [...files, 'packages/other.js'])), /exactly the configured modules/);
  assert.throws(() => summarizeMutations(report(['RuntimeError'])), /runtime errors/);
  assert.throws(() => summarizeMutations(report(['wrong'])), /Invalid mutant status/);
});

test('invalid real Stryker configuration fails and leaves diagnostics', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'bad.config.mjs'), 'export default { concurrency: -1 };\n');
  assert.throws(() => runMutations({ cwd, config: 'bad.config.mjs' }), /Stryker failed/);
  assert.match(readFileSync(join(cwd, 'quality-artifacts/mutations/stryker.log'), 'utf8'), /concurrency/);
});

test('a failing real baseline test fails instead of reporting a mutation score', (t) => {
  const cwd = fixture(t);
  const tests = 'packages/nii2tvx/test/disconnectome.test.js';
  const failing = strykerConfig(moduleById('disconnectome'));
  writeFileSync(join(cwd, 'bad.config.mjs'), `export default ${JSON.stringify(failing)};\n`);
  writeFileSync(join(cwd, tests), "import test from 'node:test'; test('baseline', () => { throw new Error('baseline failure canary'); });\n");
  assert.throws(() => runMutations({ cwd, config: 'bad.config.mjs' }), /Stryker failed/);
  assert.match(readFileSync(join(cwd, 'quality-artifacts/mutations/stryker.log'), 'utf8'), /initial test run|baseline failure canary/i);
});

test('temporary files a killed suite leaves behind are removed after each run', (t) => {
  const cwd = fixture(t);
  const record = join(cwd, 'scratch.txt');
  const leave = [
    "const { mkdtempSync, writeFileSync } = require('node:fs');",
    `const left = mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'left-'));`,
    `writeFileSync(${JSON.stringify(record)}, left);`,
    'process.exit(2);',
  ].join('\n');
  assert.throws(() => runMutations({ cwd, prefix: ['-e', leave, '--'] }), /Stryker failed for disconnectome with exit 2/);
  const left = readFileSync(record, 'utf8');
  assert.ok(left.startsWith(join(tmpdir(), 'mutation-disconnectome-')), left);
  assert.throws(() => readdirSync(dirname(left)), { code: 'ENOENT' });
});

test('a crashing tool and missing executable fail', (t) => {
  const cwd = fixture(t);
  assert.throws(() => runMutations({ cwd, prefix: ['-e', 'process.exit(2)', '--'] }), /Stryker failed for disconnectome with exit 2/);
  assert.throws(() => runMutations({ cwd, prefix: ['-e', 'process.exit(0)', '--'] }), /ENOENT/);
  assert.throws(() => runMutations({ cwd, executable: join(cwd, 'missing') }), /ENOENT/);
});

function resolveLocalImport(from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}/index.js`, `${base}/index.mjs`];
  return candidates.find(isFile) ?? base;
}

function localRelativeImports(file) {
  const ast = sourceParser.parse(readFileSync(file, 'utf8'), { filePath: file, sourceType: 'module' });
  const specifiers = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ImportExpression')
      && node.source?.type === 'Literal' && typeof node.source.value === 'string' && node.source.value.startsWith('.')) {
      specifiers.add(node.source.value);
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require'
      && node.arguments?.[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string' && node.arguments[0].value.startsWith('.')) {
      specifiers.add(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === 'object' && value.type) {
        visit(value);
      }
    }
  };
  visit(ast);
  return [...specifiers].map((specifier) => resolveLocalImport(file, specifier));
}

function missingSandboxImports(module) {
  const included = new Set(['package.json', module.file, ...module.files]);
  const seen = new Set();
  const pending = [module.file, ...module.files].filter((file) => JS_MODULE.test(file));
  const missing = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of localRelativeImports(file)) {
      if (!included.has(target)) missing.push(`${file} -> ${target}`);
      if (JS_MODULE.test(target) && isFile(target) && !seen.has(target)) pending.push(target);
    }
  }
  return missing;
}

async function runInSandbox(module) {
  assert.match(module.command, /^node --test /, module.id);
  const scratch = mkdtempSync(join(tmpdir(), `mutation-sandbox-${module.id}-`));
  const sandbox = join(scratch, 'sandbox');
  const temp = join(scratch, 'tmp');
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const repoRoot = process.cwd();
  try {
    for (const rel of ['package.json', module.file, ...module.files]) {
      const targetPath = join(sandbox, rel);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(join(repoRoot, rel), targetPath);
    }
    // Mirror Stryker's node_modules symlinking for the root and touched workspace packages.
    const dirs = new Set(['.']);
    for (const rel of [module.file, ...module.files]) {
      for (let dir = posix.dirname(rel); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) dirs.add(dir);
    }
    for (const dir of dirs) {
      const source = join(repoRoot, dir, 'node_modules');
      const link = join(sandbox, dir, 'node_modules');
      if (existsSync(source) && !existsSync(link)) {
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(source, link, 'junction');
      }
    }
    const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
    delete env.NODE_TEST_CONTEXT;
    const args = module.command.trim().split(/\s+/).slice(1);
    try {
      return await execFileAsync(process.execPath, args, { cwd: sandbox, env, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`${module.id} failed in isolated sandbox:\n${error.stderr || ''}${error.stdout || ''}`, { cause: error });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('every module sandbox list covers all transitive local relative imports', () => {
  for (const module of modules) {
    assert.deepEqual(
      missingSandboxImports(module),
      [],
      `${module.id}: add missing transitive local imports to scripts/lib/mutation-modules.mjs`,
    );
  }
  const dateVersions = moduleById('date-versions');
  const withoutEmbedded = {
    ...dateVersions,
    files: dateVersions.files.filter((path) => path !== 'scripts/lib/embedded-version-sites.mjs'),
  };
  assert.deepEqual(missingSandboxImports(withoutEmbedded), [
    'scripts/lib/app-versions.mjs -> scripts/lib/embedded-version-sites.mjs',
  ]);
});

test('every module baseline command passes inside a Stryker-isolated sandbox', async () => {
  await Promise.all(modules.map((module) => runInSandbox(module)));
  const dateVersions = moduleById('date-versions');
  const withoutEmbedded = {
    ...dateVersions,
    files: dateVersions.files.filter((path) => path !== 'scripts/lib/embedded-version-sites.mjs'),
  };
  await assert.rejects(runInSandbox(withoutEmbedded), /ERR_MODULE_NOT_FOUND[\s\S]*embedded-version-sites\.mjs/);
});
