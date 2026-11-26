#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_BEADS_REF } from './lib/beads.mjs';
import {
  DEFAULT_TRIAGE_ACTOR,
  UNUSED_CODE_ITEM_TYPE,
  applyUnusedCodeSafeOutputs,
  formatSafeOutputsSummary,
} from './lib/beads-safe-outputs.mjs';

function parseStrictPositiveInt(value, flag) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new Error(`${flag} must be a non-negative integer (got "${value}")`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative safe integer (got "${value}")`);
  }
  return parsed;
}

function sanitizeDiagnosticText(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || /[\p{Cc}\p{Cf}]/u.test(ch)) {
      out += ' ';
    } else if (ch === '%') {
      out += '%25';
    } else {
      out += ch;
    }
  }
  return out.replace(/ +/g, ' ').trim();
}

function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, val]) => `${key}=${String(val).replace(/[\r\n]/g, ' ')}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      ref: { type: 'string', default: DEFAULT_BEADS_REF },
      remote: { type: 'string', default: 'origin' },
      actor: { type: 'string', default: DEFAULT_TRIAGE_ACTOR },
      'max-creates': { type: 'string', default: '5' },
      'max-updates': { type: 'string', default: '10' },
      'item-type': { type: 'string', default: UNUSED_CODE_ITEM_TYPE },
      'dry-run': { type: 'boolean', default: false },
      'no-sync': { type: 'boolean', default: false },
      'require-clean-detection': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const inputPath = values.input || process.env.GH_AW_AGENT_OUTPUT;
  if (!inputPath) {
    throw new Error('Missing agent output path: pass --input <path> or set GH_AW_AGENT_OUTPUT');
  }

  const staged = process.env.GH_AW_SAFE_OUTPUTS_STAGED === 'true';
  const rawOutput = JSON.parse(readFileSync(inputPath, 'utf8'));
  const result = await applyUnusedCodeSafeOutputs(rawOutput, {
    cwd: process.cwd(),
    ref: values.ref,
    remote: values.remote,
    actor: values.actor,
    maxCreates: parseStrictPositiveInt(values['max-creates'], '--max-creates'),
    maxUpdates: parseStrictPositiveInt(values['max-updates'], '--max-updates'),
    staged,
    dryRun: values['dry-run'],
    skipSync: values['no-sync'],
    requireCleanDetection: values['require-clean-detection'],
    detectionConclusion: process.env.GH_AW_DETECTION_CONCLUSION ?? null,
    detectionSuccess: process.env.GH_AW_DETECTION_SUCCESS ?? null,
    itemType: values['item-type'],
  });

  for (const item of result.skipped) {
    const label = item.dedupeKey ? `${sanitizeDiagnosticText(item.dedupeKey)}: ` : '';
    process.stderr.write(`::warning::Skipped invalid bead item #${item.index + 1}: ${label}${sanitizeDiagnosticText(item.reason)}\n`);
  }

  const summary = formatSafeOutputsSummary(result, {
    workflow: process.env.GITHUB_WORKFLOW || 'unused-code-triage',
    ref: values.ref,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
  writeGithubOutput(process.env.GITHUB_OUTPUT, {
    status: result.status,
    created_count: result.createdIds.length,
    updated_count: result.updatedIds.length,
    untouched_count: result.untouchedIds.length,
    skipped_count: result.skipped.length,
    pushed: result.pushed ? 'true' : 'false',
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }
}

main().catch((error) => {
  writeGithubOutput(process.env.GITHUB_OUTPUT, { status: 'failure' });
  process.stderr.write(`Error: ${sanitizeDiagnosticText(error.message)}\n`);
  process.exitCode = 1;
});
