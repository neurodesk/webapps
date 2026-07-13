'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const HF_DATASET_REPO_ID = 'sbollmann/sct-webapp-data';
const HF_DATASET_ASSET_REVISION = '55c9462a14bc9c84cf093c348cffda9148099df9';
const HF_DATASET_ASSET_BASE_URL = `https://huggingface.co/datasets/${HF_DATASET_REPO_ID}/resolve/${HF_DATASET_ASSET_REVISION}`;
const LFS_POINTER_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/');

const EXTRA_HOSTED_ASSETS = Object.freeze([
  {
    id: 'synthstrip',
    filename: 'synthstrip.onnx',
    downloadUrl: `${HF_DATASET_ASSET_BASE_URL}/web/models/synthstrip.onnx`,
    checksum: 'sha256:7b8eeecf3793a6c4510b9f5270ecc03d9c3262d26e08d568203a651ab4b84074',
    sizeBytes: 10294211
  }
]);

function assetDestination(rootDir, asset) {
  if (!asset?.filename) throw new Error('Hosted asset is missing filename');
  return path.join(rootDir, 'web/models', asset.filename);
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function validateAssetFile(filePath, asset) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };

  const stat = fs.statSync(filePath);
  if (asset.sizeBytes && stat.size !== asset.sizeBytes) {
    return { ok: false, reason: `size ${stat.size} != ${asset.sizeBytes}` };
  }

  const fd = fs.openSync(filePath, 'r');
  const prefix = Buffer.alloc(LFS_POINTER_PREFIX.length);
  const bytesRead = fs.readSync(fd, prefix, 0, LFS_POINTER_PREFIX.length, 0);
  fs.closeSync(fd);
  if (prefix.equals(LFS_POINTER_PREFIX)) return { ok: false, reason: 'git-lfs pointer' };

  if (asset.checksum?.startsWith('sha256:')) {
    const actual = sha256File(filePath);
    if (actual !== asset.checksum) return { ok: false, reason: `checksum ${actual} != ${asset.checksum}` };
  }

  return { ok: true, reason: null };
}

function collectManifestHostedAssets(manifest) {
  const assets = [];
  for (const task of manifest?.tasks || []) {
    for (const asset of task.modelAssets || []) {
      if (asset.downloadUrl) assets.push({ ...asset, taskId: task.id, assetKind: 'model' });
    }
    for (const asset of task.templateAssets || []) {
      if (asset.downloadUrl) assets.push({ ...asset, taskId: task.id, assetKind: 'template' });
    }
  }
  return assets;
}

function collectHostedAssets(manifest) {
  const byPath = new Map();
  for (const asset of [...collectManifestHostedAssets(manifest), ...EXTRA_HOSTED_ASSETS]) {
    byPath.set(asset.filename, asset);
  }
  return [...byPath.values()];
}

async function ensureHostedAsset(rootDir, asset, options = {}) {
  const destination = assetDestination(rootDir, asset);
  const current = validateAssetFile(destination, asset);
  if (!options.force && current.ok) return { path: destination, downloaded: false };

  if (!asset.downloadUrl) {
    throw new Error(`Hosted asset ${asset.id || asset.filename} is missing downloadUrl and local file is ${current.reason}`);
  }

  await download(asset.downloadUrl, destination, 0);
  const downloaded = validateAssetFile(destination, asset);
  if (!downloaded.ok) {
    throw new Error(`Downloaded hosted asset failed validation: ${path.relative(rootDir, destination)} (${downloaded.reason})`);
  }

  return { path: destination, downloaded: true };
}

async function ensureHostedAssets(rootDir, assets, options = {}) {
  const results = [];
  for (const asset of assets) {
    results.push(await ensureHostedAsset(rootDir, asset, options));
  }
  return results;
}

function download(url, destination, redirectCount) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        download(nextUrl, destination, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${statusCode}`));
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const tempPath = `${destination}.tmp-${process.pid}`;
      const file = fs.createWriteStream(tempPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(error => {
          if (error) {
            fs.rmSync(tempPath, { force: true });
            reject(error);
            return;
          }
          fs.renameSync(tempPath, destination);
          resolve();
        });
      });
      file.on('error', error => {
        fs.rmSync(tempPath, { force: true });
        reject(error);
      });
    });
    request.on('error', reject);
  });
}

module.exports = {
  HF_DATASET_REPO_ID,
  HF_DATASET_ASSET_REVISION,
  HF_DATASET_ASSET_BASE_URL,
  EXTRA_HOSTED_ASSETS,
  assetDestination,
  collectHostedAssets,
  collectManifestHostedAssets,
  ensureHostedAsset,
  ensureHostedAssets,
  validateAssetFile
};

if (require.main === module) {
  const rootDir = path.resolve(__dirname, '..');
  const manifest = require(path.join(rootDir, 'web/models/manifest.json'));
  const assets = collectHostedAssets(manifest);
  ensureHostedAssets(rootDir, assets, { force: process.argv.includes('--force') }).then(results => {
    const count = results.filter(result => result.downloaded).length;
    console.log(`Hosted assets ready: ${assets.length} checked, ${count} downloaded from ${HF_DATASET_REPO_ID}@${HF_DATASET_ASSET_REVISION}`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
