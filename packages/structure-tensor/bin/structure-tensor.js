#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import {
  analyseStructureTensorFile,
  assertNonEmptyString,
  checkInstallation,
  OPTIONS,
  optionName,
  rejectDisallowedFlags,
} from "../src/node.js";

const USAGE = `structure-tensor ${packageJson.version} — 2D and 3D Gaussian structure-tensor fibre orientation analysis

Usage:
  structure-tensor <input> [input2 ...] <output-dir> [options]
  structure-tensor self-check [--cache-dir <dir>]

Inputs:
  One TIFF, NIfTI (.nii/.nii.gz), PNG, or JPEG image/stack, a directory of 2D slices,
  or multiple 2D slice files forming a 3D stack.

Options:
${Object.entries(OPTIONS)
    .map(([key, spec]) => {
      const flag = `--${optionName(key)}`;
      const def = spec.default !== undefined ? ` (default: ${spec.default})` : "";
      return `  ${flag.padEnd(20)} ${spec.description}${def}`;
    })
    .join("\n")}
  -h, --help           Show this help
  -v, --version        Print the version
`;

const PARSE_OPTIONS = {
  sigma: { type: "string" },
  rho: { type: "string" },
  "min-coherency": { type: "string" },
  "min-energy": { type: "string" },
  "cache-dir": { type: "string" },
  overwrite: { type: "boolean" },
  offline: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const SELF_CHECK_ALLOWED = new Set(["cache-dir", "offline", "help", "version"]);
const RUN_ALLOWED = new Set(["sigma", "rho", "min-coherency", "min-energy", "overwrite", "offline", "help", "version"]);

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: PARSE_OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const command = positionals[0];
  if (command === "self-check") {
    rejectDisallowedFlags(values, SELF_CHECK_ALLOWED, "self-check");
    if (positionals.length > 1) {
      throw new Error(`self-check takes no positional arguments, got '${positionals.slice(1).join(" ")}'.`);
    }
    const cacheDir = assertNonEmptyString(values["cache-dir"], "cache-dir");
    const result = await checkInstallation({ cacheDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  rejectDisallowedFlags(values, RUN_ALLOWED, "structure-tensor");
  if (positionals.length < 2) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const inputs = positionals.slice(0, -1);
  const outputDir = positionals[positionals.length - 1];
  const result = await analyseStructureTensorFile({
    inputs,
    outputDir,
    options: values,
    onProgress: (fraction, stage) => {
      if (process.stderr.isTTY && stage) {
        process.stderr.write(`\r${stage} (${Math.round(fraction * 100)}%)   `);
      }
    },
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  process.stdout.write(`${JSON.stringify({
    outputDir: result.outputDir,
    dimensions: result.dimensions,
    dominant: result.dominant,
    outputs: result.outputs,
    seconds: result.seconds,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`structure-tensor: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
