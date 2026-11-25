#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, runCalciumImaging } from "../src/node.js";

const HELP = `Usage: calcium-imaging INPUT OUTPUT_DIR [options]
       calcium-imaging self-check [--cache-dir DIR]

Two-photon calcium imaging motion correction (rigid or piecewise-rigid),
local-correlation ROI detection, neuropil-corrected ΔF/F traces, and
OASIS AR(1) spike deconvolution, matching the Calcium imaging web app.

Options:
  --frame-rate N
      Movie frame rate in Hz (overrides TIFF/OME metadata; required if absent).
  --motion rigid|piecewise|none
      Motion correction mode. Default rigid.
  --max-shift N
      Maximum rigid shift in pixels (integer, 0-200). Default 10.
  --upsample N
      Sub-pixel DFT upsampling factor (integer, 1-100). Default 10.
  --normalization none|phase
      Cross-correlation normalisation. Default none.
  --template-passes N
      Template refinement passes (integer, 1-5). Default 2.
  --patch-size N
      Piecewise patch size in pixels (integer, 16-1024). Default 64.
  --patch-overlap N
      Piecewise patch overlap in pixels (integer, 0-1023). Default 32.
  --max-deviation N
      Maximum patch deviation from rigid shift in pixels (0-50). Default 3.
  --diameter N
      Expected cell diameter in pixels (3-100). Default 10.
  --seed-z N
      Local-correlation seed threshold in SDs (0.5-50). Default 4.
  --neuropil-coefficient N
      Neuropil subtraction factor (0-1.5). Default 0.7.
  --baseline-window N
      Running baseline window in seconds (1-100000). Default 60.
  --baseline-percentile N
      Running baseline percentile (0-100). Default 8.
  --no-deconvolution
      Skip OASIS AR(1) spike deconvolution.
  --no-registered
      Skip writing the registered movie TIFF.
  --offline
      Run strictly offline (calcium-imaging uses no network resources).
  -h, --help
      Show this help.`;

function rejectEmptyStringOptions(values) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) {
      throw new Error(`Option --${key} requires a non-empty value.`);
    }
  }
}

function rejectDisallowedOptions(subcommand, values, allowed) {
  const allowedSet = new Set(allowed);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowedSet.has(key)) {
      throw new Error(`Option --${key} is not valid for ${subcommand}.`);
    }
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      "frame-rate": { type: "string" },
      motion: { type: "string" },
      "max-shift": { type: "string" },
      upsample: { type: "string" },
      normalization: { type: "string" },
      "template-passes": { type: "string" },
      "patch-size": { type: "string" },
      "patch-overlap": { type: "string" },
      "max-deviation": { type: "string" },
      diameter: { type: "string" },
      "seed-z": { type: "string" },
      "neuropil-coefficient": { type: "string" },
      "baseline-window": { type: "string" },
      "baseline-percentile": { type: "string" },
      "no-deconvolution": { type: "boolean" },
      "no-registered": { type: "boolean" },
      offline: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(HELP);
  } else {
    rejectEmptyStringOptions(values);
    const [command] = positionals;
    if (command === "self-check") {
      if (positionals.length !== 1) throw new Error("self-check does not accept positional arguments.");
      rejectDisallowedOptions("self-check", values, ["cache-dir"]);
      console.log(JSON.stringify(await checkInstallation({ cacheDir: values["cache-dir"] })));
    } else {
      if (values["cache-dir"] !== undefined) {
        throw new Error("Option --cache-dir is only valid for self-check.");
      }
      if (positionals.length !== 2) {
        throw new Error("Provide an input TIFF movie and a new output directory. Use --help for options.");
      }
      const [input, outputDir] = positionals;
      const result = await runCalciumImaging({
        input,
        outputDir,
        options: values,
        onLog: (message) => process.stderr.write(`${message}\n`),
      });
      console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
