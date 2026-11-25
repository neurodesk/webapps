#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertNonEmptyString,
  checkInstallation,
  detectSpotsFile,
  optionName,
  OPTIONS,
  rejectDisallowedFlags,
} from "../src/node.js";

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === "boolean"
    ? ""
    : option.type === "string"
      ? " PATH"
      : " N";
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === "boolean" ? "" : ` Default ${option.default}.`;
  return `${flag}\n      ${option.description}${fallback}`;
}).join("\n");

const HELP = `Usage: spot-detection INPUT OUTPUT_DIR [options]
       spot-detection self-check [--cache-dir DIR]

Detect smFISH spots in a 2D image or 3D TIFF stack with Big-FISH's LoG
detector, automatic elbow threshold, Gaussian sub-pixel localization and
optional per-cell counting, using the exact same pipeline as the Spot
detection web app.

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <stem>[_mip]_spots.csv, <stem>[_mip]_spots.nii.gz, optional
<stem>[_mip]_cell_counts.csv (with --labels) and <stem>[_mip]_provenance.json
into OUTPUT_DIR, which must be new or empty unless --overwrite is passed.`;

const cliOptions = Object.fromEntries(
  Object.entries(OPTIONS).map(([key, option]) => [
    optionName(key),
    { type: option.type === "boolean" ? "boolean" : "string" },
  ]),
);

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      ...cliOptions,
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    if (positionals.length !== 1) throw new Error("self-check does not accept positional arguments.");
    rejectDisallowedFlags(values, new Set(["cache-dir", "help"]), "self-check");
    const cacheDir = assertNonEmptyString(values["cache-dir"], "cache-dir");
    console.log(JSON.stringify(await checkInstallation({ cacheDir })));
  } else if (command === "download-models") {
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    rejectDisallowedFlags(values, new Set(["cache-dir", "offline", "help"]), "download-models");
    const cacheDir = assertNonEmptyString(values["cache-dir"], "cache-dir");
    console.log(`0 model files: spot-detection has no external models to install in ${resolve(cacheDir ?? ".")}`);
  } else {
    if (values["cache-dir"] !== undefined) {
      throw new Error("--cache-dir only applies to self-check or download-models.");
    }
    if (positionals.length !== 2) {
      throw new Error("Give one input TIFF image/stack and an output directory. Use --help for options.");
    }
    const [inputPath, outputDir] = positionals;
    let lastStage = "";
    const result = await detectSpotsFile({
      input: inputPath,
      outputDir,
      options: values,
      onProgress: (_fraction, stage) => {
        if (stage && stage !== lastStage) {
          lastStage = stage;
          process.stderr.write(`${stage}\n`);
        }
      },
    });
    process.stderr.write(
      `Detected ${result.spots} spots (threshold ${result.threshold}) in ${result.seconds.toFixed(2)} s\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
