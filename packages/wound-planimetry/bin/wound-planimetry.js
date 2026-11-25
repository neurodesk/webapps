#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkInstallation, measureFile } from "../src/node.js";

const HELP = `Usage: wound-planimetry INPUT OUTPUT_DIR [options]
       wound-planimetry self-check

Segment a wound bed from a clinical JPEG or PNG photograph, compute calibrated
or pixel digital planimetry geometry (area, perimeter, major/perpendicular axes,
Kundin ellipsoid area, circularity), and estimate color-based Red-Yellow-Black
(RYB) tissue fractions.

Calibration options (optional; default is uncalibrated pixel units):
  --pixels-per-mm N       Spatial scale in pixels per mm (0..1000, default 0)
  --mm-per-pixel N        Spatial scale in mm per pixel (inverse of px/mm)
  --scale-mm N            Known ruler reference length in mm (0.1..500)
  --scale-px P            Pixel distance spanning --scale-mm (alternative to --ruler)
  --ruler X1,Y1,X2,Y2     Two pixel points spanning --scale-mm on a ruler

Segmentation & RYB options:
  --sensitivity N         Otsu threshold bias (-0.3..0.3, default 0)
  --eschar-l N            Max CIE L* for black eschar (0..60, default 28)
  --granulation-a N       Min CIE a* for red granulation (0..80, default 22)
  --slough-b N            Min CIE b* for yellow slough (0..80, default 18)
  --seed X,Y              Optional pixel seed inside the wound bed
  --overlay-opacity N     RYB overlay alpha (0..1, default 0.55)
  --overwrite             Allow writing into a non-empty output directory
  -h, --help              Show this help

Writes <stem>_wound-ryb-overlay.png, <stem>_wound-mask.png,
<stem>_wound-planimetry.csv, and <stem>_wound-provenance.json into OUTPUT_DIR.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "cache-dir": { type: "string" },
      "pixels-per-mm": { type: "string" },
      "mm-per-pixel": { type: "string" },
      "scale-mm": { type: "string" },
      "scale-px": { type: "string" },
      ruler: { type: "string" },
      sensitivity: { type: "string" },
      "eschar-l": { type: "string" },
      "granulation-a": { type: "string" },
      "slough-b": { type: "string" },
      seed: { type: "string" },
      "overlay-opacity": { type: "string" },
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
    console.log(`0 model files: wound-planimetry is deterministic and has nothing to install in ${resolve(values["cache-dir"] ?? ".")}`);
  } else {
    if (positionals.length !== 2) {
      throw new Error("Provide an input image (JPEG/PNG) and an output directory. Use --help for options.");
    }
    let lastStage = "";
    const res = await measureFile({
      input: positionals[0],
      outputDir: positionals[1],
      pixelsPerMm: values["pixels-per-mm"],
      mmPerPixel: values["mm-per-pixel"],
      scaleMm: values["scale-mm"],
      scalePx: values["scale-px"],
      ruler: values.ruler,
      sensitivity: values.sensitivity,
      escharL: values["eschar-l"],
      granulationA: values["granulation-a"],
      sloughB: values["slough-b"],
      seed: values.seed,
      overlayOpacity: values["overlay-opacity"] ?? 0.55,
      overwrite: Boolean(values.overwrite),
      onProgress: (_fraction, stage) => {
        if (stage && stage !== lastStage) {
          lastStage = stage;
          process.stderr.write(`${stage}\n`);
        }
      },
    });
    const area = res.planimetry.calibrated
      ? `${res.planimetry.areaCm2.toFixed(2)} cm² (${res.planimetry.areaPx} px)`
      : `${res.planimetry.areaPx} px (uncalibrated)`;
    process.stderr.write(
      `Measured in ${res.seconds.toFixed(2)} s · area=${area} · R=${res.ryb.classes.red.percent.toFixed(1)}% Y=${res.ryb.classes.yellow.percent.toFixed(1)}% B=${res.ryb.classes.black.percent.toFixed(1)}%\n`,
    );
    console.log(res.primaryOutput);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
