export const createServer = () => ({
  listen(_port, _host, callback) { queueMicrotask(callback); },
  address() { return { port: 1 }; },
  close() {},
});
