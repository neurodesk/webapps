import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function openDesktop(command, args, { env = process.env } = {}) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let stderr = '';
  let closed = false;
  let outcome;
  const terminationSignals = [];
  const fail = error => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-65536); });
  child.once('error', fail);
  child.stdin.on('error', fail);
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    outcome = { code, signal };
    fail(new Error(`Desktop exited (${code ?? signal}): ${stderr}`));
    resolve();
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.jsonrpc !== '2.0') throw new Error('Invalid desktop JSON-RPC response');
      const request = pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(message.error.message));
      else if ('result' in message) request.resolve(message.result);
      else request.reject(new Error('Desktop response has no result'));
      pending.delete(message.id);
    } catch (error) { fail(error); }
  });
  function request(method, params = {}, { signal, timeoutMs = 30000 } = {}) {
    signal?.throwIfAborted();
    if (failure || closed) return Promise.reject(failure ?? new Error('Desktop is closed'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const finish = action => value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(id);
        action(value);
      };
      const abort = () => entry.reject(signal.reason);
      const timer = setTimeout(() => entry.reject(new Error(`Desktop request timed out: ${method}`)), timeoutMs);
      const entry = { resolve: finish(resolve), reject: finish(reject) };
      pending.set(id, entry);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return {
    diagnostics() { return { pid: child.pid, exit: outcome, terminationSignals: [...terminationSignals], stderr }; },
    async initialize(options) {
      await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'neurodesk-neuroflow', version: '1.0.0' } }, options);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async tool(name, args, options) {
      const result = await request('tools/call', { name, arguments: args }, options);
      const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (result.isError) throw new Error(text || `Desktop tool failed: ${name}`);
      return result.structuredContent ?? JSON.parse(text);
    },
    resource(uri, options) { return request('resources/read', { uri }, options); },
    async close() {
      child.stdin.end();
      const terminate = setTimeout(() => {
        terminationSignals.push('SIGTERM');
        child.kill('SIGTERM');
      }, 3000);
      const kill = setTimeout(() => {
        terminationSignals.push('SIGKILL');
        child.kill('SIGKILL');
      }, 5000);
      try { await exit; }
      finally { clearTimeout(terminate); clearTimeout(kill); lines.close(); }
    },
  };
}
