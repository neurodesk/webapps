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
  --t1 FILE_OR_DIR                Same-session 3D NIfTI or DICOM series; MindMap CPU tissues.
  --fmrs-mode MODE                Functional MRS binning: sliding, blocks, or conditions.
  --fmrs-window N                 Transients per fMRS window (for sliding mode, default 4).
  --fmrs-step N                   Transient step between windows (default equals --fmrs-window).
  --events FILE                   BIDS events.tsv or CSV stimulus schedule for fMRS.
  --[no-]match-linewidth          Equalise bin linewidths via exponential broadening (BOLD).
  --[no-]dynamic-glm              Run 2D dynamic spectral GLM across all kept transients.
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
      "fmrs-mode": { type: "string" },
      "fmrs-window": { type: "string" },
      "fmrs-step": { type: "string" },
      events: { type: "string" },
      "match-linewidth": { type: "boolean" },
      "dynamic-glm": { type: "boolean" },
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
    const fmrsModifiers = [
      ["--fmrs-window", values["fmrs-window"]],
      ["--fmrs-step", values["fmrs-step"]],
      ["--events", values.events],
      ["--match-linewidth", values["match-linewidth"]],
      ["--dynamic-glm", values["dynamic-glm"]],
    ].filter(([, v]) => v !== undefined);
    if (!values["fmrs-mode"] && fmrsModifiers.length) {
      throw new Error(`${fmrsModifiers.map(([flag]) => flag).join(", ")} require --fmrs-mode (sliding, blocks, or conditions).`);
    }
    const parsePosInt = (flag, raw) => {
      if (raw === undefined) return undefined;
      if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
        throw new Error(`${flag} must be a positive integer, not "${raw}".`);
      }
      return Number(raw);
    };
    let fmrs;
    if (values["fmrs-mode"] !== undefined) {
      const mode = values["fmrs-mode"];
      if (!["sliding", "blocks", "conditions"].includes(mode)) {
        throw new Error(`--fmrs-mode must be one of sliding, blocks, conditions, not "${mode}".`);
      }
      fmrs = {
        mode,
        windowSize: parsePosInt("--fmrs-window", values["fmrs-window"]) ?? 4,
        stepSize: parsePosInt("--fmrs-step", values["fmrs-step"]),
        matchLinewidth: Boolean(values["match-linewidth"]),
        dynamicGlm: Boolean(values["dynamic-glm"]),
      };
    }
    const result = await fit({
      inputs: positionals.slice(0, -1),
      output: positionals.at(-1),
      basis: values.basis,
      t1: values.t1,
      events: values.events,
      fmrs,
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
