---
name: unused-code-triage
description: Weekly read-only triage of Knip unused-code candidates into bounded single-app Beads items on refs/heads/memory/beads.
on:
  schedule:
    - cron: 'weekly on tuesday'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Preview Beads updates without committing or pushing to memory/beads'
        type: boolean
        default: false
concurrency:
  job-discriminator: "${{ github.run_id }}"
permissions:
  contents: read
  copilot-requests: write
engine:
  id: copilot
  args:
    - "--available-tools"
    - "mcpscripts,safeoutputs"
    - "--deny-tool"
    - "shell"
    - "--deny-tool"
    - "write"
    - "--deny-tool"
    - "url"
strict: true
checkout: false
timeout-minutes: 15
max-turns: 25
network: defaults
jobs:
  agent:
    timeout-minutes: 25
  detection:
    timeout-minutes: 10
tools:
  edit: false
  bash: false
  cli-proxy: false
  github: false
steps:
  - uses: actions/checkout@v7
    with:
      ref: ${{ github.sha }}
      persist-credentials: false
  - uses: pnpm/action-setup@v6
  - uses: actions/setup-node@v7
    with:
      node-version: 22
      cache: pnpm
  - name: Install workspace dependencies for Knip
    run: pnpm install --frozen-lockfile --ignore-scripts
  - name: Generate Knip unused-code report
    run: node scripts/report-unused-code.mjs --baseline ""
  - name: Export bounded Beads snapshot (read-only pull)
    env:
      GITHUB_TOKEN: ${{ github.token }}
    run: |
      AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 | tr -d '\n')"
      GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL%/}/.extraheader" \
      GIT_CONFIG_VALUE_0="${AUTH_HEADER}" \
      node scripts/beads.mjs sync --remote origin
      node scripts/beads.mjs export --format snapshot --max-items 100 > quality-artifacts/unused-code/beads-snapshot.json
  - name: Strip git metadata and lock workspace read-only before agent starts
    run: |
      rm -rf .git
      chmod -R a-w apps quality-artifacts/unused-code
mcp-scripts:
  read_triage_artifact:
    description: "Read a slice of one of the generated triage artifacts (summary.md, knip.json, or beads-snapshot.json)"
    inputs:
      name:
        type: string
        description: "Artifact filename: summary.md, knip.json, or beads-snapshot.json"
        required: true
      start_line:
        type: number
        description: "1-based start line (default 1)"
        required: false
      max_lines:
        type: number
        description: "Maximum lines to return (default 200, max 400)"
        required: false
      char_offset:
        type: number
        description: "0-based character offset within the selected line slice for paging long single-line JSON (default 0)"
        required: false
    script: |
      const fs = require('node:fs');
      const path = require('node:path');
      const MAX_BYTES = 32768;
      const allowed = new Set(['summary.md', 'knip.json', 'beads-snapshot.json']);
      if (!allowed.has(name)) {
        throw new Error('Allowed artifacts: summary.md, knip.json, beads-snapshot.json');
      }
      const root = process.env.GITHUB_WORKSPACE || process.cwd();
      const qaDir = path.join(root, 'quality-artifacts');
      const artifactDir = path.join(qaDir, 'unused-code');
      for (const dir of [qaDir, artifactDir]) {
        if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) {
          throw new Error('Artifact directory invalid');
        }
      }
      const artifactDirReal = fs.realpathSync(artifactDir);
      const fullPath = path.join(artifactDir, name);
      if (!fs.existsSync(fullPath) || fs.lstatSync(fullPath).isSymbolicLink()) {
        throw new Error(`Artifact ${name} not found`);
      }
      const targetReal = fs.realpathSync(fullPath);
      const rel = path.relative(artifactDirReal, targetReal);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(targetReal).isFile()) {
        throw new Error(`Artifact ${name} escapes artifact directory`);
      }
      const lines = fs.readFileSync(targetReal, 'utf8').split('\n');
      const start = Math.max(1, Number.isInteger(start_line) ? start_line : 1);
      const count = Math.min(400, Math.max(1, Number.isInteger(max_lines) ? max_lines : 200));
      const slice = lines.slice(start - 1, start - 1 + count);
      const rawContent = slice.join('\n');
      const offset = Math.max(0, Number.isInteger(char_offset) ? char_offset : 0);
      const remaining = rawContent.slice(offset);
      let content = '';
      let usedBytes = 0;
      let consumedChars = 0;
      for (const ch of remaining) {
        const chBytes = Buffer.byteLength(ch, 'utf8');
        if (usedBytes + chBytes > MAX_BYTES) break;
        content += ch;
        usedBytes += chBytes;
        consumedChars += ch.length;
      }
      const truncated = offset + consumedChars < rawContent.length;
      const next_char_offset = truncated ? offset + consumedChars : null;
      return { total_lines: lines.length, start_line: start, end_line: start + slice.length - 1, char_offset: offset, next_char_offset, bytes: usedBytes, truncated, content };
  list_app_files:
    description: "List source files inside a first-party non-upstream app directory apps/<app>/"
    inputs:
      app:
        type: string
        description: "App id under apps/<app>/"
        required: true
    script: |
      const fs = require('node:fs');
      const path = require('node:path');
      const MAX_FILES = 500;
      if (!/^[a-z][a-z0-9-]*$/.test(app || '')) throw new Error('Invalid app id');
      const root = process.env.GITHUB_WORKSPACE || process.cwd();
      const appsDir = path.join(root, 'apps');
      const appDir = path.join(appsDir, app);
      if (!fs.existsSync(appsDir) || fs.lstatSync(appsDir).isSymbolicLink() || !fs.lstatSync(appsDir).isDirectory()) throw new Error('apps directory invalid');
      if (!fs.existsSync(appDir) || fs.lstatSync(appDir).isSymbolicLink() || !fs.lstatSync(appDir).isDirectory()) throw new Error('App directory not found');
      if (fs.existsSync(path.join(appDir, 'upstream.json'))) throw new Error('Upstream-tracked app is out of scope');
      const appReal = fs.realpathSync(appDir);
      const results = [];
      let truncated = false;
      const walk = (dir) => {
        if (results.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (results.length >= MAX_FILES) {
            truncated = true;
            return;
          }
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            results.push(`apps/${app}/${path.relative(appReal, full).replaceAll(path.sep, '/')}`);
          }
        }
      };
      walk(appReal);
      return { app, count: results.length, truncated, files: results };
  read_app_file:
    description: "Read a slice of a regular file strictly contained inside apps/<app>/"
    inputs:
      app:
        type: string
        description: "App id under apps/<app>/"
        required: true
      file:
        type: string
        description: "Repo-relative path starting with apps/<app>/"
        required: true
      start_line:
        type: number
        description: "1-based start line (default 1)"
        required: false
      max_lines:
        type: number
        description: "Maximum lines to return (default 200, max 400)"
        required: false
      char_offset:
        type: number
        description: "0-based character offset within the selected line slice (default 0)"
        required: false
    script: |
      const fs = require('node:fs');
      const path = require('node:path');
      const MAX_BYTES = 32768;
      if (!/^[a-z][a-z0-9-]*$/.test(app || '')) throw new Error('Invalid app id');
      if (typeof file !== 'string' || !file.startsWith(`apps/${app}/`) || file.includes('..') || file.includes('\\')) {
        throw new Error(`File must be inside apps/${app}/`);
      }
      const root = process.env.GITHUB_WORKSPACE || process.cwd();
      const appsDir = path.join(root, 'apps');
      const appDir = path.join(appsDir, app);
      if (!fs.existsSync(appsDir) || fs.lstatSync(appsDir).isSymbolicLink() || !fs.lstatSync(appsDir).isDirectory()) throw new Error('apps directory invalid');
      if (!fs.existsSync(appDir) || fs.lstatSync(appDir).isSymbolicLink() || !fs.lstatSync(appDir).isDirectory()) throw new Error('App directory not found');
      if (fs.existsSync(path.join(appDir, 'upstream.json'))) throw new Error('Upstream-tracked app is out of scope');
      const appReal = fs.realpathSync(appDir);
      const target = path.resolve(root, file);
      if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw new Error('File not found');
      const targetReal = fs.realpathSync(target);
      const rel = path.relative(appReal, targetReal);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(targetReal).isFile()) {
        throw new Error('Path escapes app directory');
      }
      const lines = fs.readFileSync(targetReal, 'utf8').split('\n');
      const start = Math.max(1, Number.isInteger(start_line) ? start_line : 1);
      const count = Math.min(400, Math.max(1, Number.isInteger(max_lines) ? max_lines : 200));
      const slice = lines.slice(start - 1, start - 1 + count);
      const rawContent = slice.join('\n');
      const offset = Math.max(0, Number.isInteger(char_offset) ? char_offset : 0);
      const remaining = rawContent.slice(offset);
      let content = '';
      let usedBytes = 0;
      let consumedChars = 0;
      for (const ch of remaining) {
        const chBytes = Buffer.byteLength(ch, 'utf8');
        if (usedBytes + chBytes > MAX_BYTES) break;
        content += ch;
        usedBytes += chBytes;
        consumedChars += ch.length;
      }
      const truncated = offset + consumedChars < rawContent.length;
      const next_char_offset = truncated ? offset + consumedChars : null;
      return { file, total_lines: lines.length, start_line: start, end_line: start + slice.length - 1, char_offset: offset, next_char_offset, bytes: usedBytes, truncated, content };
  search_app_files:
    description: "Plain substring search across regular files strictly inside apps/<app>/ (no shell or regex execution)"
    inputs:
      app:
        type: string
        description: "App id under apps/<app>/"
        required: true
      query:
        type: string
        description: "Literal substring to search for (2-120 chars)"
        required: true
    script: |
      const fs = require('node:fs');
      const path = require('node:path');
      if (!/^[a-z][a-z0-9-]*$/.test(app || '')) throw new Error('Invalid app id');
      if (typeof query !== 'string' || query.length < 2 || query.length > 120) {
        throw new Error('query must be 2-120 characters');
      }
      const root = process.env.GITHUB_WORKSPACE || process.cwd();
      const appsDir = path.join(root, 'apps');
      const appDir = path.join(appsDir, app);
      if (!fs.existsSync(appsDir) || fs.lstatSync(appsDir).isSymbolicLink() || !fs.lstatSync(appsDir).isDirectory()) throw new Error('apps directory invalid');
      if (!fs.existsSync(appDir) || fs.lstatSync(appDir).isSymbolicLink() || !fs.lstatSync(appDir).isDirectory()) throw new Error('App directory not found');
      if (fs.existsSync(path.join(appDir, 'upstream.json'))) throw new Error('Upstream-tracked app is out of scope');
      const appReal = fs.realpathSync(appDir);
      const matches = [];
      const skippedLargeFiles = [];
      let skippedLargeFileCount = 0;
      let truncatedByMatchLimit = false;
      const walk = (dir) => {
        if (truncatedByMatchLimit) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (truncatedByMatchLimit) return;
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            const relFile = `apps/${app}/${path.relative(appReal, full).replaceAll(path.sep, '/')}`;
            const stat = fs.statSync(full);
            if (stat.size > 512 * 1024) {
              skippedLargeFileCount += 1;
              if (skippedLargeFiles.length < 50) skippedLargeFiles.push(relFile);
              continue;
            }
            const text = fs.readFileSync(full, 'utf8');
            if (!text.includes(query)) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                if (matches.length >= 100) {
                  truncatedByMatchLimit = true;
                  return;
                }
                matches.push({ file: relFile, line: i + 1, text: lines[i].slice(0, 200) });
              }
            }
          }
        }
      };
      walk(appReal);
      return {
        app,
        query,
        count: matches.length,
        complete: !truncatedByMatchLimit && skippedLargeFileCount === 0,
        truncated_by_match_limit: truncatedByMatchLimit,
        skipped_large_file_count: skippedLargeFileCount,
        skipped_large_files: skippedLargeFiles,
        matches,
      };
safe-outputs:
  timeout-minutes: 10
  report-failure-as-issue: false
  report-failed-jobs: false
  threat-detection:
    continue-on-error: false
    report-as-issue: false
  noop:
    report-as-issue: false
  report-missing-tool:
    create-issue: false
  report-incomplete:
    create-issue: false
  report-missing-data:
    create-issue: false
  jobs:
    upsert-unused-code-bead:
      description: "Record or refresh a verified single-app unused-code finding on the CI-silent refs/heads/memory/beads branch"
      runs-on: ubuntu-latest
      if: "github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && needs.detection.outputs.detection_success == 'true' && needs.detection.outputs.detection_conclusion == 'success'"
      permissions:
        contents: write
      outputs:
        status: ${{ steps.apply.outputs.status }}
      inputs:
        app:
          description: "Registered first-party app id under apps/<app>/ (never upstream-tracked apps)"
          type: string
          required: true
        dedupe_key:
          description: "Deterministic key: knip:apps/<app>/<file>:<symbol>"
          type: string
          required: true
        title:
          description: "Concise maintenance title (<= 140 chars)"
          type: string
          required: true
        summary:
          description: "Verified explanation of why the symbol or dependency is unused and safe to clean up"
          type: string
          required: true
        evidence:
          description: "Comma-separated repo-relative paths inspected under apps/<app>/ (optionally plus quality-artifacts/unused-code/knip.json)"
          type: string
          required: true
        priority:
          description: "Priority 1 (high), 2 (normal), or 3 (low)"
          type: number
          required: false
        expected_revision:
          description: "Existing bead revision from beads-snapshot.json when updating an existing bead; omit when creating"
          type: number
          required: false
        note:
          description: "Short verification note appended to the bead journal"
          type: string
          required: false
      steps:
        - uses: actions/checkout@v7
          timeout-minutes: 5
          with:
            ref: ${{ github.sha }}
            fetch-depth: 0
            persist-credentials: false
        - uses: pnpm/action-setup@v6
          timeout-minutes: 3
        - uses: actions/setup-node@v7
          timeout-minutes: 3
          with:
            node-version: 22
            cache: pnpm
        - name: Install dependencies for deterministic Beads safe-outputs applier
          timeout-minutes: 5
          run: pnpm install --frozen-lockfile --ignore-scripts
        - name: Apply verified single-app Beads operations
          id: apply
          timeout-minutes: 5
          env:
            DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
            DRY_RUN: ${{ inputs.dry_run }}
            GITHUB_TOKEN: ${{ github.token }}
            GH_AW_DETECTION_SUCCESS: ${{ needs.detection.outputs.detection_success }}
            GIT_AUTHOR_NAME: github-actions[bot]
            GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
            GIT_COMMITTER_NAME: github-actions[bot]
            GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
          run: |
            if [ "${GITHUB_REF}" != "refs/heads/${DEFAULT_BRANCH}" ]; then
              echo "Refusing to apply Beads safe outputs outside exact default branch refs/heads/${DEFAULT_BRANCH} (got ${GITHUB_REF})" >&2
              exit 1
            fi
            ARGS=(--actor gh-aw/unused-code-triage --max-creates 5 --max-updates 10 --require-clean-detection)
            if [ "${DRY_RUN}" = "true" ]; then
              ARGS+=(--dry-run)
            fi
            AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 | tr -d '\n')"
            GIT_CONFIG_COUNT=1 \
            GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL%/}/.extraheader" \
            GIT_CONFIG_VALUE_0="${AUTH_HEADER}" \
            node scripts/apply-beads-safe-outputs.mjs "${ARGS[@]}"
---

# Weekly Unused-Code Triage (`memory/beads`)

You are a **read-only** repository maintenance analyst for `neurodesk/webapps`.

## Inputs already generated in the workspace

Use the read-only MCP tools (`read_triage_artifact`, `list_app_files`, `read_app_file`, `search_app_files`) to inspect:

1. `summary.md` — concise summary of current Knip unused-code candidates.
2. `knip.json` — full structured Knip JSON report.
3. `beads-snapshot.json` — bounded snapshot of open Beads items (`items`) and previously closed dedupe keys (`closedDedupeKeys`) on `refs/heads/memory/beads`.

## Your task

Inspect the report-only Knip candidates (unused exports, types, dependencies, devDependencies) and verify up to **5 highest-value, clearly actionable single-app findings** under `apps/<app>/`:

1. **Scope strictly to first-party single apps (`apps/<app>/`):**
   - **Skip** any app that has `apps/<app>/upstream.json` (e.g., `qsmbly`, `seedseg`, `dicompare`).
   - **Skip** shared packages (`packages/*`), native executables (`exes/*`), root `scripts/*`, and `test-utils/*`.
2. **Verify every candidate in source code before emitting a bead:**
   - Read the referenced file with `read_app_file` and search the app with `search_app_files` to confirm the symbol/dependency is genuinely unused.
   - If `search_app_files` returns `complete: false`, do **not** treat missing matches as proof of unused code:
     - If `truncated_by_match_limit` is `true`, **skip** the candidate (later references may have been omitted after the 100-match cap).
     - If `skipped_large_file_count > 0`, **skip** the candidate unless `skipped_large_file_count === skipped_large_files.length` and you have inspected every listed skipped file with `read_app_file` and confirmed no reference exists.
   - **Skip** anything loaded dynamically at runtime (`_runtime/`, worker URLs, HTML `<script>`/`<link>`, `examples.json`, Vite config, or public API exports consumed by tests or other packages).
3. **Deduplicate cleanly against `beads-snapshot.json`:**
   - Use deterministic `dedupe_key` format: `knip:apps/<app>/<relative-file>:<symbol>`.
   - **Skip** any `dedupe_key` listed in `closedDedupeKeys` (a maintainer already closed that finding).
   - If a bead with the same `dedupe_key` is already open in `beads-snapshot.json` and nothing material changed, do **not** emit a redundant update.
   - If you do update an existing open bead, pass its exact `expected_revision` from `beads-snapshot.json`.
4. **Emit outputs:**
   - Call `upsert_unused_code_bead` for each verified finding (at most 5 new findings per run; priority `2` or `3`, or `1` only for obvious dead runtime dependencies).
   - If no new actionable single-app findings exist, call `noop` and explain why.
   - Never modify repository files, never open PRs or issues, and never include secrets or external untrusted content in bead fields.
