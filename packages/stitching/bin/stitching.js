#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, runStitching } from "../src/node.js";

const HELP = `Usage: stitching INPUT [INPUT...] OUTPUT_DIR [options]
       stitching self-check [--cache-dir DIR]

Pairwise phase-correlation registration, global translation optimisation and
linear-blending fusion of 2D/3D microscopy tiles, matching the Tile stitching
web app.

INPUT may be a folder containing TIFF tiles (and optional TileConfiguration.txt)
or two or more TIFF tile files.

Options:
  --layout grid|file|stage
      Initial layout source (auto-selects file if TileConfiguration.txt is
      provided, else stage if OME stage positions exist, else grid).
  --layout-file FILE
      Path to a Fiji TileConfiguration.txt file.
  --columns N
      Grid columns (1-1000). Auto-guessed from tile count when omitted.
  --rows N
      Grid rows (1-1000). Auto-guessed from tile count when omitted.
  --overlap N
      Nominal tile overlap in percent (0-95). Default 10.
  --grid-type row|row-snake|col|col-snake
      Grid traversal order. Default row.
  --grid-start top-left|top-right|bottom-left|bottom-right
      Position of the first tile. Default top-left.
  --peaks N
      Phase-correlation peaks to check by cross-correlation (1-20). Default 5.
  --threshold N
      Minimum cross-correlation r for a link (0-1). Default 0.3.
  --max-ratio N
      Outlier max/mean residual ratio (1-100). Default 2.5.
  --max-absolute N
      Outlier mean residual ceiling in pixels (0-10000). Default 3.5.
  --offline
      Run strictly offline (stitching uses no network resources).
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
      layout: { type: "string" },
      "layout-file": { type: "string" },
      columns: { type: "string" },
      rows: { type: "string" },
      overlap: { type: "string" },
      "grid-type": { type: "string" },
      "grid-start": { type: "string" },
      peaks: { type: "string" },
      threshold: { type: "string" },
      "max-ratio": { type: "string" },
      "max-absolute": { type: "string" },
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
        throw new Error("Provide a tile folder (or 2+ TIFF files) and a new output directory. Use --help for options.");
      }
      const outputDir = positionals.at(-1);
      const inputs = positionals.slice(0, -1);
      const result = await runStitching({
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
