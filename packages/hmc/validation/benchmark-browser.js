import { prepareBenchmark } from "./benchmark-task.js";
import { browserRuntime, loadHmcBrowser } from "../src/browser.js";

window.prepareHmc = config => prepareBenchmark(config, {
  readBytes: async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Benchmark input failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  loadHmc: () => loadHmcBrowser("/packages/hmc/src/hmc.wasm"),
  runtime: browserRuntime({ workerUrl: "/packages/hmc-registration/src/worker.js", workers: config.workers }),
});
