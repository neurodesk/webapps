#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertNonEmptyString,
  checkInstallation,
  convertFiles,
  optionName,
  OPTIONS,
  rejectDisallowedFlags,
} from "../src/node.js";

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === "boolean"
    ? ""
    : option.enum
      ? ` ${option.enum.join("|")}`
      : " N";
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === "boolean" ? "" : ` Default ${option.default}.`;
  return `${flag}\n      ${option.description}${fallback}`;
}).join("\n");

const HELP = `Usage: omezarr-convert INPUT [INPUT2 ...] OUTPUT_DIR [options]
       omezarr-convert self-check [--cache-dir DIR]

Convert microscopy TIFF, OME-TIFF, PNG/JPEG sequences or NIfTI (.nii, .nii.gz)
to multiscale OME-Zarr (OME-NGFF 0.5 or 0.4), using the exact same readers and
writer as the OME-Zarr Converter web app.

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <stem>.ozx (NGFF 0.5) or <stem>.ome.zarr.zip (NGFF 0.4), or a
<stem>.ome.zarr/ directory with --format dir, plus <stem>_summary.json into
OUTPUT_DIR, which must be new or empty unless --overwrite is passed.`;

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
    console.log(`0 model files: omezarr-convert has no external models to install in ${resolve(cacheDir ?? ".")}`);
  } else {
    if (values["cache-dir"] !== undefined) {
      throw new Error("--cache-dir only applies to self-check or download-models.");
    }
    if (positionals.length < 2) {
      throw new Error("Give one or more input files (or a directory) and an output directory. Use --help for options.");
    }
    const outputDir = positionals.at(-1);
    const inputs = positionals.slice(0, -1);
    const result = await convertFiles({
      inputs,
      outputDir,
      options: values,
    });
    process.stderr.write(
      `NGFF ${result.summary.ngffVersion} (${result.summary.method}) finished in ${result.seconds.toFixed(2)} s · ${result.summary.levels.length} levels, ${result.summary.chunksWritten} chunks\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
