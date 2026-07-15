import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;

function validateScientificManifest(app, manifest) {
  const errors = [];
  if (manifest.schema_version !== 1) errors.push('schema_version must be 1');
  if (manifest.app !== app.id) errors.push(`app must equal ${app.id}`);
  if (!Array.isArray(manifest.assets)) errors.push('assets must be an array');
  for (const [index, asset] of (manifest.assets || []).entries()) {
    const label = `assets[${index}]`;
    if (!asset.filename) errors.push(`${label}.filename is required`);
    if (!Number.isInteger(asset.bytes) || asset.bytes < 0) errors.push(`${label}.bytes must be a non-negative integer`);
    if (!SHA256.test(asset.sha256 || '')) errors.push(`${label}.sha256 must be a lowercase SHA-256`);
    if (!manifest.base_url && !asset.url && !asset.source_url) errors.push(`${label} requires a URL`);
  }
  return errors;
}

function pipelineAssets(manifest) {
  return [
    ...(manifest.modelAssets || []),
    ...(manifest.atlasAssets || []),
    ...(manifest.connectomeAssets || []),
    ...(manifest.annotationAssets || []),
  ];
}

function validatePipelineManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== '1.0.0') errors.push('schemaVersion must be 1.0.0');
  if (!Array.isArray(manifest.pipelines)) errors.push('pipelines must be an array');
  for (const asset of pipelineAssets(manifest)) {
    if (!asset.id || !asset.filename) errors.push('pipeline assets require id and filename');
    if (asset.checksum && !/^sha256:[0-9a-f]{64}$/.test(asset.checksum)) {
      errors.push(`${asset.id || asset.filename} has an invalid checksum`);
    }
  }
  return errors;
}

export async function validateAssetManifest(repoRoot, app) {
  if (!app.model_manifest) return [];
  const manifest = JSON.parse(await readFile(join(repoRoot, app.model_manifest), 'utf8'));
  if (app.asset_manifest_schema === 'scientific-assets-v1') return validateScientificManifest(app, manifest);
  if (app.asset_manifest_schema === 'pipeline-assets-v1') return validatePipelineManifest(manifest);
  return [`unsupported schema ${app.asset_manifest_schema}`];
}
