#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { OPTIONS, checkInstallation, denoiseFile, optionName } from "../src/node.js";

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === "boolean"
    ? ""
    : option.enum
      ? ` ${option.enum.join("|")}`
      : " N";
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === "boolean" ? "" : ` Default ${option.default}.`;
  const range = option.maximum === undefined ? "" : ` ${option.minimum} to ${option.maximum}.`;
  return `${flag}\n      ${option.description}${range}${fallback}`;
}).join("\n");

const HELP = `Usage: denoise INPUT OUTPUT_DIR [options]
       denoise self-check

Self-supervised denoising of 2D images, 3D Z-stacks, and 2D+T time-series in
TIFF, OME-TIFF, ImageJ TIFF, or NIfTI (.nii, .nii.gz) format, using the exact
same scientific core as the Denoise web app (Aydin FGR, Zero-Shot Noise2Noise,
and Generalized Anscombe VST + Non-Local Means).

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <stem>_denoised.tif and/or <stem>_denoised.nii.gz (plus optional
<stem>_residual.* with --residual) and <stem>_provenance.json into OUTPUT_DIR,
which must be new or empty unless --overwrite is passed.

denoise is purely self-supervised and has no external model files.
"download-models [--cache-dir DIR]" exists for the portable packager and
installs nothing.`;

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
  if (values["cache-dir"] !== undefined && command !== "download-models") {
    throw new Error("--cache-dir only applies to download-models.");
  }
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    if (positionals.length !== 1) throw new Error("self-check does not accept arguments.");
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === "download-models") {
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    console.log(`0 model files: denoise is self-supervised and has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`);
  } else {
    if (positionals.length !== 2) {
      throw new Error("Give one input image/stack and an output directory. Use --help for options.");
    }
    const [inputPath, outputDir] = positionals;
    let lastStage = "";
    const result = await denoiseFile({
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
    const d = result.diagnostics;
    process.stderr.write(
      `${result.provenance.method} finished in ${result.seconds.toFixed(2)} s · noise σ ${d.inputNoiseSigma.toPrecision(3)} → ${d.denoisedNoiseSigma.toPrecision(3)} (drop ${d.noiseFloorDropDb.toFixed(1)} dB)\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
