#!/usr/bin/env node
import { parseArgs } from "node:util";
import { PARAMETERS, checkInstallation, downloadModels, fit, optionName, parseParameters } from "../src/node.js";

const settingsHelp = Object.entries(PARAMETERS).map(([key, field]) => {
  const flag = field.type === "boolean" ? `  --[no-]${optionName(key)}` : `  --${optionName(key)} ${field.enum ? "NAME" : "N"}`;
  const fallback = field.default === undefined ? "" : ` Default ${field.default}.`;
  const choices = field.enum && field.enum.length <= 4 ? ` One of ${field.enum.join(", ")}.` : "";
  return `${flag.padEnd(34)}${field.description}${choices}${fallback}`;
}).join("\n");

const HELP = `Usage: lcmodel SPECTRUM [WATER ...] OUTPUT_DIR [options]
       lcmodel download-models [--cache-dir DIR]
       lcmodel self-check

Preprocesses single-voxel MR spectroscopy with FID-A and fits it with LCModel
6.3-1N, as the LCModel web app does. Give the raw files (Siemens twix .dat,
Siemens RDA, Siemens DICOM, GE P-file, Philips SDAT/SPAR, NIfTI-MRS, Bruker),
folders of them, or an LCModel .RAW (with its .H2O and an LCMODL control file),
then a new output directory. Water references pair with their spectra as in
the app. Several datasets (each subject's folder) are fitted one after the other
into a group table.

Settings:
${settingsHelp}
  --basis FILE                    An LCModel .BASIS file (.gz allowed) instead of the library.
  --t1 FILE                       Not supported yet: give the tissue fractions instead.
  --cache-dir DIR                 Basis-set directory (default NEURODESK_LCMODEL_MODEL_DIR or
                                  ~/.cache/neurodesk/lcmodel/<set>)
  --offline                       Never download; fail if a basis set is missing
  -h, --help                      Show this help

Writes the web app's downloads, named after the dataset: <name>_concentrations.csv,
<name>_report.html, <name>.table, <name>.coord, <name>.RAW, <name>.control and,
when they apply, <name>.H2O, <name>_edit_off.RAW, <name>_fida.json and the
tissue-corrected table and its inputs. A group adds lcmodel_group.csv and
lcmodel_group_wide.csv. OUTPUT_DIR must be new or empty. The library basis sets
are checked by size and SHA-256 on every load.`;

const options = Object.fromEntries(Object.entries(PARAMETERS).map(([key, field]) => [optionName(key), { type: field.type === "boolean" ? "boolean" : "string" }]));

function progress() {
  let previous;
  return (fraction, message) => {
    if (!message || message === previous) return;
    previous = message;
    const percent = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%`.padStart(4) : "    ";
    process.stderr.write(`${percent} ${message}\n`);
  };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      help: { type: "boolean", short: "h" },
      basis: { type: "string" },
      t1: { type: "string" },
      "cache-dir": { type: "string" },
      offline: { type: "boolean" },
      ...options,
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === "self-check") {
    if (positionals.length !== 1) throw new Error("self-check does not accept arguments.");
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === "download-models") {
    if (positionals.length !== 1) throw new Error("download-models does not accept positional arguments.");
    const onProgress = progress();
    const models = await downloadModels({
      cacheDir: values["cache-dir"],
      offline: values.offline,
      onProgress: (message) => onProgress(undefined, message),
    });
    console.log(`${models.count} basis sets verified in ${models.directory}`);
  } else {
    if (positionals.length < 2) throw new Error("Give the spectroscopy files and a new output directory. Use --help for options.");
    const result = await fit({
      inputs: positionals.slice(0, -1),
      output: positionals.at(-1),
      basis: values.basis,
      t1: values.t1,
      parameters: parseParameters(values),
      cacheDir: values["cache-dir"],
      offline: values.offline,
      onProgress: progress(),
      log: (message) => process.stderr.write(`     ${message}\n`),
    });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
