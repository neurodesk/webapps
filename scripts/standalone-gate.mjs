#!/usr/bin/env node
// Decides whether a `standalone` run builds the desktop suites
// (scripts/lib/standalone-gate.mjs). Writes `run=true|false` to GITHUB_OUTPUT
// and the reason to the job summary. Any failure to decide builds.
//
//   node scripts/standalone-gate.mjs --event schedule --head <sha>
//
// A scheduled run needs GITHUB_REPOSITORY and a GITHUB_TOKEN that can read
// Actions runs.
import { appendFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { WORKFLOW, changedPaths, decideStandalone, resolvePublishedBase } from './lib/standalone-gate.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function decide() {
  const event = option('--event');
  if (!event) throw new Error('Usage: standalone-gate.mjs --event <event name> --head <sha>');
  if (event !== 'schedule') return decideStandalone({ event });
  const base = await resolvePublishedBase({ head: option('--head') || 'HEAD', cwd: repoRoot });
  if (!base.base) return decideStandalone({ event, base });
  const { head } = base;
  const paths = changedPaths({ base: base.base, head, cwd: repoRoot });
  return decideStandalone({
    event,
    base,
    head,
    changedPaths: paths,
    flow: parse(await readFile(`${repoRoot}/.github/workflows/${WORKFLOW}.yml`, 'utf8')),
    manifests: changedManifests({ base: base.base, head, cwd: repoRoot, changedPaths: paths }),
    registry: await loadAppsRegistry(),
  });
}

let decision;
try {
  decision = await decide();
} catch (error) {
  decision = { run: true, reason: `the gate could not decide (${error.message})` };
  console.log(`::warning::${WORKFLOW}: ${decision.reason}`);
}

const line = `${WORKFLOW} ${decision.run ? 'builds' : 'is skipped'}: ${decision.reason}`;
console.error(line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
else console.log(JSON.stringify(decision));
