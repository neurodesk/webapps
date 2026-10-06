'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const fixtures = require('./batch-parity-fixtures.cjs');

const DEFAULT_HF_DATASET_REPO = 'sbollmann/sct-webapp-data';
const DEFAULT_HF_REVISION = 'main';
const DEFAULT_MAX_DOWNLOAD_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_DOWNLOAD_REDIRECTS = 5;
const SCT_TESTING_DATA_RAW_BASE = 'https://raw.githubusercontent.com/spinalcordtoolbox/sct_testing_data/master';
const SCT_TESTING_DATA_FIXTURE_MAP = Object.freeze({
  'test_data/batch_t2_deepseg_lesion_sci_t2/input.nii.gz': 't2/t2_fake_lesion.nii.gz',
  'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_sc.nii.gz': 't2/t2_fake_lesion_sc_seg.nii.gz',
  'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_lesion.nii.gz': 't2/t2_fake_lesion_lesion_seg.nii.gz'
});

function requiredSctFixturePaths(rootDir) {
  const required = [path.join(rootDir, 'test_data/batch_processing.sh')];
  for (const fixture of fixtures.FIXTURE_CASES) {
    required.push(path.join(rootDir, fixture.inputPath));
    const expectedPaths = fixture.expectedOutputPaths
      ? Object.values(fixture.expectedOutputPaths)
      : [fixture.expectedOutputPath];
    for (const expectedPath of expectedPaths) required.push(path.join(rootDir, expectedPath));
  }
  return required;
}

function missingSctFixturePaths(rootDir) {
  return requiredSctFixturePaths(rootDir).filter(filePath => !fs.existsSync(filePath));
}

function hasSctBatchFixtures(rootDir) {
  return missingSctFixturePaths(rootDir).length === 0;
}

async function ensureSctBatchFixtures(rootDir, options = {}) {
  const force = options.force || process.env.SCT_BATCH_FIXTURE_FORCE_DOWNLOAD === '1';
  const required = requiredSctFixturePaths(rootDir);
  const targets = force ? required : missingSctFixturePaths(rootDir);
  if (targets.length === 0) return { downloaded: false };

  const repoId = options.repoId || process.env.SCT_HF_DATASET_REPO || DEFAULT_HF_DATASET_REPO;
  const revision = options.revision || process.env.SCT_HF_REVISION || DEFAULT_HF_REVISION;
  for (const filePath of targets) {
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
    if (SCT_TESTING_DATA_FIXTURE_MAP[relativePath]) {
      await downloadSctTestingDataFile(SCT_TESTING_DATA_FIXTURE_MAP[relativePath], filePath);
    } else {
      await downloadHfFile(repoId, revision, relativePath, filePath);
    }
  }

  const missing = missingSctFixturePaths(rootDir);
  if (missing.length) {
    throw new Error(`Hugging Face fixture download did not produce required files:\n${missing.map(filePath => `- ${path.relative(rootDir, filePath)}`).join('\n')}`);
  }
  return { downloaded: true, repoId, revision, count: targets.length };
}

function downloadHfFile(repoId, revision, relativePath, destination) {
  const url = `https://huggingface.co/datasets/${repoId}/resolve/${encodeURIComponent(revision)}/${relativePath}`;
  return download(url, destination);
}

function downloadSctTestingDataFile(relativePath, destination) {
  const url = `${SCT_TESTING_DATA_RAW_BASE}/${relativePath}`;
  return download(url, destination);
}

function download(url, destination, options = {}) {
  const settings = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_DOWNLOAD_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  };
  return downloadAttempt(url, destination, 0, 0, settings);
}

function isRetryableStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function retryDownload(url, destination, redirectCount, retryCount, settings, resolve, reject) {
  const delayMs = settings.retryBaseDelayMs * (2 ** retryCount);
  setTimeout(() => {
    downloadAttempt(url, destination, redirectCount, retryCount + 1, settings).then(resolve, reject);
  }, delayMs);
}

function downloadAttempt(url, destination, redirectCount, retryCount, settings) {
  if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadAttempt(nextUrl, destination, redirectCount + 1, retryCount, settings).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        if (isRetryableStatus(statusCode) && retryCount < settings.maxRetries) {
          retryDownload(url, destination, redirectCount, retryCount, settings, resolve, reject);
          return;
        }
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
    request.on('error', error => {
      if (retryCount < settings.maxRetries) {
        retryDownload(url, destination, redirectCount, retryCount, settings, resolve, reject);
        return;
      }
      reject(error);
    });
  });
}

module.exports = {
  DEFAULT_HF_DATASET_REPO,
  DEFAULT_HF_REVISION,
  SCT_TESTING_DATA_FIXTURE_MAP,
  download,
  ensureSctBatchFixtures,
  hasSctBatchFixtures,
  missingSctFixturePaths,
  requiredSctFixturePaths
};

if (require.main === module) {
  const rootDir = path.resolve(__dirname, '..');
  ensureSctBatchFixtures(rootDir, { force: process.argv.includes('--force') }).then(result => {
    if (result.downloaded) {
      console.log(`Downloaded ${result.count} SCT fixture file(s) from ${result.repoId}@${result.revision}`);
    } else {
      console.log('SCT fixture files are already present');
    }
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
