#!/usr/bin/env node
import { parseArgs } from "node:util";
import { checkInstallation, runMicroscopeQc } from "../src/node.js";

const HELP = `Usage: microscope-qc INPUT OUTPUT_DIR [options]
       microscope-qc self-check [--cache-dir DIR]

Microscope quality control following MetroloJ_QC definitions: bead PSF FWHM
from a z-stack or field illumination uniformity & centering from a 2D image.

Options:
  --analysis auto|psf|field
      Analysis mode (auto chooses psf for z-stacks, field for 2D images).

PSF options (--analysis psf or auto on z-stacks):
  --microscope widefield|confocal|spinning|multiphoton
      Microscope modality (reads OME-XML if omitted; default widefield).
  --na N
      Objective numerical aperture (0 < NA <= 1.7; reads OME-XML if omitted).
  --refractive-index N
      Immersion refractive index (1-2; reads OME-XML if omitted).
  --emission N
      Emission wavelength in nm (200-2000; required for widefield/spinning).
  --excitation N
      Excitation wavelength in nm (200-2000; required for confocal/multiphoton).
  --pixel-x N, --pixel-y N, --z-step N
      Voxel spacing in µm (overrides TIFF/OME metadata).
  --box-radius N
      Bead crop box radius in µm (default 4 × theoretical lateral FWHM).
  --prominence N
      Minimum peak prominence in grey levels (default 10 background SDs).
  --min-r2 N
      Minimum adjusted R² across x, y, z fits (0-1). Default 0.95.
  --include-saturated
      Do not reject beads containing saturated voxels.

Field illumination options (--analysis field or auto on 2D images):
  --step N
      Iso-intensity zone step in percent (integer 1-50). Default 10.
  --no-blur
      Skip the 2 px ImageJ Gaussian pre-blur.
  --reference-max
      Use the maximum pixel instead of the top iso-intensity zone centroid.

General:
  --offline
      Run strictly offline (microscope-qc uses no network resources).
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
      analysis: { type: "string" },
      microscope: { type: "string" },
      na: { type: "string" },
      "refractive-index": { type: "string" },
      emission: { type: "string" },
      excitation: { type: "string" },
      "pixel-x": { type: "string" },
      "pixel-y": { type: "string" },
      "z-step": { type: "string" },
      "box-radius": { type: "string" },
      prominence: { type: "string" },
      "min-r2": { type: "string" },
      "include-saturated": { type: "boolean" },
      step: { type: "string" },
      "no-blur": { type: "boolean" },
      "reference-max": { type: "boolean" },
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
      if (positionals.length !== 2) {
        throw new Error("Provide an input TIFF image/stack and a new output directory. Use --help for options.");
      }
      const [input, outputDir] = positionals;
      const result = await runMicroscopeQc({
        input,
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
