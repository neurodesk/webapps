#!/usr/bin/env node
// Confirms that a site's public host serves the digest a deploy built
// (scripts/lib/site-record.mjs). The jobs that check a site run it before and
// after the checks, and save the site's verified marker only when both confirm,
// so checks that ran against a host serving other bytes never mark this digest.
//
//   node scripts/confirm-site-digest.mjs --url <site URL> --site <id> --digest <hex> [--marker <file>]
//
// Writes `confirmed=true` or `confirmed=false` to GITHUB_OUTPUT and, when
// confirmed, the marker file to save. It never fails the job: a host that
// cannot be read or serves another digest only leaves the marker unsaved.
// It loads only Node built-ins, so a job need not install the workspace.
import { randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { readLiveRecord } from './lib/site-record.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const site = option('--site');
const digest = option('--digest');
const marker = option('--marker');
let host;
try {
  host = new URL(option('--url')).host;
} catch {
  host = undefined;
}
const live = site && host && /^[0-9a-f]{64}$/.test(digest ?? '')
  ? await readLiveRecord({ site, host, nonce: randomUUID() })
  : { error: 'no site, URL or digest given' };
const confirmed = live.record?.digest === digest;
if (confirmed) {
  console.log(`${host} serves ${site} at ${digest}.`);
  if (marker) {
    const { GITHUB_RUN_ID: run = null, GITHUB_RUN_ATTEMPT: attempt = null, GITHUB_SHA: commit = null } = process.env;
    await writeFile(marker, `${JSON.stringify({ site, digest, run, attempt, commit, confirmedAt: new Date().toISOString() }, null, 2)}\n`);
  }
} else {
  const served = live.error ? `no readable record (${live.error})` : `digest ${live.record.digest}`;
  console.log(`::warning::${host ?? 'the host'} serves ${served}, not ${site} at ${digest ?? 'no digest'}: no verified marker is saved.`);
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `confirmed=${confirmed}\n`);
