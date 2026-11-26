/** The port `neurodesk-mcp` listens on unless told otherwise. */
export const agentServerPort = 4242;

/**
 * Connects the page's NiiVue viewer to an nv-mcp server on this computer, such as `neurodesk-mcp`, so an agent can
 * drive it with nv-mcp's tools. Nothing connects until `connect()`, which a person starts from the page; the client
 * then keeps retrying until `disconnect()`, so the server may start before or after.
 *
 * @param {() => any} findViewer
 * @param {{ port?: number, WebSocket?: typeof WebSocket, storage?: Pick<Storage, 'getItem' | 'setItem'> | null }} [options]
 */
export function createAgentConnection(findViewer, { port = agentServerPort, WebSocket, storage } = {}) {
  const watchers = new Set();
  let client;
  let pending;
  let generation = 0;
  const status = (connected = Boolean(client?.connected)) => ({ active: Boolean(client || pending), connected, id: client?.id ?? null });
  const report = connected => {
    const current = status(connected);
    for (const watcher of watchers) watcher(current);
  };
  return {
    port,
    get status() { return status(); },
    /** Calls `watcher` with `{ active, connected, id }` whenever the connection changes; returns a function that stops it. */
    watch(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    connect() {
      if (client) return Promise.resolve();
      if (pending) return pending;
      const viewer = findViewer();
      if (!viewer) return Promise.reject(new Error('Open an image first. There is no viewer for an agent yet.'));
      const current = ++generation;
      // The client comes with the viewer's nv-mcp, so an app without a NiiVue adapter never bundles nv-mcp.
      // Only the page's own WebSocket address: a hosted page has no proxy to try first.
      pending = viewer.nvMcp().then(({ AgentClient, handlers, state }) => {
        if (current !== generation) return;
        client = new AgentClient(handlers, {
          urls: [`ws://127.0.0.1:${port}/app`],
          state,
          onStatus: report,
          ...(WebSocket && { WebSocket }),
          ...(storage !== undefined && { storage }),
        });
        client.attach();
      }).finally(() => {
        if (current !== generation) return;
        pending = undefined;
        report();
      });
      report();
      return pending;
    },
    disconnect() {
      generation++;
      pending = undefined;
      // Cleared first, so the socket closing does not read as waiting to reconnect.
      const closing = client;
      client = undefined;
      closing?.detach();
      report(false);
    },
  };
}
