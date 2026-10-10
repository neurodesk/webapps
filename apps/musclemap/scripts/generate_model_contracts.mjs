#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const repoRoot = resolve(appDir, '..', '..');
const sourceDir = join(appDir, 'model-sources');
const releasePath = join(sourceDir, 'release.json');
const generatedCatalogPath = join(appDir, 'web', 'js', 'app', 'model-catalog.generated.js');
const manifestPath = join(repoRoot, 'models', 'musclemap.manifest.json');
const packagePath = join(appDir, 'package.json');

const checkOnly = process.argv.includes('--check');

function fail(message) {
  throw new Error(`MuscleMap model contract: ${message}`);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function labelName(label) {
  const side = label.side === 'left' ? ' L' : label.side === 'right' ? ' R' : '';
  return `${titleCase(label.anatomy)}${side}`;
}

function assertHex(value, length, field) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    fail(`${field} must be ${length} lowercase hexadecimal characters`);
  }
}

function validateRelease(release, packageJson) {
  if (release.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (release.appVersion !== packageJson.version) {
    fail(`appVersion ${release.appVersion} does not match package version ${packageJson.version}`);
  }
  assertHex(release.upstream?.revision, 40, 'upstream.revision');
  assertHex(release.publication?.revision, 40, 'publication.revision');
  if (!release.publication?.baseUrl?.includes(`/resolve/${release.publication.revision}/`)) {
    fail('publication.baseUrl must contain the immutable publication revision');
  }
  if (!Array.isArray(release.models) || release.models.length === 0) fail('models must not be empty');

  const activeIds = new Set();
  const selectableLabelSpaces = new Set();
  for (const model of release.models) {
    if (!['active', 'staged', 'legacy', 'retired'].includes(model.status)) fail(`${model.id} has an invalid status`);
    if (model.status === 'active') {
      if (activeIds.has(model.id)) fail(`more than one active version exists for ${model.id}`);
      activeIds.add(model.id);
    }
    if (model.status === 'active' || model.status === 'legacy') {
      if (selectableLabelSpaces.has(model.labelSpaceId)) {
        fail(`more than one selectable model uses ${model.labelSpaceId}`);
      }
      selectableLabelSpaces.add(model.labelSpaceId);
    }
    assertHex(model.config?.sha256, 64, `${model.id}.config.sha256`);
    if (typeof model.overlapDefault !== 'number' || model.overlapDefault < 0 || model.overlapDefault >= 1) {
      fail(`${model.id}.overlapDefault must be between 0 and 1`);
    }
    if ((model.status === 'active' || model.status === 'legacy') && !model.asset) {
      fail(`${model.id} is selectable without an asset`);
    }
    if (model.asset) {
      assertHex(model.asset.revision, 40, `${model.id}.asset.revision`);
      assertHex(model.asset.sha256, 64, `${model.id}.asset.sha256`);
      if (!Number.isInteger(model.asset.bytes) || model.asset.bytes <= 0) fail(`${model.id}.asset.bytes must be positive`);
      if (model.asset.url && !model.asset.url.startsWith('https://')) fail(`${model.id}.asset.url must use HTTPS`);
      if (!model.asset.validationReport) fail(`${model.id}.asset.validationReport is required`);
      if (model.asset.parts) {
        if (!Array.isArray(model.asset.parts) || model.asset.parts.length === 0) {
          fail(`${model.id}.asset.parts must be a non-empty array`);
        }
        let partBytes = 0;
        for (const part of model.asset.parts) {
          if (!/^models\/[a-zA-Z0-9._-]+$/.test(part.path)) fail(`${model.id}.asset part path is invalid`);
          if (!Number.isInteger(part.bytes) || part.bytes <= 0 || part.bytes > 25 * 1024 * 1024) {
            fail(`${model.id}.asset part bytes must be within the Cloudflare Pages limit`);
          }
          assertHex(part.sha256, 64, `${model.id}.asset part sha256`);
          partBytes += part.bytes;
        }
        if (partBytes !== model.asset.bytes) fail(`${model.id}.asset parts do not add up to the model bytes`);
      }
    }
  }
}

async function loadModel(releaseModel, release) {
  const configPath = join(sourceDir, releaseModel.config.path);
  const bytes = await readFile(configPath);
  if (bytes.byteLength !== releaseModel.config.bytes) {
    fail(`${releaseModel.config.path} has ${bytes.byteLength} bytes, expected ${releaseModel.config.bytes}`);
  }
  if (sha256(bytes) !== releaseModel.config.sha256) fail(`${releaseModel.config.path} SHA-256 mismatch`);

  const config = JSON.parse(bytes.toString('utf8'));
  const labels = [
    { index: 0, value: 0, region: '', anatomy: 'background', side: 'none', name: 'Background', color: [0, 0, 0, 0] },
    ...config.labels.map((label, offset) => ({
      index: offset + 1,
      value: label.value,
      region: label.region,
      anatomy: label.anatomy,
      side: label.side || 'none',
      name: labelName(label),
      color: null
    }))
  ];

  if (config.model.out_channels !== labels.length) {
    fail(`${releaseModel.id} has ${config.model.out_channels} outputs but ${labels.length} labels including background`);
  }

  const indices = new Set();
  const values = new Set();
  for (const label of labels) {
    if (indices.has(label.index)) fail(`${releaseModel.labelSpaceId} repeats class index ${label.index}`);
    if (values.has(label.value)) fail(`${releaseModel.labelSpaceId} repeats external value ${label.value}`);
    indices.add(label.index);
    values.add(label.value);
  }

  const maxExternalValue = Math.max(...labels.map(label => label.value));
  if (maxExternalValue > 65535) fail(`${releaseModel.labelSpaceId} exceeds uint16`);

  const modelVersion = Number(config.model.version) === 0 ? '0.0' : String(config.model.version);
  const asset = releaseModel.asset ? {
    revision: releaseModel.asset.revision,
    url: releaseModel.asset.url ||
      `https://huggingface.co/datasets/${release.publication.repository}/resolve/${releaseModel.asset.revision}/musclemap/${releaseModel.filename}`,
    bytes: releaseModel.asset.bytes,
    sha256: releaseModel.asset.sha256,
    precision: releaseModel.asset.precision,
    validationReport: releaseModel.asset.validationReport,
    parts: releaseModel.asset.parts || null
  } : null;

  return {
    id: releaseModel.id,
    name: releaseModel.filename,
    filename: releaseModel.filename,
    label: releaseModel.displayName,
    modelVersion,
    labelSpaceId: releaseModel.labelSpaceId,
    status: releaseModel.status,
    legacy: releaseModel.legacy,
    numClasses: config.model.out_channels,
    roiSize: config.parameters.roi_size,
    network: {
      spatialDims: config.model.spatial_dims,
      inChannels: config.model.in_channels,
      outChannels: config.model.out_channels,
      channels: config.model.channels,
      strides: config.model.strides,
      numResUnits: config.model.num_res_units,
      activation: config.model.act,
      normalization: config.model.norm
    },
    preprocessing: {
      orientation: 'RAS',
      targetSpacing: config.parameters.pix_dim,
      cropForegroundMargin: 20,
      spatialPad: [256, 256],
      padding: 'end',
      overlapDefault: releaseModel.overlapDefault,
      normalization: 'nonzero-zscore'
    },
    source: {
      record: releaseModel.source.record,
      doi: releaseModel.source.doi,
      configSha256: releaseModel.config.publishedSha256,
      checkpointSha256: releaseModel.source.checkpointSha256 || null,
      upstreamRevision: release.upstream.revision,
      license: release.upstream.license
    },
    asset,
    labelSpace: {
      id: releaseModel.labelSpaceId,
      modelVersion,
      classCount: config.model.out_channels,
      externalEncoding: maxExternalValue > 255 ? 'uint16' : 'uint8',
      maxExternalValue,
      labels
    }
  };
}

function renderCatalog(release, models) {
  const selectable = models.filter(model => model.status === 'active' || model.status === 'legacy');
  return `export const APP_VERSION = ${JSON.stringify(release.appVersion)};\n` +
    `export const TARGET_APP_VERSION = ${JSON.stringify(release.targetAppVersion)};\n` +
    `export const MODEL_BASE_URL = ${JSON.stringify(release.publication.baseUrl)};\n` +
    `export const UPSTREAM_REVISION = ${JSON.stringify(release.upstream.revision)};\n` +
    `export const MODEL_RELEASES = ${JSON.stringify(models, null, 2)};\n\n` +
    `export const MODELS = MODEL_RELEASES\n` +
    `  .filter(model => model.status === 'active' || model.status === 'legacy')\n` +
    `  .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'));\n` +
    `export const LABEL_SPACES = Object.fromEntries(MODEL_RELEASES.map(model => [model.labelSpaceId, model.labelSpace]));\n` +
    `export const MODELS_BY_LABEL_SPACE = Object.fromEntries(MODELS.map(model => [model.labelSpaceId, model]));\n` +
    `export const MODELS_BY_ID = Object.fromEntries([...MODELS].reverse().map(model => [model.id, model]));\n` +
    `export const MODELS_BY_FILENAME = Object.fromEntries([...MODELS].reverse().map(model => [model.filename, model]));\n\n` +
    `export function getModelById(id) { return MODELS_BY_ID[id] || null; }\n` +
    `export function getModelByFilename(filename) { return MODELS_BY_FILENAME[filename] || null; }\n` +
    `export function getModelByLabelSpace(id) { return MODELS_BY_LABEL_SPACE[id] || null; }\n` +
    `export function getLabelSpace(id) { return LABEL_SPACES[id] || null; }\n` +
    `export function requireLabelSpace(id) {\n` +
    `  const labelSpace = getLabelSpace(id);\n` +
    `  if (!labelSpace) throw new Error(\`Unknown MuscleMap label space: \${id}\`);\n` +
    `  return labelSpace;\n` +
    `}\n`;
}

function registryId(model, models) {
  const conflictsWithActive = model.status !== 'active' && models.some(candidate => (
    candidate.id === model.id && candidate.status === 'active'
  ));
  return conflictsWithActive ? `${model.id}-v${model.modelVersion}` : model.id;
}

function renderManifest(release, models) {
  const assets = models
    .filter(model => model.status === 'active' || model.status === 'legacy')
    .map(model => ({
      id: registryId(model, models),
      model_version: model.modelVersion,
      label_space_id: model.labelSpaceId,
      legacy: model.legacy,
      filename: model.filename,
      revision: model.asset.revision,
      url: model.asset.url,
      bytes: model.asset.bytes,
      sha256: model.asset.sha256,
      parts: model.asset.parts,
      source_record: model.source.record,
      source_doi: model.source.doi,
      license: model.source.license
    }));
  return `${JSON.stringify({
    schema_version: 1,
    app: 'musclemap',
    repository: release.publication.repository,
    revision: release.publication.revision,
    base_url: `${release.publication.baseUrl}/`,
    license: release.upstream.license,
    upstream_revision: release.upstream.revision,
    preprocessing_contract: {
      mode: '2d-slicewise',
      orientation: 'RAS',
      in_plane_spacing_mm: [1, 1],
      z_spacing: 'native',
      crop_margin_voxels: 20,
      padding: 'end',
      overlap_default: 0.9,
      source: 'apps/musclemap/model-sources/release.json'
    },
    assets
  }, null, 2)}\n`;
}

async function writeOrCheck(path, expected) {
  if (checkOnly) {
    const actual = await readFile(path, 'utf8').catch(() => '');
    if (actual !== expected) fail(`${path} is stale; run pnpm --filter musclemap models:generate`);
    return;
  }
  await writeFile(path, expected);
}

const [release, packageJson] = await Promise.all([
  readFile(releasePath, 'utf8').then(JSON.parse),
  readFile(packagePath, 'utf8').then(JSON.parse)
]);
validateRelease(release, packageJson);

const models = [];
for (const model of release.models) models.push(await loadModel(model, release));

await Promise.all([
  writeOrCheck(generatedCatalogPath, renderCatalog(release, models)),
  writeOrCheck(join(repoRoot, 'packages/musclemap/src/model-catalog.generated.js'), renderCatalog(release, models)),
  writeOrCheck(manifestPath, renderManifest(release, models))
]);

console.log(checkOnly ? 'MuscleMap generated model contracts are current.' : 'Generated MuscleMap model contracts.');
