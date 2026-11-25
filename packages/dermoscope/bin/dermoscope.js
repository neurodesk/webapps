#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeFile, checkInstallation } from "../src/node.js";

const HELP = `Usage: dermoscope INPUT OUTPUT_DIR [options]
       dermoscope self-check

Run deterministic dermoscopy preprocessing (vignette masking, DullRazor hair
removal, Shades of Gray color constancy), CIE L*a*b* Otsu lesion border
segmentation, and experimental automated ABCD morphometry on one JPEG or PNG
dermoscopic image.

Options:
  --no-hair-removal             Disable DullRazor hair removal
  --no-color-constancy          Disable Shades of Gray (p=6) color constancy
  --threshold-bias N            Otsu threshold bias (-0.3 to 0.3, default 0)
  --pixels-per-mm N             Spatial calibration in px/mm (0 to 1000, default 0)
  --mm-per-pixel N              Spatial calibration in mm/px (inverse of px/mm)
  --differential-structures N   Clinician D count (0=unscored, or 1..5 for Stolz TDS)
  --overwrite                   Allow writing into a non-empty output directory
  -h, --help                    Show this help

Writes <stem>_preprocessed.png, <stem>_mask.png, <stem>_abcd_metrics.csv, and
<stem>_provenance.json into OUTPUT_DIR.
Experimental automated morphometry only — not a clinical diagnosis.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      "no-hair-removal": { type: "boolean" },
      "no-color-constancy": { type: "boolean" },
      "threshold-bias": { type: "string" },
      "pixels-per-mm": { type: "string" },
      "mm-per-pixel": { type: "string" },
      "differential-structures": { type: "string" },
      overwrite: { type: "boolean" },
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
    console.log(`0 model files: dermoscope is deterministic and has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`);
  } else {
    if (positionals.length !== 2) {
      throw new Error("Provide an input image (JPEG/PNG) and an output directory. Use --help for options.");
    }
    let lastStage = "";
    const result = await analyzeFile({
      input: positionals[0],
      outputDir: positionals[1],
      removeHair: !values["no-hair-removal"],
      colorConstancy: !values["no-color-constancy"],
      thresholdBias: values["threshold-bias"],
      pixelsPerMm: values["pixels-per-mm"],
      mmPerPixel: values["mm-per-pixel"],
      differentialStructures: values["differential-structures"],
      overwrite: Boolean(values.overwrite),
      onProgress: (_fraction, stage) => {
        if (stage && stage !== lastStage) {
          lastStage = stage;
          process.stderr.write(`${stage}\n`);
        }
      },
    });
    const s = result.run.abcd.scores;
    process.stderr.write(
      `Segmented=${result.run.segmented} · area=${result.run.abcd.geometry.areaPx} px · A=${s.A ?? "n/a"} B=${s.B ?? "n/a"} C=${s.C ?? "n/a"} (${result.seconds.toFixed(2)} s)\n`,
    );
    console.log(result.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
