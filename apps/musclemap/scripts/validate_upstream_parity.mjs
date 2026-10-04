#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { MODEL_RELEASES } from '../web/js/app/model-catalog.generated.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const defaultStage = resolve(appDir, '.tmp_model_release', 'wholebody-v1.4');
const defaultReferenceManifest = resolve(appDir, 'model-sources', 'parity-reference.json');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitForServer(url, processHandle) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error('Parity validation server exited early');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Parity validation server did not start: ${url}`);
}

async function startBinaryServer(port, files) {
  const metadata = new Map();
  for (const [urlPath, filePath] of Object.entries(files)) {
    const fileStats = await stat(filePath);
    metadata.set(urlPath, { filePath, bytes: fileStats.size });
  }
  const server = createServer((request, response) => {
    const entry = metadata.get(request.url);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Cache-Control', 'no-store');
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', entry.bytes);
    createReadStream(entry.filePath).pipe(response);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  return server;
}

async function main() {
  const reportPath = resolve(argument('--report', resolve(defaultStage, 'upstream-parity-report.json')));
  await mkdir(dirname(reportPath), { recursive: true });
  await rm(reportPath, { force: true });
  const caseId = argument('--case', null);
  let controlledCase = null;
  if (caseId) {
    const manifestPath = resolve(argument('--reference-manifest', defaultReferenceManifest));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    controlledCase = manifest.cases?.find(item => item.id === caseId);
    if (!controlledCase) throw new Error(`Unknown controlled reference case: ${caseId}`);
  }
  const referenceRoot = argument('--reference-root', null);
  const inputValue = argument('--input', controlledCase && referenceRoot
    ? resolve(referenceRoot, controlledCase.input)
    : null);
  const referenceValue = argument('--reference', controlledCase && referenceRoot
    ? resolve(referenceRoot, controlledCase.reference)
    : null);
  if (!inputValue || !referenceValue) {
    throw new Error('Provide --input and --reference, or provide --case with --reference-root');
  }
  const inputPath = resolve(inputValue);
  const referencePath = resolve(referenceValue);
  const precision = argument('--precision', 'fp32');
  const backend = argument('--backend', 'wasm');
  if (!['wasm', 'webgpu'].includes(backend)) throw new Error('--backend must be wasm or webgpu');
  const softwareWebGpu = hasArgument('--software-webgpu');
  if (softwareWebGpu && backend !== 'webgpu') throw new Error('--software-webgpu requires --backend webgpu');
  const overlap = Number(argument('--overlap', String(controlledCase?.overlap ?? 0.5)));
  const sourceChunkSizeRaw = argument('--source-chunk-size', String(controlledCase?.sourceChunkSize ?? 17));
  const sourceChunkSize = sourceChunkSizeRaw === 'full' ? 'full' : Number(sourceChunkSizeRaw);
  const outputPath = resolve(argument('--output', resolve(defaultStage, 'upstream-parity-output.nii')));
  const stagedModel = MODEL_RELEASES.find(model =>
    model.id === 'wholebody' && model.modelVersion === '1.4'
  );
  if (!stagedModel) throw new Error('Generated catalog has no staged whole-body v1.4 descriptor');
  const conversionValue = argument('--conversion-report', null);
  const modelAuthority = conversionValue ? 'conversion-candidate' : 'published-release';
  let candidate;
  let candidatePath;
  if (conversionValue) {
    const conversionPath = resolve(conversionValue);
    const conversion = JSON.parse(await readFile(conversionPath, 'utf8'));
    candidate = conversion.candidates.find(item => item.precision === precision);
    if (!candidate) throw new Error(`Conversion report has no ${precision} candidate`);
    candidatePath = resolve(dirname(conversionPath), candidate.path);
  } else {
    if (stagedModel.asset.precision !== precision) {
      throw new Error(`Published release has no ${precision} model`);
    }
    candidatePath = resolve(defaultStage, basename(new URL(stagedModel.asset.url).pathname));
    candidate = { ...stagedModel.asset, path: candidatePath };
  }
  const candidateBytes = await readFile(candidatePath);
  if (candidateBytes.byteLength !== candidate.bytes || sha256(candidateBytes) !== candidate.sha256) {
    throw new Error(`Candidate does not match its ${modelAuthority} integrity metadata`);
  }
  const inputBytes = await readFile(inputPath);
  const referenceBytes = await readFile(referencePath);
  const inputDigest = sha256(inputBytes);
  const referenceDigest = sha256(referenceBytes);
  if (controlledCase) {
    if (inputDigest !== controlledCase.inputSha256 || referenceDigest !== controlledCase.referenceSha256) {
      throw new Error(`Controlled reference case ${caseId} failed SHA-256 verification`);
    }
    if (hasArgument('--overlap') || hasArgument('--source-chunk-size')) {
      throw new Error('Controlled reference cases use their pinned overlap and source chunk size');
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  const scientificSources = {};
  for (const name of ['inference-worker.js', 'monai-compat.js', 'sliding-window-policy.js', 'upstream-chunk.js']) {
    scientificSources[name] = sha256(await readFile(resolve(appDir, 'web', 'js', name)));
  }

  const port = Number(argument('--port', '4322'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const binaryPort = port + 1;
  const modelFilename = `parity-${port}-${process.pid}.onnx`;
  const modelLinkPath = resolve(appDir, 'web', 'models', modelFilename);
  await mkdir(dirname(modelLinkPath), { recursive: true });
  await symlink(candidatePath, modelLinkPath);
  const modelUrl = `${baseUrl}/models/${modelFilename}`;
  const inputUrl = `http://127.0.0.1:${binaryPort}/input.nii.gz`;
  const server = spawn('bash', ['web/run.sh', String(port)], {
    cwd: appDir,
    stdio: 'ignore'
  });
  let binaryServer;
  let browser;
  const stopValidation = () => {
    server.kill('SIGTERM');
    void browser?.close();
  };
  process.once('SIGINT', stopValidation);
  process.once('SIGTERM', stopValidation);
  try {
    binaryServer = await startBinaryServer(binaryPort, {
      '/input.nii.gz': inputPath
    });
    await waitForServer(`${baseUrl}/harness.html`, server);
    browser = await chromium.launch({
      headless: true,
      args: softwareWebGpu ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] : []
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    let gpuKernelCount = 0;
    await context.route('**/js/inference-worker.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const instrumentation = `
Object.defineProperty(navigator, 'hardwareConcurrency', { value: 4 });
${backend === 'webgpu' ? `
ort.env.webgpu.profiling = {
  mode: 'default',
  ondata: () => self.postMessage({ type: 'validationWebGPUKernel' })
};` : ''}
`;
      await route.fulfill({ response, body: instrumentation + source });
    });
    page.on('crash', () => process.stderr.write('ERROR: parity browser page crashed\n'));
    await page.exposeFunction('__reportParityEvent', event => {
      if (event.type === 'log') process.stdout.write(`${event.message}\n`);
      if (event.type === 'progress') {
        process.stdout.write(`[${Math.round(event.value * 100)}%] ${event.text}\n`);
      }
      if (event.type === 'validationWebGPUKernel') {
        gpuKernelCount++;
        if (gpuKernelCount === 1 || gpuKernelCount % 1000 === 0) {
          process.stdout.write(`WebGPU kernels executed: ${gpuKernelCount}\n`);
        }
      }
    });
    await page.goto(`${baseUrl}/harness.html`);
    const adapter = backend === 'webgpu' ? await page.evaluate(async () => {
      const gpu = await navigator.gpu?.requestAdapter();
      if (!gpu) throw new Error('WebGPU is required but no adapter is available');
      if (!gpu.features.has('timestamp-query')) {
        throw new Error('WebGPU validation requires timestamp-query to prove kernel execution');
      }
      return {
        vendor: gpu.info.vendor,
        architecture: gpu.info.architecture,
        device: gpu.info.device,
        description: gpu.info.description,
        isFallbackAdapter: gpu.info.isFallbackAdapter
      };
    }) : null;

    const outputDownload = page.waitForEvent('download');
    const modelDescriptor = {
      ...stagedModel,
      asset: {
        url: modelUrl,
        revision: 'local-upstream-parity',
        bytes: candidate.bytes,
        sha256: candidate.sha256,
        precision,
        validationReport: 'local-upstream-parity'
      }
    };
    const completion = page.evaluate(async ({ routedInputUrl, model, selectedOverlap, selectedSourceChunkSize, selectedBackend }) => {
      const inputData = await (await fetch(routedInputUrl)).arrayBuffer();
      const worker = new Worker('/js/inference-worker.js', { type: 'module' });
      await new Promise((resolvePromise, reject) => {
        let initialized = false;
        let generatedOutput = false;
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = event => {
          const data = event.data;
          if (['log', 'progress', 'validationWebGPUKernel'].includes(data.type)) window.__reportParityEvent(data);
          if (data.type === 'error') reject(new Error(data.message));
          if (data.type === 'initialized' && !initialized) {
            if (selectedBackend === 'webgpu' && !data.webgpuAvailable) {
              worker.terminate();
              reject(new Error('Worker has no WebGPU adapter'));
              return;
            }
            initialized = true;
            worker.postMessage({
              type: 'run',
              data: {
                inputData,
                settings: {
                  model,
                  overlap: selectedOverlap,
                  chunkSize: 1,
                  sourceChunkSize: selectedSourceChunkSize,
                  useWebGPU: selectedBackend === 'webgpu',
                  sliceThickness: -1,
                  lowRes: false,
                  calculateMetrics: false
                }
              }
            }, [inputData]);
          }
          if (data.type === 'stageData' && data.stage === 'segmentation') {
            generatedOutput = true;
            const link = document.createElement('a');
            link.download = 'upstream-parity-output.nii';
            link.href = URL.createObjectURL(new Blob([data.niftiData], { type: 'application/octet-stream' }));
            link.click();
          }
          if (data.type === 'complete') {
            worker.terminate();
            if (generatedOutput) resolvePromise();
            else reject(new Error('Worker completed without producing a segmentation'));
          }
        };
        worker.postMessage({ type: 'init', version: 'upstream-parity' });
      });
    }, {
      routedInputUrl: inputUrl,
      model: modelDescriptor,
      selectedOverlap: overlap,
      selectedSourceChunkSize: sourceChunkSize,
      selectedBackend: backend
    });
    const [download] = await Promise.all([outputDownload, completion]);
    await download.saveAs(outputPath);
    if (backend === 'webgpu' && gpuKernelCount === 0) {
      throw new Error('WebGPU validation produced no GPU kernel profiling events');
    }

    if (sha256(await readFile(inputPath)) !== inputDigest ||
        sha256(await readFile(referencePath)) !== referenceDigest) {
      throw new Error('Parity input or reference changed during validation');
    }
    const python = spawn(resolve(appDir, '.tmp_model_env', 'bin', 'python'), [
      resolve(scriptDir, 'compare_upstream_output.py'),
      '--reference', referencePath,
      '--candidate', outputPath,
      '--report', reportPath
    ], { cwd: appDir, stdio: 'inherit' });
    const exitCode = await new Promise(resolvePromise => python.on('exit', resolvePromise));
    const comparison = JSON.parse(await readFile(reportPath, 'utf8'));
    comparison.candidate = {
      precision: candidate.precision,
      path: candidate.path,
      bytes: candidate.bytes,
      sha256: candidate.sha256
    };
    comparison.run = {
      modelAuthority,
      input: { path: inputPath, bytes: inputBytes.byteLength, sha256: inputDigest },
      reference: { path: referencePath, bytes: referenceBytes.byteLength, sha256: referenceDigest },
      overlap,
      sourceChunkSize,
      backend,
      scientificSources,
      ortVersion: '1.21.0',
      browserVersion: browser.version(),
      wasmThreads: 4,
      output: { path: outputPath, sha256: sha256(await readFile(outputPath)) },
      ...(adapter ? { adapter, softwareWebGpu, gpuKernelCount } : {})
    };
    if (controlledCase) {
      comparison.run.controlledReferenceCase = controlledCase.id;
      comparison.run.referenceAuthority = controlledCase.authority;
      comparison.run.referenceProvenanceFile = controlledCase.provenance;
    }
    await writeFile(reportPath, `${JSON.stringify(comparison, null, 2)}\n`);
    if (exitCode !== 0) throw new Error(`Upstream comparison failed; see ${reportPath}`);
  } finally {
    process.removeListener('SIGINT', stopValidation);
    process.removeListener('SIGTERM', stopValidation);
    await browser?.close();
    server.kill('SIGTERM');
    binaryServer?.close();
    await rm(modelLinkPath, { force: true });
  }
}

main().catch(error => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
