import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function readJob(path) {
  const job = JSON.parse(await readFile(path, 'utf8'));
  if (job.schemaVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(job.app) || !Array.isArray(job.steps) || !job.steps.length) throw new Error('Invalid offline job');
  if (!Number.isSafeInteger(job.expectedDownloads) || job.expectedDownloads < 1) throw new Error('A batch job must declare its expected download count');
  if (job.timeoutMs !== undefined && (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1)) throw new Error('Invalid job timeout');
  for (const step of job.steps) {
    if (!['upload', 'click', 'fill', 'select', 'check', 'wait'].includes(step.action) || typeof step.selector !== 'string') throw new Error('Invalid job step');
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1)) throw new Error('Invalid step timeout');
    if (step.condition && !['exists', 'enabled', 'visible', 'text', 'value'].includes(step.condition)) throw new Error('Invalid wait condition');
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

export async function runJob(contents, job, outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Output directory must be empty');
  const downloads = [];
  let downloadError;
  const pending = [];
  const names = new Set();
  const onDownload = (_event, item, owner) => {
    if (owner !== contents) return;
    const filename = basename(item.getFilename());
    if (names.has(filename)) { downloadError = new Error(`Duplicate output: ${filename}`); item.cancel(); return; }
    names.add(filename);
    item.setSavePath(join(output, filename));
    pending.push(new Promise(resolve => {
      item.once('done', (_event, state) => {
        if (state !== 'completed') { downloadError = new Error(`Output download ${filename}: ${state}`); resolve(); }
        else { downloads.push({ filename, bytes: item.getReceivedBytes() }); resolve(); }
      });
    }));
  };
  contents.session.on('will-download', onDownload);
  const evaluate = (fn, value) => contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`);
  const wait = async step => {
    const timeout = step.timeoutMs ?? job.timeoutMs ?? 900000;
    const deadline = Date.now() + timeout;
    while (!await evaluate(inspectElement, step)) {
      if (downloadError) throw downloadError;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${step.selector} (${step.condition || 'exists'})`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    contents.debugger.attach('1.3');
    for (const step of job.steps) {
      console.log(`JOB ${step.action} ${step.selector}`);
      if (step.optional && !await evaluate(inspectElement, step)) continue;
      await wait({ ...step, condition: step.action === 'click' ? 'enabled' : step.condition });
      if (step.action === 'wait') continue;
      if (step.action === 'upload') {
        const { root } = await contents.debugger.sendCommand('DOM.getDocument');
        const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: step.selector });
        await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: step.paths });
      } else {
        await evaluate(step => {
          const element = document.querySelector(step.selector);
          if (step.action === 'click') element.click();
          else {
            if (step.action === 'check') element.checked = Boolean(step.value);
            else element.value = step.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, step);
      }
    }
    const deadline = Date.now() + (job.timeoutMs || 900000);
    while (pending.length < job.expectedDownloads) {
      if (downloadError) throw downloadError;
      if (Date.now() > deadline) throw new Error(`Expected ${job.expectedDownloads} outputs, received ${pending.length}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await Promise.all(pending);
    if (downloadError) throw downloadError;
    if (downloads.length !== job.expectedDownloads || downloads.some(item => item.bytes === 0)) throw new Error('Batch output validation failed');
    const report = { app: job.app, downloads };
    await writeFile(join(output, 'job-result.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    contents.session.off('will-download', onDownload);
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}
