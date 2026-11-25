#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeFile, checkInstallation } from "../src/node.js";

const HELP = `Usage: skin-chromophore INPUT OUTPUT_DIR [options]
       skin-chromophore self-check

Compute quantitative skin colorimetry (CIE L*a*b*, ITA°, CIEDE2000),
uncalibrated RGB Erythema/Melanin Index proxies, and fixed-basis hemoglobin
and melanin optical-density proxy maps on one JPEG or PNG image.

Options:
  --white-balance      Apply Shades of Gray (p=6) linear-RGB white balance
  --no-mask-vignette   Disable dark dermoscope vignette border masking
  --roi-mode MODE      ROI selection: auto (default) or central
  --max-side N         Max analysis longest side in pixels (default 1024)
  --overwrite          Allow writing into a non-empty output directory
  -h, --help           Show this help

Writes <stem>_hemoglobin.png, <stem>_melanin.png, <stem>_ita.png,
<stem>_colorimetry.csv, and <stem>_provenance.json into OUTPUT_DIR.`;

const STRING_OPTIONS = ["cache-dir", "roi-mode", "max-side"];

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
      "white-balance": { type: "boolean" },
      "no-mask-vignette": { type: "boolean" },
      "roi-mode": { type: "string" },
      "max-side": { type: "string" },
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
      `0 model files: skin-chromophore is deterministic and has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`,
    );
  } else {
    if (values["cache-dir"] !== undefined) {
      throw new Error("--cache-dir only applies to download-models.");
    }
    validateOptions(
      values,
      ["white-balance", "no-mask-vignette", "roi-mode", "max-side", "overwrite"],
      "skin-chromophore",
    );
    if (positionals.length !== 2) {
      throw new Error("Provide an input image (JPEG/PNG) and an output directory. Use --help for options.");
    }
    let lastStage = "";
    const result = await analyzeFile({
      input: positionals[0],
      outputDir: positionals[1],
      whiteBalance: Boolean(values["white-balance"]),
      maskVignette: !values["no-mask-vignette"],
      roiMode: values["roi-mode"] ?? "auto",
      maxSide: values["max-side"] ?? 1024,
      overwrite: Boolean(values.overwrite),
      onProgress: (_fraction, stage) => {
        if (stage && stage !== lastStage) {
          lastStage = stage;
          process.stderr.write(`${stage}\n`);
        }
      },
    });
    const de = result.analysis.roi.comparison.deltaE2000;
    process.stderr.write(
      `Done in ${result.seconds.toFixed(2)} s · ΔE2000=${Number.isFinite(de) ? de.toFixed(2) : "n/a"} · target=${result.analysis.roi.target.pixelCount} px\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
