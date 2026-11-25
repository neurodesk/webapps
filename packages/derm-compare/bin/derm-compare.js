#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkInstallation, compareFiles } from "../src/node.js";

const HELP = `Usage: derm-compare BASELINE FOLLOWUP OUTPUT_DIR [options]
       derm-compare self-check

Align a follow-up dermoscopy image onto a baseline dermoscopy image (PNG/JPEG)
with multi-scale normalized cross-correlation and quantify lesion contour
overlap and CIEDE2000 chromatic change.

Options:
  --no-normalize-color   Disable Shades of Gray (p=6) color constancy
  --no-suppress-hair     Disable directional morphological hair suppression
  --allow-scale          Allow similarity scaling (0.85 to 1.15)
  --max-angle N          Max coarse rotation search span in degrees (0..90, default 25)
  --overwrite            Allow writing into a non-empty output directory
  -h, --help             Show this help

Writes <base>_vs_<foll>_aligned.png, <base>_vs_<foll>_deltaE2000.png,
<base>_vs_<foll>_metrics.csv, and <base>_vs_<foll>_provenance.json into OUTPUT_DIR.`;

const STRING_OPTIONS = ["cache-dir", "max-angle"];

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

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      "no-normalize-color": { type: "boolean" },
      "no-suppress-hair": { type: "boolean" },
      "allow-scale": { type: "boolean" },
      "max-angle": { type: "string" },
      overwrite: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    validateOptions(values, [], "self-check");
    if (positionals.length !== 1) throw new Error("self-check does not accept positional arguments.");
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === "download-models") {
    validateOptions(values, ["cache-dir"], "download-models");
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    console.log(
      `0 model files: derm-compare is deterministic and has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`,
    );
  } else {
    if (values["cache-dir"] !== undefined) {
      throw new Error("--cache-dir only applies to download-models.");
    }
    validateOptions(
      values,
      ["no-normalize-color", "no-suppress-hair", "allow-scale", "max-angle", "overwrite"],
      "derm-compare",
    );
    if (positionals.length !== 3) {
      throw new Error("Provide BASELINE, FOLLOWUP, and OUTPUT_DIR. Use --help for options.");
    }
    let lastStage = "";
    const res = await compareFiles({
      baseline: positionals[0],
      followup: positionals[1],
      outputDir: positionals[2],
      normalizeColor: !values["no-normalize-color"],
      suppressHair: !values["no-suppress-hair"],
      allowScale: Boolean(values["allow-scale"]),
      maxAngle: values["max-angle"],
      overwrite: Boolean(values.overwrite),
      onProgress: (_fraction, stage) => {
        if (stage && stage !== lastStage) {
          lastStage = stage;
          process.stderr.write(`${stage}\n`);
        }
      },
    });
    const r = res.result.registration;
    process.stderr.write(
      `Aligned in ${res.seconds.toFixed(2)} s · NCC ${r.initialNcc.toFixed(3)} -> ${r.alignedNcc.toFixed(3)} · dx=${r.dx.toFixed(1)} dy=${r.dy.toFixed(1)} rot=${r.angleDeg.toFixed(1)}°\n`,
    );
    console.log(res.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
