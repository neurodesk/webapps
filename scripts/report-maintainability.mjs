#!/usr/bin/env node
import { ESLint } from 'eslint';
import tsParser from '@neurodesk/code-quality';
import tsPlugin from '@neurodesk/code-quality/plugin';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sourceInventory } from './quality/lint-inventory.mjs';

export const root = realpathSync(fileURLToPath(new URL('../', import.meta.url))) + sep;

const TEST_OR_FIXTURE = /(?:^|\/)(?:test|tests|test-utils|e2e|validation|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isProductionSource(file) {
  return !TEST_OR_FIXTURE.test(file) && !file.startsWith('templates/');
}

export function upstreamApps(cwd) {
  const appsDir = join(cwd, 'apps');
  const upstream = new Set();
  if (!existsSync(appsDir)) return upstream;
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(appsDir, entry.name, 'upstream.json'))) {
      upstream.add(`apps/${entry.name}/`);
    }
  }
  return upstream;
}

export function workspaceReach(cwd) {
  const manifests = new Map();
  const byName = new Map();
  for (const parent of ['apps', 'packages']) {
    const base = join(cwd, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgFile = join(base, entry.name, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      const dir = `${parent}/${entry.name}`;
      manifests.set(dir, pkg);
      if (pkg.name) byName.set(pkg.name, dir);
    }
  }
  const reverse = new Map([...manifests.keys()].map((dir) => [dir, new Set()]));
  for (const [dir, pkg] of manifests) {
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const depName of Object.keys(deps)) {
      const target = byName.get(depName);
      if (target && target !== dir) reverse.get(target).add(dir);
    }
  }
  const reach = new Map();
  for (const dir of manifests.keys()) {
    const visited = new Set();
    const stack = [...reverse.get(dir)];
    while (stack.length) {
      const next = stack.pop();
      if (visited.has(next)) continue;
      visited.add(next);
      for (const upstream of reverse.get(next) ?? []) {
        if (!visited.has(upstream)) stack.push(upstream);
      }
    }
    reach.set(dir, visited.size);
  }
  return reach;
}

export function reachForFile(file, reach) {
  const parts = file.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 2) {
    return reach.get(`${parts[0]}/${parts[1]}`) ?? 0;
  }
  return 0;
}

export function commitCounts(cwd, days = 90) {
  const counts = new Map();
  try {
    const out = execFileSync('git', ['log', `--since=${days} days ago`, '--name-only', '--pretty=format:'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) {
      const file = line.trim();
      if (!file) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  } catch {
    return counts;
  }
  return counts;
}

function complexityEslint(cwd, threshold) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
        linterOptions: { noInlineConfig: true },
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          complexity: ['warn', { max: threshold }],
        },
      },
      {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: { parser: tsParser },
      },
      {
        files: ['**/*.{cjs,cts}'],
        languageOptions: { sourceType: 'commonjs' },
      },
    ],
  });
}

function ruleAuditEslint(cwd) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
        linterOptions: { noInlineConfig: true },
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          eqeqeq: ['warn', 'smart'],
          'no-shadow': 'warn',
        },
      },
      {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: { parser: tsParser },
        plugins: { '@typescript-eslint': tsPlugin },
        rules: {
          'no-shadow': 'off',
          '@typescript-eslint/no-shadow': 'warn',
        },
      },
      {
        files: ['**/*.{cjs,cts}'],
        languageOptions: { sourceType: 'commonjs' },
      },
    ],
  });
}

export async function analyzeComplexity(cwd, files, { threshold = 15, days = 90 } = {}) {
  const realCwd = realpathSync(cwd);
  const normalizedRoot = realCwd + sep;
  const upstream = upstreamApps(realCwd);
  const reach = workspaceReach(realCwd);
  const commits = commitCounts(realCwd, days);
  const eslint = complexityEslint(realCwd, threshold);
  const results = await eslint.lintFiles(files);
  const firstParty = [];
  const upstreamTracked = [];
  const parseErrors = [];

  for (const result of results) {
    const file = relative(normalizedRoot, realpathSync(result.filePath)).replaceAll('\\', '/');
    const fatal = result.messages.find((message) => message.fatal);
    if (fatal) {
      parseErrors.push({ file, line: fatal.line ?? 1, column: fatal.column ?? 1, message: fatal.message });
      continue;
    }
    const functions = [];
    for (const message of result.messages) {
      if (message.ruleId !== 'complexity') continue;
      const match = message.message.match(/complexity of (\d+)/);
      if (!match) continue;
      functions.push({ line: message.line, column: message.column, complexity: Number(match[1]), message: message.message });
    }
    if (functions.length === 0) continue;
    functions.sort((a, b) => b.complexity - a.complexity || a.line - b.line);
    const entry = {
      file,
      maxComplexity: functions[0].complexity,
      overThreshold: functions.length,
      commits: commits.get(file) ?? 0,
      manifestReach: reachForFile(file, reach),
      functions,
    };
    const isUpstream = [...upstream].some((prefix) => file.startsWith(prefix));
    if (isUpstream) upstreamTracked.push(entry);
    else firstParty.push(entry);
  }

  const bySeverity = (a, b) => b.maxComplexity - a.maxComplexity || b.commits - a.commits || a.file.localeCompare(b.file);
  firstParty.sort(bySeverity);
  upstreamTracked.sort(bySeverity);
  return {
    threshold,
    days,
    filesChecked: files.length,
    filesAnalyzed: files.length - parseErrors.length,
    parseErrors,
    firstParty,
    upstreamTracked,
  };
}

export async function auditOptionalRules(cwd, files) {
  const realCwd = realpathSync(cwd);
  const normalizedRoot = realCwd + sep;
  const eslint = ruleAuditEslint(realCwd);
  const results = await eslint.lintFiles(files);
  const counts = { eqeqeq: 0, 'no-shadow': 0 };
  const samples = { eqeqeq: [], 'no-shadow': [] };
  const parseErrors = [];
  for (const result of results) {
    const file = relative(normalizedRoot, realpathSync(result.filePath)).replaceAll('\\', '/');
    const fatal = result.messages.find((message) => message.fatal);
    if (fatal) {
      parseErrors.push({ file, line: fatal.line ?? 1, column: fatal.column ?? 1, message: fatal.message });
      continue;
    }
    for (const message of result.messages) {
      const bucket = message.ruleId === 'eqeqeq'
        ? 'eqeqeq'
        : message.ruleId === 'no-shadow' || message.ruleId === '@typescript-eslint/no-shadow'
          ? 'no-shadow'
          : null;
      if (!bucket) continue;
      counts[bucket]++;
      if (samples[bucket].length < 15) {
        samples[bucket].push(`${file}:${message.line}:${message.column} ${message.message}`);
      }
    }
  }
  return { filesAnalyzed: files.length - parseErrors.length, parseErrors, counts, samples };
}

export function summarizeMaintainability(report, ruleAudit = null) {
  const table = (entries, limit = 30) => {
    if (entries.length === 0) return '_No functions above threshold._';
    const header = `| File | Max complexity | Functions > ${report.threshold} | Commits (${report.days}d) | Manifest reach |\n| --- | ---: | ---: | ---: | ---: |`;
    const rows = entries.slice(0, limit).map((entry) =>
      `| ${entry.file} | ${entry.maxComplexity} | ${entry.overThreshold} | ${entry.commits} | ${entry.manifestReach} |`,
    );
    return `${header}\n${rows.join('\n')}`;
  };

  const sections = [
    '## Maintainability triage report',
    '',
    `Analyzed **${report.filesAnalyzed}** of **${report.filesChecked}** owned production JS/TS files with ESLint's built-in \`complexity\` rule (threshold: **${report.threshold}**, report-only).`,
    'Columns are kept separate rather than multiplied into a single score. `Manifest reach` counts transitive workspace `package.json` dependency edges only (excluding runtime-staged assets and build scripts).',
    '',
    `### First-party production (${report.firstParty.length} files with functions > ${report.threshold})`,
    '',
    table(report.firstParty),
    '',
    `### Upstream-tracked apps (${report.upstreamTracked.length} files with functions > ${report.threshold})`,
    '',
    table(report.upstreamTracked, 15),
  ];

  if (report.parseErrors.length) {
    sections.push(
      '',
      `### Parse errors (${report.parseErrors.length} files could not be analyzed)`,
      '',
      ...report.parseErrors.map((err) => `- \`${err.file}:${err.line}:${err.column}\` ${err.message}`),
    );
  }

  if (ruleAudit) {
    sections.push(
      '',
      '### Optional ESLint rule audit (read-only trial)',
      '',
      `- Files analyzed: **${ruleAudit.filesAnalyzed}** (${ruleAudit.parseErrors.length} parse errors)`,
      `- \`eqeqeq\` (\`smart\`, allows \`== null\`): **${ruleAudit.counts.eqeqeq}** findings`,
      `- \`no-shadow\` (TS-aware on TypeScript): **${ruleAudit.counts['no-shadow']}** findings`,
    );
  }

  return `${sections.join('\n')}\n`;
}

export async function runMaintainabilityReport({
  cwd = root,
  threshold = 15,
  days = 90,
  output = 'quality-artifacts/maintainability',
  auditRules = false,
  files = null,
} = {}) {
  const targetFiles = files ?? sourceInventory(cwd).filter(isProductionSource);
  const report = await analyzeComplexity(cwd, targetFiles, { threshold, days });
  const ruleAudit = auditRules ? await auditOptionalRules(cwd, targetFiles) : null;
  const markdown = summarizeMaintainability(report, ruleAudit);
  const outDir = resolve(cwd, output);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'report.json'), `${JSON.stringify({ ...report, ...(ruleAudit ? { ruleAudit } : {}) }, null, 2)}\n`);
  writeFileSync(resolve(outDir, 'summary.md'), markdown);
  return { report, ruleAudit, markdown, outDir };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({
    options: {
      threshold: { type: 'string', default: '15' },
      days: { type: 'string', default: '90' },
      output: { type: 'string', default: 'quality-artifacts/maintainability' },
      'audit-rules': { type: 'boolean', default: false },
    },
  });
  const threshold = Number(values.threshold);
  const days = Number(values.days);
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error(`Invalid --threshold: ${values.threshold}`);
  if (!Number.isInteger(days) || days < 1) throw new Error(`Invalid --days: ${values.days}`);
  const { markdown } = await runMaintainabilityReport({
    cwd: root,
    threshold,
    days,
    output: values.output,
    auditRules: values['audit-rules'],
  });
  console.log(markdown);
}
