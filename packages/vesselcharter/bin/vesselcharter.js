#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PARAMETERS, characterize, checkInstallation, optionName } from '../src/node.js';

const settingsHelp = Object.entries(PARAMETERS)
  .map(([key, field]) => {
    const suffix = field.type === 'boolean' ? ' true|false' : ' N';
    const flag = `  --${optionName(key)}${suffix}`.padEnd(34);
    const fallback = field.default === undefined ? '' : ` Default ${field.default}.`;
    return `${flag}${field.description}.${fallback}`;
  })
  .join('\n');

const HELP = `Usage: vesselcharter VESSELS.nii[.gz] OUTPUT_DIR [--brain-mask BRAIN.nii[.gz]] [options]
       vesselcharter self-check

Characterises 3D blood vessel diameter, branching, length and tortuosity from a
binary NIfTI vessel mask (such as the segmentation output of VesselBoost).

Optional inputs:
  --brain-mask FILE                 Same-grid 3D brain or ROI mask NIfTI for vessel
                                    volume fraction, length density and junction density.

Settings:
${settingsHelp}
  -h, --help                        Show this help

Writes the web app's downloads, named after VESSELS:
  <name>_vesselcharter_summary.json
  <name>_vesselcharter_graph.json
  <name>_vesselcharter_segments.csv
  <name>_vesselcharter_junctions.csv
  <name>_vesselcharter_diameter_bins.csv
  <name>_vesselcharter_diameter.nii.gz
  <name>_vesselcharter_skeleton.nii.gz
  <name>_vesselcharter_tree.mz3

OUTPUT_DIR must be new or empty. NIfTI input only.

VesselCharter has no model files. "download-models [--cache-dir DIR]" exists for
the portable packager and installs nothing.`;

const paramOptions = Object.fromEntries(
  Object.keys(PARAMETERS).map((key) => [optionName(key), { type: 'string' }]),
);

function formatSummaryLine(summary) {
  const net = summary.network;
  const medD = net.medianDiameterMm === null ? 'n/a' : `${net.medianDiameterMm.toFixed(2)} mm`;
  const roiPart = summary.roi
    ? ` · ROI density ${summary.roi.vesselLengthDensityMmPerCm3.toFixed(1)} mm/cm³ (${(summary.roi.vesselVolumeFraction * 100).toFixed(2)}% vol)`
    : '';
  return `${net.segmentCount} segments · ${net.junctionCount} junctions (${net.bifurcationCount} bifurcations) · total length ${net.totalLengthMm.toFixed(1)} mm · median diameter ${medD}${roiPart}`;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'brain-mask': { type: 'string' },
      'cache-dir': { type: 'string' },
      ...paramOptions,
    },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') {
    throw new Error('--cache-dir only applies to download-models.');
  }
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) {
      throw new Error('self-check does not accept positional arguments.');
    }
    console.log(JSON.stringify(checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) {
      throw new Error('download-models does not accept positional arguments.');
    }
    console.log(`0 model files: VesselCharter has nothing to install in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length !== 2) {
      throw new Error('Give one vessel mask NIfTI file and a new or empty output directory. Use --help for options.');
    }
    const parameters = Object.fromEntries(
      Object.keys(PARAMETERS).map((key) => [key, values[optionName(key)]]),
    );
    const result = await characterize({
      input: positionals[0],
      brainMask: values['brain-mask'] ?? null,
      output: positionals[1],
      parameters,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stderr.write(`${formatSummaryLine(result.summary)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
