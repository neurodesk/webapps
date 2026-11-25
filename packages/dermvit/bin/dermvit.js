#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, classifyFile, downloadModels } from "../src/node.js";

const HELP = `Usage: dermvit INPUT OUTPUT_DIR [options]
       dermvit download-models [--cache-dir DIR] [--offline]
       dermvit self-check [--cache-dir DIR]

Classify a dermoscopic JPEG or PNG lesion image across the 7 HAM10000 classes
locally on the CPU using the pinned quantized ViT-Base-Patch16-224 ONNX model
and optional 5x5 occlusion sensitivity mapping.

Options:
  --color-constancy   Apply Shades of Gray (p=6) color constancy before resize
  --saliency          Compute 5x5 occlusion sensitivity PNG overlay (25 passes)
  --threads N         ONNX Runtime CPU threads (default SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR     Model directory (default NEURODESK_DERMVIT_MODEL_DIR or
                      ~/.cache/neurodesk/dermvit/<revision>)
  --offline           Never download; fail if the ONNX model is missing
  --overwrite         Allow writing into a non-empty output directory
  -h, --help          Show this help

Writes <stem>_dermvit-predictions.csv, <stem>_dermvit-provenance.json, and
(with --saliency) <stem>_dermvit-saliency.png into OUTPUT_DIR.
Research and educational use only — uncalibrated softmax scores are not a
clinical diagnosis.`;

const STRING_OPTIONS = ["threads", "cache-dir"];

function validateOptions(values, allowed, context) {
  const allowedSet = new Set(allowed);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!allowedSet.has(key)) {
      throw new Error(`--${key} is not valid with ${context}.`);
    }
    if (STRING_OPTIONS.includes(key) && String(value).trim() === "") {
      throw new Error(`--${key} requires a non-empty value.`);
    }
  }
}

const reportProgress = () => {
  let previous;
  return (_fraction, message) => {
    if (!message || message === previous) return;
    previous = message;
    process.stderr.write(`${message}\n`);
  };
};

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "color-constancy": { type: "boolean" },
      saliency: { type: "boolean" },
      threads: { type: "string" },
      "cache-dir": { type: "string" },
      offline: { type: "boolean" },
      overwrite: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    validateOptions(values, ["cache-dir", "offline"], "self-check");
    if (positionals.length !== 1) throw new Error("self-check does not accept positional arguments.");
    console.log(JSON.stringify(await checkInstallation({ cacheDir: values["cache-dir"] })));
  } else if (command === "download-models") {
    validateOptions(values, ["cache-dir", "offline"], "download-models");
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    const onProgress = reportProgress();
    const models = await downloadModels({
      cacheDir: values["cache-dir"],
      offline: values.offline,
      onProgress: (message) => onProgress(undefined, message),
    });
    console.log(`${models.count} model file(s) verified in ${models.directory}`);
  } else {
    validateOptions(
      values,
      ["color-constancy", "saliency", "threads", "cache-dir", "offline", "overwrite"],
      "dermvit",
    );
    if (positionals.length !== 2) {
      throw new Error("Provide an input image (JPEG/PNG) and an output directory. Use --help for options.");
    }
    const result = await classifyFile({
      input: positionals[0],
      outputDir: positionals[1],
      colorConstancy: Boolean(values["color-constancy"]),
      computeSaliency: Boolean(values.saliency),
      threads: values.threads,
      cacheDir: values["cache-dir"],
      offline: values.offline,
      overwrite: Boolean(values.overwrite),
      onProgress: reportProgress(),
    });
    process.stderr.write(
      `Top class: ${result.summary.top.code} (${result.summary.top.label}, ${(result.summary.top.probability * 100).toFixed(1)}%) in ${result.seconds.toFixed(2)} s\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
