import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const imagingApps = ['calmar', 'musclemap', 'seedseg', 'spinalcordtoolbox', 'vesselboost'];
const appEntries = {
  calmar: 'lnm-app.js',
  musclemap: 'musclemap-app.js',
  seedseg: 'seedseg-app.js',
  spinalcordtoolbox: 'spinalcordtoolbox-app.js',
  vesselboost: 'vesselboost-app.js',
};
const pipelineEntries = {
  calmar: 'CalmarPipeline.js',
  musclemap: 'MuscleMapPipeline.js',
  seedseg: 'SeedSegPipeline.js',
  spinalcordtoolbox: 'SctPipeline.js',
  vesselboost: 'VesselBoostPipeline.js',
};
const staticRoots = {
  calmar: 'web',
  musclemap: 'web',
  qsmbly: '',
  seedseg: 'web',
  spinalcordtoolbox: 'web',
  vesselboost: 'web',
};

const pathExists = async (...parts) => access(join(repoRoot, ...parts)).then(() => true, () => false);
const source = (...parts) => readFile(join(repoRoot, ...parts), 'utf8');

async function findJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(path);
    return /\.m?js$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

function importMapFrom(html) {
  const match = html.match(/<script\s+type=["']importmap["']>([\s\S]*?)<\/script>/i);
  assert.ok(match, 'missing browser import map');
  return JSON.parse(match[1]).imports;
}

test('imaging inference workers are modules built on the shared worker toolkit', async () => {
  for (const app of imagingApps) {
    const appSource = await source('apps', app, 'web', 'js', appEntries[app]);
    const executorSource = await source('apps', app, 'web', 'js', 'controllers', pipelineEntries[app]);
    const workerSource = await source('apps', app, 'web', 'js', 'inference-worker.js');
    assert.doesNotMatch(workerSource, /\bimportScripts\s*\(/, app);
    assert.match(workerSource, /vendor\/webapp-components\/src\/worker\//, app);
    assert.match(workerSource, /createWorkerEmitter/, app);
    assert.match(`${appSource}\n${executorSource}`, /workerType:\s*['"]module['"]|type:\s*['"]module['"]/, app);
  }
});

test('inference workers do not fork shared worker and volume primitives', async () => {
  const commonWorkerFunctions = [
    'postProgress',
    'postLog',
    'postError',
    'postComplete',
    'collectTransferables',
  ];
  const forbiddenByApp = {
    calmar: [
      'connectedComponents3D',
      'orientToRAS',
      'computeResampledDims',
      'resampleVolume',
      'computeForegroundBBox',
      'cropVolume',
      'uncrop',
      'resampleLabelsNearest',
      'inverseOrient',
      'transposeXYZToZYX',
      'transposeZYXToXYZ',
    ],
    musclemap: ['connectedComponents3D', 'orientToRAS', 'resampleVolume', 'uncrop', 'inverseOrient', 'zScoreNormalizeNonzero'],
    seedseg: ['padVolume', 'cropVolume', 'zScoreNormalize', 'niftiToC', 'cToNifti'],
    spinalcordtoolbox: [
      'connectedComponents3D',
      'orientToRAS',
      'computeResampledDims',
      'resampleVolume',
      'computeForegroundBBox',
      'cropVolume',
      'uncrop',
      'resampleLabelsNearest',
      'inverseOrient',
      'transposeXYZToZYX',
      'transposeZYXToXYZ',
      'flipVolumeAxes',
    ],
    vesselboost: [
      'connectedComponents3D',
      'orientToRAS',
      'computeResampledDims',
      'resampleVolume',
      'zScoreNormalize',
      'computeForegroundBBox',
      'cropVolume',
      'uncrop',
      'resampleLabelsNearest',
      'inverseOrient',
    ],
  };

  for (const app of imagingApps) {
    const workerSource = await source('apps', app, 'web', 'js', 'inference-worker.js');
    assert.doesNotMatch(workerSource, /self\.postMessage\s*\(/, `${app} bypasses createWorkerEmitter`);
    for (const functionName of [...commonWorkerFunctions, ...forbiddenByApp[app]]) {
      assert.doesNotMatch(workerSource, new RegExp(`function\\s+${functionName}\\s*\\(`), `${app}/${functionName}`);
    }
  }
});

test('browser imports of shared components resolve to JavaScript files', async () => {
  for (const [app, root] of Object.entries(staticRoots)) {
    const appRoot = join(repoRoot, 'apps', app, root);
    const imports = importMapFrom(await readFile(join(appRoot, 'index.html'), 'utf8'));
    const files = await findJavaScriptFiles(join(appRoot, 'js'));

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      const specifiers = [...contents.matchAll(
        /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](@neurodesk\/webapp-components(?:\/[^"']*)?)["']/g,
      )].map((match) => match[1]);

      for (const specifier of specifiers) {
        const exactTarget = imports[specifier];
        const prefix = Object.keys(imports)
          .filter((key) => key.endsWith('/') && specifier.startsWith(key))
          .sort((left, right) => right.length - left.length)[0];
        const target = exactTarget ?? (prefix && `${imports[prefix]}${specifier.slice(prefix.length)}`);
        assert.ok(target, `${app}: ${specifier} has no browser import-map target`);
        assert.match(
          target,
          /\.m?js(?:[?#].*)?$/,
          `${app}: ${specifier} resolves to ${target}, which a static server cannot serve as JavaScript`,
        );
      }
    }
  }
});

test('runtime wrappers have one tracked source and are generated for apps', async () => {
  assert.equal(await pathExists('packages', 'runtime-support', 'src', 'nifti-js'), true);
  // dcm2niix comes from the @niivue/dcm2niix version runtime-support pins, never a committed copy.
  assert.equal(await pathExists('packages', 'runtime-support', 'src', 'dcm2niix'), false);
  assert.match(await source('scripts', 'vendor-runtime-support.mjs'), /resolve\('@niivue\/dcm2niix\/package\.json'\)/);
  const ignore = await source('.gitignore');
  assert.match(ignore, /apps\/\*\/web\/dcm2niix\//);
  assert.match(ignore, /apps\/qsmbly\/nifti-js\//);
  const manifest = JSON.parse(await source('runtime-assets', 'manifest.json'));
  for (const file of manifest.families.find(({ id }) => id === 'nifti-reader').files) {
    assert.equal(file.source_package, 'runtime-support', `nifti-reader/${file.name}`);
  }
});

test('every app that loads the staged dcm2niix module stages it before build', async () => {
  const skip = new Set(['node_modules', 'dist', 'vendor', 'dcm2niix', 'e2e', 'test', 'tests']);
  async function references(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !skip.has(entry.name) && await references(join(directory, entry.name))) return true;
      if (entry.isFile() && /\.(?:m?js|html)$/.test(entry.name)
        && (await readFile(join(directory, entry.name), 'utf8')).includes('dcm2niix/index.jpeg.js')) return true;
    }
    return false;
  }
  const consumers = [];
  for (const app of await readdir(join(repoRoot, 'apps'))) {
    const manifest = await source('apps', app, 'package.json').catch(() => null);
    if (!manifest || !await references(join(repoRoot, 'apps', app))) continue;
    consumers.push(app);
    const { scripts = {} } = JSON.parse(manifest);
    assert.match(Object.values(scripts).join(' '), /vendor-runtime-support\.mjs|mri2vid\/scripts\/stage-browser\.mjs/, `${app} must stage @niivue/dcm2niix`);
    assert.match(scripts.prebuild ?? '', /runtime-support|stage-browser/, `${app}: prebuild must stage dcm2niix`);
  }
  assert.ok(consumers.includes('easy-mp2rage') && consumers.includes('qsmbly'), consumers.join(', '));
});

test('registry shell metadata drives adapters without app-id branches', async () => {
  const shell = await source('site', 'app-shell.js');
  const theme = await source('site', 'app-theme.css');
  const build = await source('scripts', 'build-site.mjs');
  assert.match(build, /shell:\s*app\.shell/);
  assert.match(shell, /metadata\.shell/);
  assert.doesNotMatch(shell, /\b(calmar|dicompare|qsmbly|surfannotate|easy-mp2rage|mri2vid)\b/);
  assert.doesNotMatch(theme, /data-neurodesk-app=/);
});

test('the app scaffold and maintained guidance describe the current shared architecture', async () => {
  const scaffold = await source('templates', 'app-template', 'src', 'main.js');
  const maintainedGuidance = [
    scaffold,
    await source('apps', 'musclemap', 'web', 'index.html'),
    await source('apps', 'spinalcordtoolbox', 'AGENTS.md'),
    await source('apps', 'vesselboost', 'AGENT.md'),
    await source('docs', 'architecture', 'component-adoption.md'),
  ].join('\n');

  assert.match(scaffold, /mountImagingWorkspace/);
  assert.match(scaffold, /controlsContract/);
});
