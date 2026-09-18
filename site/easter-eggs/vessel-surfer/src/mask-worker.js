import { decodeMask } from "./mask.js";
self.onmessage = async ({ data }) => {
  try {
    const mask = await decodeMask(data);
    self.postMessage({ mask }, [mask.field.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
