#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, downloadModels, runLightsheetAtlas } from "../src/node.js";

const HELP = `Usage: lightsheet-atlas INPUT OUTPUT_DIR [options]
       lightsheet-atlas download-models [--cache-dir DIR] [--offline]
       lightsheet-atlas self-check [--cache-dir DIR]

Register a cleared mouse brain stack (TIFF, OME-TIFF, TIFF folder or OME-Zarr)
to the 50 µm Allen Mouse Brain CCFv3 atlas and/or detect cell candidates using
the same Greedy WASM and cellfinder pipeline as the Light-sheet atlas web app.

Options:
  --orientation CODE
      3-letter axis orientation code (e.g. psl, asr, ras). Default asr.
  --voxel-z N
      Plane spacing along z in µm (overrides file metadata).
  --voxel-y N
      Row spacing along y in µm (overrides file metadata).
  --voxel-x N
      Column spacing along x in µm (overrides file metadata).
  --no-register
      Skip Allen atlas registration (requires --detect).
  --detect
      Run cellfinder cell candidate detection.
  --soma-diameter-um N
      Expected soma diameter in µm for cell detection. Default 16.
  --ball-xy-um N
      Ball filter xy diameter in µm. Default 6.
  --ball-z-um N
      Ball filter z depth in µm. Default 15.
  --ball-overlap-fraction N
      Minimum ball filter overlap fraction (0 < f <= 1). Default 0.6.
  --sds-above-mean N
      Threshold in SDs above local mean. Default 10.
  --cache-dir DIR
      Override the Allen CCFv3 50 µm atlas directory (or NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR).
  --offline
      Refuse network downloads and require verified atlas files in the cache directory.
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
      orientation: { type: "string" },
      "voxel-z": { type: "string" },
      "voxel-y": { type: "string" },
      "voxel-x": { type: "string" },
      "no-register": { type: "boolean" },
      detect: { type: "boolean" },
      "soma-diameter-um": { type: "string" },
      "ball-xy-um": { type: "string" },
      "ball-z-um": { type: "string" },
      "ball-overlap-fraction": { type: "string" },
      "sds-above-mean": { type: "string" },
      "cache-dir": { type: "string" },
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
    } else if (command === "download-models") {
      if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
      rejectDisallowedOptions("download-models", values, ["cache-dir", "offline"]);
      const explicitCacheDir = values["cache-dir"];
      const bundledReadOnly = !explicitCacheDir && process.env.NEURODESK_OFFLINE === "1" && Boolean(process.env.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR);
      const offline = values.offline === true ? true : bundledReadOnly;
      const result = await downloadModels({
        cacheDir: explicitCacheDir,
        offline,
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      console.log(`${result.count} Allen CCFv3 atlas files verified in ${result.directory}`);
    } else {
      if (positionals.length !== 2) {
        throw new Error("Provide an input stack and a new output directory. Use --help for options.");
      }
      const [input, outputDir] = positionals;
      const result = await runLightsheetAtlas({
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
