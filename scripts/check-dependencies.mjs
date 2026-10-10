#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareFindings, dependencyFindings, dependencyGraph, validateRuntimeContracts, workspaceManifests } from '@neurodesk/dependency-quality';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({ options: { report: { type: 'string' } } });
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean).filter((file) => /^(apps|packages)\//.test(file));
const manifests = await workspaceManifests(root);
const graph = await dependencyGraph(root, files);
const runtimeContracts = JSON.parse(await readFile(new URL('../config/dependency-runtime-contracts.json', import.meta.url), 'utf8'));
validateRuntimeContracts(graph, runtimeContracts);
const findings = dependencyFindings(graph, manifests, runtimeContracts);
if (values.report) {
  await writeFile(values.report, `${JSON.stringify(findings, null, 2)}\n`);
  console.log(`Recorded ${findings.length} findings in ${values.report}. This does not update the baseline.`);
} else {
  const baseline = JSON.parse(await readFile(new URL('../config/dependency-baseline.json', import.meta.url), 'utf8'));
  if (baseline.some((finding) => !finding.reason?.trim())) throw new Error('Every baseline finding needs a specific reason.');
  const { added, removed } = compareFindings(findings, baseline);
  for (const { rule, from, to } of added) console.error(`${rule}: ${from} -> ${to}`);
  if (removed.length) {
    console.error('Remove resolved findings from config/dependency-baseline.json:');
    for (const { rule, from, to } of removed) console.error(`${rule}: ${from} -> ${to}`);
  }
  console.log(`Checked ${graph.length} source modules; ${findings.length} existing findings; ${added.length} new findings.`);
  process.exitCode = added.length || removed.length ? 1 : 0;
}
