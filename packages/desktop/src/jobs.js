import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseContract, validateRequest } from './contracts.js';
import { describeFile, verifyRunReport } from './reports.js';

export async function readJob(path) {
  const job = JSON.parse(await readFile(path, 'utf8'));
  if (job.schemaVersion === 2) {
    if (Object.keys(job).some(key => !['schemaVersion', 'app', 'automation', 'request'].includes(key))
        || Object.keys(job.automation ?? {}).some(key => key !== 'contract')) throw new Error('Invalid operation job');
    const contract = parseContract(job.automation?.contract);
    if (contract.schemaVersion !== 2 || contract.app !== job.app) throw new Error('Job contract app mismatch');
    const request = await validateRequest(contract, job.request);
    if (request.engine !== 'browser' || request.retainViewer) throw new Error('Operation jobs use the browser engine without retained viewers');
    return { schemaVersion: 2, app: job.app, automation: { contract }, request };
  }
  if (job.schemaVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(job.app) || !Array.isArray(job.steps) || !job.steps.length) throw new Error('Invalid offline job');
  if (!Number.isSafeInteger(job.expectedDownloads) || job.expectedDownloads < 1) throw new Error('A batch job must declare its expected download count');
  if (job.timeoutMs !== undefined && (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1)) throw new Error('Invalid job timeout');
  if (job.failSelector !== undefined && job.failSelector !== null && (typeof job.failSelector !== 'string' || !job.failSelector)) throw new Error('Invalid failure selector');
  if (job.automation) {
    job.automation.contract = parseContract(job.automation.contract);
    if (job.automation.contract.app !== job.app) throw new Error('Job contract app mismatch');
  }
  for (const step of job.steps) {
    if (!['upload', 'click', 'fill', 'select', 'check', 'wait'].includes(step.action) || typeof step.selector !== 'string') throw new Error('Invalid job step');
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1)) throw new Error('Invalid step timeout');
    if (step.condition && !['exists', 'enabled', 'visible', 'text', 'value', ...(job.automation ? ['state'] : [])].includes(step.condition)) throw new Error('Invalid wait condition');
    if (step.action === 'upload') {
      if (!Array.isArray(step.paths) || !step.paths.length) throw new Error('Upload requires local paths');
      step.paths = step.paths.map(value => resolve(dirname(path), value));
      for (const file of step.paths) if (!(await stat(file)).isFile()) throw new Error(`Input is not a file: ${file}`);
    }
  }
  return job;
}

const inspectElement = ({ selector, condition, value }) => {
  const element = document.querySelector(selector);
  if (!element) return false;
  if (condition === 'enabled') return !element.disabled;
  if (condition === 'text') return element.textContent.includes(value);
  if (condition === 'value') return element.value === value;
  if (condition === 'visible') return Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
  return true;
};

// Apps report failures in their status line with an `error` class. A job that
// only waits for success would otherwise sit until its timeout.
const DEFAULT_FAIL_SELECTOR = '#statusText.error';
const readFailure = selector => {
  const element = document.querySelector(selector);
  return element ? (element.textContent.trim() || 'unspecified error') : null;
};

const readRun = selector => {
  const element = document.querySelector(selector);
  return element ? JSON.parse(element.textContent) : null;
};

export async function runJob(contents, job, { signal, onProgress = () => {}, artifacts }) {
  const contract = job.automation?.contract;
  const inputs = {};
  let previousRunId;
  let currentRunId;
  let snapshot;
  const deadline = Date.now() + (job.timeoutMs ?? 900000);
  const bounded = async promise => {
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        timer = setTimeout(() => reject(new Error('Job timed out waiting for the browser')), Math.max(1, deadline - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        Promise.resolve(promise).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  const evaluate = (fn, value) => bounded(contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`));
  const check = async (timeoutMessage = `Job timed out after ${job.timeoutMs ?? 900000} ms`) => {
    signal?.throwIfAborted();
    artifacts.assertHealthy();
    if (Date.now() > deadline) throw new Error(timeoutMessage);
    if (contract) {
      snapshot = await evaluate(readRun, contract.lifecycle.snapshotSelector);
      if (snapshot && snapshot.runId !== previousRunId) {
        if (currentRunId && snapshot.runId !== currentRunId) throw new Error('App run changed during the job');
        currentRunId = snapshot.runId;
        if (snapshot.state === 'failed') throw new Error(`${job.app} reported an error: ${snapshot.message}`);
        if (snapshot.state === 'cancelled') throw new Error(`${job.app} was cancelled`);
        onProgress(snapshot);
      }
    } else {
      const failSelector = job.failSelector === null ? null : (job.failSelector ?? DEFAULT_FAIL_SELECTOR);
      if (failSelector) {
        const message = await evaluate(readFailure, failSelector);
        if (message !== null) throw new Error(`${job.app} reported an error: ${message}`);
      }
    }
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const wait = async step => {
    const stepDeadline = Date.now() + (step.timeoutMs ?? job.timeoutMs ?? 900000);
    for (;;) {
      await check(`Timed out waiting for ${step.selector} (${step.condition || 'exists'})`);
      if (step.condition === 'state') {
        if (snapshot?.state === step.value && snapshot.runId !== previousRunId) {
          currentRunId = snapshot.runId;
          return;
        }
      } else if (await evaluate(inspectElement, step)) return;
      if (Date.now() > stepDeadline) throw new Error(`Timed out waiting for ${step.selector} (${step.condition || 'exists'})`);
      await pause();
    }
  };
  try {
    signal?.throwIfAborted();
    contents.debugger.attach('1.3');
    await evaluate(selectors => {
      for (const selector of selectors) document.querySelector(selector);
    }, [...job.steps.map(step => step.selector), ...(job.failSelector ? [job.failSelector] : [])]);
    if (contract) {
      for (const step of job.steps.filter(step => step.action === 'upload')) inputs[step.input] = await describeFile(step.paths[0]);
    }
    const performSteps = async () => {
      for (const step of job.steps) {
        console.error(`JOB ${step.action} ${step.selector}`);
        if (step.optional && !await evaluate(inspectElement, step)) continue;
        await wait({ ...step, condition: step.action === 'click' ? 'enabled' : step.condition });
        if (step.action === 'wait') continue;
        if (contract && (step.action === 'upload' || step.selector === contract.controls.run)) {
          previousRunId = (await evaluate(readRun, contract.lifecycle.snapshotSelector))?.runId;
          currentRunId = undefined;
        }
        if (step.action === 'upload') {
          const { root } = await bounded(contents.debugger.sendCommand('DOM.getDocument'));
          const { nodeId } = await bounded(contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: step.selector }));
          await bounded(contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: step.paths }));
        } else {
          const trigger = () => evaluate(step => {
            const element = document.querySelector(step.selector);
            if (step.action === 'click') element.click();
            else {
              if (step.action === 'check') element.checked = Boolean(step.value);
              else element.value = step.value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, step);
          if (step.artifact) {
            await artifacts.download(step.artifact, trigger, check);
          } else await trigger();
        }
      }
    };
    if (contract) await performSteps();
    else await artifacts.collectUnlabelled(job.expectedDownloads, performSteps, received => {
      if (Date.now() > deadline) throw new Error(`Expected ${job.expectedDownloads} outputs, received ${received}`);
      return check();
    });
    await check();
    if (contract && snapshot?.runId !== currentRunId) throw new Error('App run changed before its outputs were saved');
    return await artifacts.verify(({ output, downloads }) => {
      if (downloads.length !== job.expectedDownloads) throw new Error('Batch output validation failed');
      return contract ? verifyRunReport({ contract, snapshot, downloads, output, inputs }) : { app: job.app, downloads };
    });
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
