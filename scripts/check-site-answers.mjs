#!/usr/bin/env node
// Fails unless a site's landing page answers (scripts/lib/site-record.mjs). The
// Worker deploy runs it after each publish, and every job that checks a site
// runs it among its checks, so a site checked without a publish has its landing
// page checked too. It loads only Node built-ins.
//
//   node scripts/check-site-answers.mjs <site URL>
import { siteAnswers } from './lib/site-record.mjs';

const url = process.argv[2];
const answer = url ? await siteAnswers({ url }) : { error: 'no URL given' };
if (answer.error) {
  console.log(`::error::${url ?? 'The site'} does not answer: ${answer.error}.`);
  process.exitCode = 1;
} else {
  console.log(`${url} answers with HTTP ${answer.status}.`);
}
