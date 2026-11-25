#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertNonEmptyString,
  checkInstallation,
  deconvolveFile,
  optionName,
  OPTIONS,
  rejectDisallowedFlags,
} from "../src/node.js";

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === "boolean"
    ? ""
    : option.enum
      ? ` ${option.enum.join("|")}`
      : option.type === "string"
        ? " PATH"
        : " N";
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === "boolean" ? "" : ` Default ${option.default}.`;
  return `${flag}\n      ${option.description}${fallback}`;
}).join("\n");

const HELP = `Usage: deconvolution INPUT OUTPUT_DIR [options]
       deconvolution self-check [--cache-dir DIR]

Widefield and confocal 3D microscopy deconvolution (Richardson-Lucy and RL-TV)
with a theoretical Gibson-Lanni or measured PSF, using the exact same Rust/WASM
core as the Deconvolution web app.

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <stem>_deconvolved.tif, <stem>_deconvolved.nii.gz, <stem>_psf.tif and
<stem>_provenance.json into OUTPUT_DIR, which must be new or empty unless
--overwrite is passed.`;

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
    console.log(`0 model files: deconvolution has no external models to install in ${resolve(cacheDir ?? ".")}`);
  } else {
    if (values["cache-dir"] !== undefined) {
      throw new Error("--cache-dir only applies to self-check or download-models.");
    }
    if (positionals.length !== 2) {
      throw new Error("Give one input stack (TIFF or NIfTI) and an output directory. Use --help for options.");
    }
    const [inputPath, outputDir] = positionals;
    let lastStage = "";
    const result = await deconvolveFile({
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
      `${result.provenance.method} finished in ${result.seconds.toFixed(2)} s · PSF ${result.psfDims.slice().reverse().join(" × ")}\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
