#!/usr/bin/env node
// A scripted stand-in for the SamSrf app page, so that test_ui_cli.py can drive
// run_ui_matrix.mjs's runOne without a browser. The page answers runOne's locators with
// the status lines a scenario names, and writes the downloads runOne asks for.
//
// Usage: node scripted_ui_page.mjs RUNNER_MODULE BUNDLE OUTPUT_DIR RUN_JSON SCENARIO_JSON
//
// SCENARIO_JSON: {"model": status line after the model loads, "ready": false when the
// inputs never become Ready, "outcome": status line after Run, "downloadable": whether
// "Download all" is enabled after Run, "pageErrors": messages the page throws during Run}.
// Prints the record runOne returns.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runner, bundle, output, runJson, scenarioJson] = process.argv.slice(2);
const { runOne } = await import(pathToFileURL(resolve(runner)).href);
const run = JSON.parse(runJson);
const scenario = JSON.parse(scenarioJson);
const downloads = join(output, 'downloads');
mkdirSync(downloads, { recursive: true });

let phase = 'start';
let nextDownload = null;
const listeners = {};
const statusLines = { start: '', model: scenario.model, inputs: 'Ready', run: scenario.outcome };
const download = (name, bytes) => {
  const path = join(downloads, name);
  writeFileSync(path, bytes);
  nextDownload({ path: async () => path, suggestedFilename: () => name });
};
const locator = (selector) => ({
  textContent: async () => (selector === '#statusText' ? statusLines[phase] : ''),
  selectOption: async () => {},
  setChecked: async () => {},
  evaluate: async () => {},
  setInputFiles: async () => {
    phase = selector === '#modelInput' ? 'model' : 'inputs';
  },
  isEnabled: async () => (selector === '#downloadAll' ? phase === 'run' && Boolean(scenario.downloadable) : true),
  click: async () => {
    if (selector === '#runButton') {
      phase = 'run';
      for (const message of scenario.pageErrors ?? []) listeners.pageerror?.(new Error(message));
    }
    if (selector === '#downloadAll') download(`lh_${run.id}_maps.zip`, 'zip bytes');
  },
});
const page = {
  on: (event, handler) => {
    listeners[event] = handler;
  },
  goto: async () => {},
  evaluate: async () => true,
  locator,
  getByRole: () => ({ click: async () => download(`${run.id}.json`, '{}\n') }),
  waitForFunction: async () => {
    if (phase === 'inputs' && scenario.ready === false) throw new Error('page.waitForFunction: Timeout 120000ms exceeded.');
  },
  waitForEvent: () => new Promise((settle) => {
    nextDownload = settle;
  }),
};
const browser = { newContext: async () => ({ on: () => {}, newPage: async () => page, close: async () => {} }) };
console.log(JSON.stringify(await runOne(browser, 'http://scripted.invalid/', run, bundle, join(output, 'run'), {})));
