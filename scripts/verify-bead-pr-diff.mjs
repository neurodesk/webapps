#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateWorkerChangedFiles } from './lib/beads-pr-worker.mjs';

function parseArgs(argv) {
  const args = {
    selection: 'quality-artifacts/beads-worker/selected-bead.json',
    allowUncommitted: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--selection') args.selection = argv[++i];
    else if (token === '--allow-uncommitted') args.allowUncommitted = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const selection = JSON.parse(readFileSync(resolve(cwd, args.selection), 'utf8'));
  if (!selection.selected || !selection.app || !selection.baseSha) {
    throw new Error('No selected bead in selection artifact; refusing to verify diff');
  }

  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
  if (!args.allowUncommitted && porcelain.length > 0) {
    throw new Error(`Working tree has uncommitted or untracked changes:\n${porcelain}`);
  }

  const diffRange = args.allowUncommitted ? [selection.baseSha] : [`${selection.baseSha}...HEAD`];
  const rawFiles = execFileSync('git', ['diff', '--name-only', ...diffRange], { cwd, encoding: 'utf8' });
  const files = rawFiles
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const check = validateWorkerChangedFiles(files, { app: selection.app });
  if (!check.valid) {
    throw new Error(`Diff scope check failed for apps/${selection.app}/:\n- ${check.violations.join('\n- ')}`);
  }

  // Also check whitespace / conflict markers cleanly
  execFileSync('git', ['diff', '--check', ...diffRange], { cwd, stdio: 'inherit' });

  console.log(`Diff verified for ${selection.bead.id} (apps/${selection.app}/): ${check.files.join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(`verify-bead-pr-diff failed: ${error.message}`);
  process.exit(1);
}
