#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const defaultStage = resolve(appDir, '.tmp_model_release', 'wholebody-v1.4');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitForServer(url, processHandle) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error('Browser validation server exited early');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Connection refusal is expected until the bounded startup loop succeeds. */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Browser validation server did not start: ${url}`);
}

async function validateProvider(page, provider, modelUrl, fixtures, classCount, roiSize) {
  return page.evaluate(async ({ selectedProvider, candidateUrl, referenceFixtures, classes, roi }) => {
    ort.env.wasm.wasmPaths = '/wasm/';
    ort.env.wasm.numThreads = 1;
    const model = await (await fetch(candidateUrl)).arrayBuffer();
    const providers = selectedProvider === 'webgpu' ? ['webgpu'] : ['wasm'];
    const started = performance.now();
    const session = await ort.InferenceSession.create(model, {
      executionProviders: providers,
      graphOptimizationLevel: 'all'
    });
    const sessionCreationMs = performance.now() - started;
    const cases = [];
    for (const fixture of referenceFixtures) {
      const input = new Float32Array(await (await fetch(fixture.inputUrl)).arrayBuffer());
      const expected = new Uint8Array(await (await fetch(fixture.expectedUrl)).arrayBuffer());
      const tensor = new ort.Tensor('float32', input, [1, 1, roi[0], roi[1]]);
      const inferenceStarted = performance.now();
      const result = await session.run({ [session.inputNames[0]]: tensor });
      const inferenceMs = performance.now() - inferenceStarted;
      const logits = result[session.outputNames[0]].data;
      let matches = 0;
      for (let pixel = 0; pixel < expected.length; pixel++) {
        let bestClass = 0;
        let bestValue = logits[pixel];
        for (let classIndex = 1; classIndex < classes; classIndex++) {
          const value = logits[classIndex * expected.length + pixel];
          if (value > bestValue) {
            bestValue = value;
            bestClass = classIndex;
          }
        }
        if (bestClass === expected[pixel]) matches++;
      }
      tensor.dispose();
      result[session.outputNames[0]].dispose?.();
      cases.push({
        case: fixture.case,
        expectedClasses: fixture.expectedClasses,
        argmaxAgreement: matches / expected.length,
        inferenceMs
      });
    }
    await session.release();
    return { provider: selectedProvider, sessionCreationMs, cases };
  }, {
    selectedProvider: provider,
    candidateUrl: modelUrl,
    referenceFixtures: fixtures,
    classes: classCount,
    roi: roiSize
  });
}

async function main() {
  const conversionReportPath = resolve(argument(
    '--conversion-report',
    resolve(defaultStage, 'conversion-report.json')
  ));
  const precision = argument('--precision', 'fp32');
  const outputPath = resolve(argument('--report', resolve(defaultStage, 'browser-report.json')));
  const requireWebGpu = process.argv.includes('--require-webgpu');
  const conversion = JSON.parse(await readFile(conversionReportPath, 'utf8'));
  const candidate = conversion.candidates.find(item => item.precision === precision);
  if (conversion.status !== 'structural-and-random-patch-passed' || !candidate) {
    throw new Error('Conversion report does not authorize the selected browser candidate');
  }

  const stageDir = dirname(conversionReportPath);
  const candidatePath = resolve(stageDir, candidate.path);
  const candidateBytes = await readFile(candidatePath);
  if (candidateBytes.byteLength !== candidate.bytes || sha256(candidateBytes) !== candidate.sha256) {
    throw new Error('Browser candidate bytes do not match the conversion report');
  }

  const fixtures = [];
  for (const fixture of conversion.browserReferenceFixtures || []) {
    const inputBytes = await readFile(resolve(stageDir, fixture.inputPath));
    const expectedBytes = await readFile(resolve(stageDir, fixture.expectedArgmaxPath));
    if (inputBytes.byteLength !== fixture.inputBytes || sha256(inputBytes) !== fixture.inputSha256 ||
        expectedBytes.byteLength !== fixture.expectedArgmaxBytes ||
        sha256(expectedBytes) !== fixture.expectedArgmaxSha256) {
      throw new Error(`Browser reference fixture ${fixture.case} failed integrity validation`);
    }
    fixtures.push({ fixture, inputBytes, expectedBytes });
  }
  if (fixtures.length !== 3) throw new Error('Exactly three browser reference fixtures are required');

  const port = Number(argument('--port', '4321'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn('bash', ['web/run.sh', String(port)], {
    cwd: appDir,
    stdio: 'ignore'
  });
  let browser;
  try {
    await waitForServer(`${baseUrl}/harness.html`, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route(`${baseUrl}/__candidate.onnx`, route => route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: candidateBytes
    }));
    const routedFixtures = [];
    for (const { fixture, inputBytes, expectedBytes } of fixtures) {
      const inputUrl = `${baseUrl}/__browser-reference-${fixture.case}-input.bin`;
      const expectedUrl = `${baseUrl}/__browser-reference-${fixture.case}-expected.bin`;
      await page.route(inputUrl, route => route.fulfill({ status: 200, body: inputBytes }));
      await page.route(expectedUrl, route => route.fulfill({ status: 200, body: expectedBytes }));
      routedFixtures.push({
        case: fixture.case,
        inputUrl,
        expectedUrl,
        expectedClasses: fixture.expectedClasses
      });
    }
    await page.goto(`${baseUrl}/harness.html`);
    await page.addScriptTag({ url: `${baseUrl}/wasm/ort.webgpu.min.js` });

    const providers = [];
    providers.push(await validateProvider(
      page,
      'wasm',
      `${baseUrl}/__candidate.onnx`,
      routedFixtures,
      conversion.model.outChannels,
      conversion.model.roiSize
    ));
    const webGpuAvailable = await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      return !!(await navigator.gpu.requestAdapter());
    });
    if (webGpuAvailable) {
      providers.push(await validateProvider(
        page,
        'webgpu',
        `${baseUrl}/__candidate.onnx`,
        routedFixtures,
        conversion.model.outChannels,
        conversion.model.roiSize
      ));
    } else if (requireWebGpu) {
      throw new Error('WebGPU is required but unavailable in the validation browser');
    }

    const passed = providers.every(provider =>
      provider.cases.every(caseResult => caseResult.argmaxAgreement >= 0.99)
    );
    const report = {
      schemaVersion: 1,
      status: passed ? 'passed' : 'failed',
      candidate: {
        precision: candidate.precision,
        path: candidate.path,
        bytes: candidate.bytes,
        sha256: candidate.sha256
      },
      webGpuAvailable,
      webGpuRequired: requireWebGpu,
      providers
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!passed) throw new Error('Browser model validation failed');
    process.stdout.write(`Wrote ${outputPath}: passed\n`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch(error => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
