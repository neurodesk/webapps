// Isolated child process: worker threads share this process's RSS, counted only once.
import { readFile } from "node:fs/promises";
import { loadHmcNode, nodeRuntime } from "../src/node.js";
import { prepareBenchmark } from "./benchmark-task.js";

process.once("message", async config => {
  try {
    const task = await prepareBenchmark(config, { readBytes: readFile, loadHmc: loadHmcNode, runtime: nodeRuntime({ workers: config.workers }) });
    process.send({ stage: "ready", loaded: task.loaded });
    await new Promise(resolve => process.once("message", resolve));
    await task.run();
    process.send({ stage: "measured" });
    await new Promise(resolve => process.once("message", resolve));
    const result = await task.verify();
    process.send({ stage: "verified", result });
    process.disconnect();
  } catch (error) {
    process.send?.({ stage: "error", error: error.stack ?? String(error) });
    process.exitCode = 1;
    process.disconnect();
  }
});
