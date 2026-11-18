#!/usr/bin/env node
// Deletes a site's verified marker after one of its deployed checks failed
// (scripts/lib/site-marker.mjs), so the next run checks the site again. The
// check jobs run it only when a host assertion failed, never because the job
// was cancelled. A delete that fails fails this step and says why in the job
// summary; the job is already red because a check failed.
//
//   node scripts/revoke-site-marker.mjs --key <marker key>
//
// Reads GITHUB_TOKEN (actions: write), GITHUB_REPOSITORY, GITHUB_REF and GITHUB_API_URL.
import { appendFile } from 'node:fs/promises';
import { deleteMarker } from './lib/site-marker.mjs';

const index = process.argv.indexOf('--key');
const key = index >= 0 ? process.argv[index + 1] : undefined;
const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_API_URL: apiUrl } = process.env;
const result = await deleteMarker({ key, repository, ref, token, apiUrl });
const line = result.error
  ? `Could not delete the verified marker \`${key}\` of ${ref}: ${result.error}. A check failed in this run; the marker may remain until it is deleted by hand.`
  : result.deleted
    ? `Deleted the verified marker \`${key}\` of ${ref}: a check failed, so the next run checks this site again.`
    : `No verified marker \`${key}\` of ${ref} to delete.`;
console.log(result.error ? `::error::${line}` : line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (result.error) process.exitCode = 1;
