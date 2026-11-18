#!/usr/bin/env node
// Writes `smoke_apps`, the SMOKE_APPS value ci.yml's site checks run with
// (scripts/lib/smoke-apps.mjs), from the event and the app-plan job's outputs.
import { appendFile } from 'node:fs/promises';
import { loadAppsRegistry } from './lib/apps-registry.mjs';
import { siteCheckApps } from './lib/smoke-apps.mjs';

const { EVENT, SCOPE, ALL_APPS, SITE_CODE, SELECTED_IDS } = process.env;
const { value, reason } = siteCheckApps(await loadAppsRegistry(), {
  event: EVENT,
  scope: SCOPE,
  plan: { all_apps: ALL_APPS, site_code: SITE_CODE, selected_ids: SELECTED_IDS },
});
const line = `Site checks cover ${reason}${value ? `: SMOKE_APPS=${value}` : ''}.`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Site checks\n\n${line}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `smoke_apps=${value}\n`);
