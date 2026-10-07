import { Tensor, createBrowserSession } from './onnx-runtime.js';

let session;

self.onmessage = async ({ data: message }) => {
  try {
    if (message.type === 'create') {
      session = await createBrowserSession(message.bytes);
      self.postMessage({ type: 'ready' });
    } else if (message.type === 'run') {
      const feeds = Object.fromEntries(
        Object.entries(message.feeds).map(([name, { type, data, dims }]) => [name, new Tensor(type, data, dims)]),
      );
      const outputs = await session.run(feeds);
      const serialized = Object.fromEntries(
        Object.entries(outputs).map(([name, tensor]) => [name, { type: tensor.type, data: tensor.data, dims: [...tensor.dims] }]),
      );
      self.postMessage({ type: 'outputs', outputs: serialized }, Object.values(serialized).map((tensor) => tensor.data.buffer));
    } else if (message.type === 'release') {
      await session?.release();
      session = null;
      self.postMessage({ type: 'released' });
      self.close();
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
