#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, runHisto2Mri } from "../src/node.js";

const HELP = `Usage: histo2mri MRI_NIFTI SECTION [SECTION...] OUTPUT_DIR [options]
       histo2mri self-check [--cache-dir DIR]

Register one or more 2D histology sections (TIFF, PNG or JPEG) to a 3D MRI
volume (NIfTI .nii or .nii.gz) with Greedy NMI rigid, affine, optional plane
offset/tilt search and deformable warp, matching the Histo2MRI web app.

Options:
  --axis 0|1|2|i|j|k
      MRI slice axis (0/i, 1/j, 2/k). Default 2.
  --slice N
      Initial MRI slice index along --axis (default middle slice).
  --step N
      Slice step between consecutive sections. Default 1.
  --tilt-a N, --tilt-b N
      Initial plane tilt in degrees (-30 to 30). Default 0.
  --pixel-size N
      Section pixel size in µm (overrides OME-TIFF metadata; estimated from
      tissue area when omitted).
  --contrast auto|haematoxylin|eosin|dab
      Stain contrast channel. Default auto.
  --orientation auto|0|1|2|3|4|5|6|7
      In-plane orientation search (auto tries all 8 flips/rotations). Default auto.
  --no-refine-plane
      Skip plane offset and tilt search.
  --search-offset N
      Plane search offset range in slices (0-10). Default 2.
  --search-tilt N
      Plane search tilt range in degrees (0-10). Default 4.
  --no-deformable
      Skip Greedy deformable SVF warp.
  --linear-iterations SPEC
      Greedy rigid/affine multi-resolution schedule. Default 100x50x10.
  --deformable-iterations SPEC
      Greedy deformable SVF schedule. Default 0x0x200.
  --offline
      Run strictly offline (histo2mri uses no network resources).
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
      axis: { type: "string" },
      slice: { type: "string" },
      step: { type: "string" },
      "tilt-a": { type: "string" },
      "tilt-b": { type: "string" },
      "pixel-size": { type: "string" },
      contrast: { type: "string" },
      orientation: { type: "string" },
      "no-refine-plane": { type: "boolean" },
      "search-offset": { type: "string" },
      "search-tilt": { type: "string" },
      "no-deformable": { type: "boolean" },
      "linear-iterations": { type: "string" },
      "deformable-iterations": { type: "string" },
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
      if (positionals.length < 3) {
        throw new Error("Provide an MRI NIfTI, one or more histology sections, and a new output directory. Use --help for options.");
      }
      const mriPath = positionals[0];
      const outputDir = positionals.at(-1);
      const sectionPaths = positionals.slice(1, -1);
      const result = await runHisto2Mri({
        mriPath,
        sectionPaths,
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
