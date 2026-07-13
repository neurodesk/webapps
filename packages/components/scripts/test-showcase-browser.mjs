import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromePath = findChrome();
if (!chromePath) {
  console.warn('Skipping browser showcase smoke test: Chrome/Chromium not found.');
  process.exit(0);
}

const server = spawn(process.execPath, ['scripts/serve-showcase.mjs', '8129'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  const url = await waitForServerUrl(server);
  const result = await inspectShowcase(chromePath, url);
  if (!result.visible) throw new Error('Showcase app shell or viewer is missing.');
  if (result.sections < 6) throw new Error(`Expected at least 6 showcase sections, found ${result.sections}.`);
  const renderedText = result.text.toLowerCase();
  for (const phrase of ['FileIOController', 'Pipeline Outputs', 'Domain Plugins', 'QSM Pipeline', 'Validation Report']) {
    if (!renderedText.includes(phrase.toLowerCase())) throw new Error(`Rendered showcase text is missing "${phrase}".`);
  }
  if (result.exceptions.length) throw new Error(`Browser exceptions:\n${result.exceptions.join('\n')}`);
  console.log(`Showcase browser smoke passed at ${url}`);
} finally {
  server.kill('SIGTERM');
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser'
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith('/')) {
      const result = spawnSync('test', ['-x', candidate]);
      if (result.status === 0) return candidate;
    } else {
      const result = spawnSync('command', ['-v', candidate], { shell: true, encoding: 'utf8' });
      if (result.status === 0) return result.stdout.trim();
    }
  }
  return '';
}

function waitForServerUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for showcase server.\n${output}`)), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('exit', code => reject(new Error(`Showcase server exited with ${code}.\n${output}`)));
  });
}

async function inspectShowcase(chrome, url) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'webapp-components-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    const browserWs = await waitForDevTools(browser);
    const pageInfo = await fetch(browserWs.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/new'), { method: 'PUT' }).then(response => response.json());
    const socket = new WebSocket(pageInfo.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
      }
    });
    const send = (method, params = {}) => {
      const messageId = ++id;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise(resolve => pending.set(messageId, resolve));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const [text, sections, visible] = await Promise.all([
      send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }),
      send('Runtime.evaluate', { expression: 'document.querySelectorAll(".nd-sidebar-section").length', returnByValue: true }),
      send('Runtime.evaluate', { expression: 'Boolean(document.querySelector(".nd-app-container") && document.querySelector(".showcase-viewer"))', returnByValue: true })
    ]);
    socket.close();
    return {
      text: text.result?.result?.value || '',
      sections: sections.result?.result?.value || 0,
      visible: Boolean(visible.result?.result?.value),
      exceptions
    };
  } finally {
    browser.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function waitForDevTools(browser) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Chrome DevTools.\n${stderr}`)), 10_000);
    browser.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    browser.on('exit', code => reject(new Error(`Chrome exited with ${code}.\n${stderr}`)));
  });
}
