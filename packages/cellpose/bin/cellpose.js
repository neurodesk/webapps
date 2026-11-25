#!/usr/bin/env node
process.env.ORT_DISABLE_TELEMETRY ??= "1";
import { parseArgs } from "node:util";
import {
  assertNonEmptyString,
  checkInstallation,
  downloadModels,
  optionName,
  OPTIONS,
  rejectDisallowedFlags,
  segmentFile,
} from "../src/node.js";

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === "boolean"
    ? ""
    : option.enum
      ? ` ${option.enum.join("|")}`
      : option.type === "string"
        ? " DIR"
        : " N";
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === "boolean" ? "" : ` Default ${option.default}.`;
  return `${flag}\n      ${option.description}${fallback}`;
}).join("\n");

const HELP = `Usage: cellpose INPUT OUTPUT_DIR [options]
       cellpose download-models [--cache-dir DIR] [--offline]
       cellpose self-check [--cache-dir DIR]

Segment cells and nuclei in 2D images or 3D multi-page TIFF/OME-TIFF stacks
using pretrained Cellpose 3 models (cyto3 and nuclei) on CPU, using the exact
same flow dynamics and mask clustering as the Cellpose web app.

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <stem>_cellpose_labels.tif, <stem>_cellpose_cells.csv and
<stem>_cellpose_provenance.json into OUTPUT_DIR, which must be new or empty
unless --overwrite is passed.`;

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
    const models = await downloadModels({
      ...(cacheDir ? { cacheDir } : {}),
      ...(values.offline !== undefined ? { offline: Boolean(values.offline) } : {}),
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    console.log(`${models.count} model files verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) {
      throw new Error("Give one input image/stack (TIFF, OME-TIFF or PNG) and an output directory. Use --help for options.");
    }
    const [inputPath, outputDir] = positionals;
    let lastStage = "";
    const result = await segmentFile({
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
      `Cellpose ${result.provenance.model} finished in ${result.seconds.toFixed(2)} s · ${result.count} cells\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
