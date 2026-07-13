#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const MAX_FAILURES = 20;
const MAX_TAIL_LINES = 25;

function cleanLine(line) {
  return String(line)
    .replace(ANSI_PATTERN, '')
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '')
    .trimEnd();
}

function parseFailureLine(line) {
  const assertion = line.match(/AssertionError(?:\s+\[[^\]]+\])?:\s*(.+)$/);
  if (assertion) return assertion[1].trim();

  const error = line.match(/^(?:Error|TypeError|ReferenceError|RangeError|SyntaxError):\s*(.+)$/);
  if (error) return line.trim();

  if (/^(?:not ok\b|FAIL(?:ED)?\b|fail(?:ed)?\b|x\s+)/i.test(line)) return line.trim();

  return null;
}

function inferTestName(message) {
  const named = message.match(/^([A-Za-z0-9_.:-]+):\s+/);
  if (!named) return '';
  if (/^(?:Error|TypeError|ReferenceError|RangeError|SyntaxError)$/.test(named[1])) return '';
  return named[1];
}

function parseTestFailures(logText, options = {}) {
  const lines = logText.split(/\r?\n/).map(cleanLine);
  let currentScript = '';
  const failures = [];
  const seen = new Set();

  for (const line of lines) {
    const scriptMatch = line.match(/^>\s+([A-Za-z0-9:_-]+)\s*$/);
    if (scriptMatch) {
      currentScript = scriptMatch[1];
      continue;
    }

    const message = parseFailureLine(line);
    if (!message) continue;

    const testName = inferTestName(message);
    const key = `${currentScript}\0${testName}\0${message}`;
    if (seen.has(key)) continue;

    seen.add(key);
    failures.push({ script: currentScript, testName, message });
    if (failures.length >= MAX_FAILURES) break;
  }

  const tail = lines
    .filter(line => line.trim())
    .slice(-MAX_TAIL_LINES);

  return {
    exitCode: options.exitCode == null ? '' : String(options.exitCode),
    failures,
    tail
  };
}

function markdownListItem(failure) {
  const parts = [];
  if (failure.script) parts.push(`script \`${failure.script}\``);
  if (failure.testName) parts.push(`test \`${failure.testName}\``);
  const label = parts.length ? `${parts.join(', ')}: ` : '';
  return `- ${label}${failure.message}`;
}

function formatFailureSummary(summary) {
  const lines = ['## Test Failure Summary', ''];
  if (summary.exitCode) lines.push(`Exit code: \`${summary.exitCode}\``, '');

  if (summary.failures.length) {
    lines.push('Detected failures:');
    for (const failure of summary.failures) lines.push(markdownListItem(failure));
  } else {
    lines.push('No specific assertion or named failing test was detected in the captured log.');
  }

  lines.push('', 'Recent log tail:', '```text', ...summary.tail, '```');
  return `${lines.join('\n')}\n`;
}

function writeGitHubOutputs(summary) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const failedTests = summary.failures
    .map(failure => [failure.script, failure.testName || failure.message].filter(Boolean).join(': '))
    .join('\n');

  fs.appendFileSync(
    outputPath,
    `failure_count=${summary.failures.length}\nfailed_tests<<__FAILED_TESTS__\n${failedTests}\n__FAILED_TESTS__\n`
  );
}

function main(argv = process.argv.slice(2)) {
  const logPath = argv[0];
  if (!logPath) {
    console.error('Usage: node scripts/summarize_test_failures.cjs <test-log-path>');
    process.exitCode = 2;
    return;
  }

  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const summary = parseTestFailures(logText, { exitCode: process.env.TEST_EXIT_CODE });
  writeGitHubOutputs(summary);
  process.stdout.write(formatFailureSummary(summary));
}

if (require.main === module) main();

module.exports = {
  formatFailureSummary,
  parseTestFailures
};
