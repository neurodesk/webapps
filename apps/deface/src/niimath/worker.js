// src/worker.ts
import Module from "./niimath.js";

// src/workerImpl.ts
function outputCandidates(outName) {
  return outName.endsWith(".gz") ? [outName] : [outName, `${outName}.gz`];
}
function setupWorker(ModuleFactory) {
  let mod = null;
  let runLog = [];
  const captureModule = { print: (s) => runLog.push(s), printErr: (s) => runLog.push(s) };
  ModuleFactory(captureModule).then((initializedMod) => {
    mod = initializedMod;
    const readyMsg = { type: "ready" };
    self.postMessage(readyMsg);
  });
  self.onerror = function(event) {
    const errorMsg = {
      type: "error",
      message: typeof event === "string" ? event : event.message ?? "Unknown error",
      error: event.error?.stack ?? null
    };
    self.postMessage(errorMsg);
  };
  self.onunhandledrejection = function(event) {
    const errorMsg = {
      type: "error",
      message: event.reason?.message ?? "Unhandled rejection",
      error: event.reason?.stack ?? null
    };
    self.postMessage(errorMsg);
  };
  const handleMessage = (e) => {
    try {
      const file = e.data.blob;
      const args = e.data.cmd;
      const outName = e.data.outName ?? "out.nii";
      if (!file || args.length < 1) {
        throw new Error("Expected a file and at least one command");
      }
      const inName = file.name ?? "input.nii";
      const extraFiles = e.data.extraFiles ?? [];
      const fr = new FileReader();
      fr.onerror = function() {
        const errorMsg = {
          type: "error",
          message: `Failed to read input "${inName}": ${fr.error?.message ?? "unknown read error"}`,
          error: fr.error?.stack ?? null
        };
        self.postMessage(errorMsg);
      };
      fr.readAsArrayBuffer(file);
      fr.onload = async function() {
        if (!mod) {
          const errorMsg = {
            type: "error",
            message: "WASM module not loaded yet!",
            error: null
          };
          self.postMessage(errorMsg);
          return;
        }
        const data = new Uint8Array(fr.result);
        let stagedInput = false;
        const stagedExtras = [];
        try {
          if (!Array.isArray(args)) {
            throw new Error("Expected args to be an array");
          }
          mod.FS_createDataFile(".", inName, data, true, true);
          stagedInput = true;
          for (const f of extraFiles) {
            const bytes = new Uint8Array(await f.data.arrayBuffer());
            mod.FS_createDataFile(".", f.name, bytes, true, true);
            stagedExtras.push(f.name);
          }
          runLog = [];
          const exitCode = mod.callMain(args);
          if (exitCode !== 0) {
            const detail = runLog.join("\n").trim();
            throw new Error(`niimath exited with code ${exitCode}${detail ? `:
${detail}` : ""}`);
          }
          let actualOutName = outName;
          let out_bin = null;
          for (const candidate of outputCandidates(outName)) {
            try {
              out_bin = mod.FS_readFile(candidate);
              actualOutName = candidate;
              break;
            } catch {
            }
          }
          if (!out_bin) {
            throw new Error(`niimath completed but output "${outName}" was not found`);
          }
          const exact = new Uint8Array(out_bin.byteLength);
          exact.set(out_bin);
          const outputFile = new Blob([exact.buffer], { type: "application/sla" });
          const successMsg = {
            blob: outputFile,
            outName: actualOutName,
            exitCode
          };
          self.postMessage(successMsg);
        } catch (err) {
          const error = err;
          const errorMsg = {
            type: "error",
            message: error.message,
            error: error.stack ?? null
          };
          self.postMessage(errorMsg);
        } finally {
          if (stagedInput) {
            try {
              mod.FS_unlink(inName);
            } catch {
            }
          }
          for (const name of stagedExtras) {
            try {
              mod.FS_unlink(name);
            } catch {
            }
          }
          for (const name of outputCandidates(outName)) {
            if (inName !== name) {
              try {
                mod.FS_unlink(name);
              } catch {
              }
            }
          }
        }
      };
    } catch (err) {
      const error = err;
      const errorMsg = {
        type: "error",
        message: error.message,
        error: error.stack ?? null
      };
      self.postMessage(errorMsg);
    }
  };
  self.addEventListener("message", handleMessage, false);
}

// src/worker.ts
setupWorker(Module);
