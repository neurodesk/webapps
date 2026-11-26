#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, runNeuromorph } from "../src/node.js";

const HELP = `Usage: neuromorph INPUT [INPUT...] OUTPUT_DIR [options]
       neuromorph self-check [--cache-dir DIR]

Validate, repair, and measure SWC neuron reconstructions (NeuroM 4 morphometrics,
Sholl intersections, and bifurcation angles), matching the NeuroMorph web app.

INPUT may be one or more .swc files or a directory containing .swc files.

Options:
  --sholl-step N
      Sholl sphere step in µm (> 0, <= 1000000). Default 10.
  --no-repair
      Disable nonpositive-radius and zero-length segment repair (structural
      repairs needed to form a tree still run).
  --offline
      Run strictly offline (neuromorph uses no network resources).
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
      "sholl-step": { type: "string" },
      "no-repair": { type: "boolean" },
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
      if (positionals.length < 2) {
        throw new Error("Provide at least one .swc file (or directory) and a new output directory. Use --help for options.");
      }
      const outputDir = positionals.at(-1);
      const inputs = positionals.slice(0, -1);
      const result = await runNeuromorph({
        inputs,
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
