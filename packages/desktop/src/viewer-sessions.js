import { randomUUID } from 'node:crypto';

const commands = new Set(['viewers.list', 'viewers.state', 'viewers.crosshair', 'viewers.tab', 'viewers.regions']);

export function createViewerSessions({ maximum = 4, timeoutMs = 30000 } = {}) {
  const sessions = new Map();
  const lookup = id => {
    const session = sessions.get(id);
    if (!session || session.closed || !session.isReady()) throw new Error(`Unknown or closed viewer session: ${id}`);
    return session;
  };
  const snapshot = session => ({ id: session.id, runId: session.runId, app: session.app, createdAt: session.createdAt });
  function release(session) {
    session.closed = true;
    sessions.delete(session.id);
    session.controller.abort(new Error('Viewer session closed'));
  }
  async function close(id) {
    const session = sessions.get(id);
    if (!session || session.closed) return { id, closed: true };
    release(session);
    await session.adapter.close();
    return { id, closed: true };
  }
  return {
    assertCapacity() {
      if (sessions.size >= maximum) throw new Error(`Viewer session limit reached (${maximum}); close a session before retaining another viewer`);
    },
    add({ app, runId, adapter, isReady = () => true }) {
      this.assertCapacity();
      if (adapter.closedSignal?.aborted) throw new Error('Viewer window is closed');
      const session = { id: randomUUID(), app, runId, adapter, isReady, createdAt: new Date().toISOString(),
        controller: new AbortController(), queue: Promise.resolve(), closed: false };
      sessions.set(session.id, session);
      adapter.closedSignal?.addEventListener('abort', () => release(session), { once: true, signal: session.controller.signal });
      return snapshot(session);
    },
    list: () => [...sessions.values()].filter(session => session.isReady()).map(snapshot),
    command(id, command, args = {}) {
      if (!commands.has(command)) throw new Error(`Unsupported viewer command: ${command}`);
      const session = lookup(id);
      const result = session.queue.then(async () => {
        lookup(id);
        const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(timeoutMs)]);
        let abort;
        try {
          return await new Promise((resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) return abort();
            Promise.resolve().then(() => session.adapter.command(command, args, { signal })).then(resolve, reject);
          });
        } catch (error) {
          if (signal.aborted) await close(id);
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
        }
      });
      session.queue = result.catch(() => {});
      return result;
    },
    close,
    async closeAll() {
      await Promise.allSettled([...sessions.keys()].map(close));
    },
  };
}
