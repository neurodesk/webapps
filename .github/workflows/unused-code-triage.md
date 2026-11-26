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
engine: copilot
strict: true
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
  bash:
    - "rg *"
    - "grep *"
    - "git grep *"
    - "ls *"
    - "cat *"
    - "head *"
    - "tail *"
    - "wc *"
    - "git status*"
    - "git log *"
steps:
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
safe-outputs:
  timeout-minutes: 10
  noop: {}
  jobs:
    upsert-unused-code-bead:
      description: "Record or refresh a verified single-app unused-code finding on the CI-silent refs/heads/memory/beads branch"
      runs-on: ubuntu-latest
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
          with:
            ref: ${{ github.event.repository.default_branch }}
            fetch-depth: 0
            persist-credentials: false
        - uses: pnpm/action-setup@v6
        - uses: actions/setup-node@v7
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
            DRY_RUN: ${{ inputs.dry_run }}
            GITHUB_TOKEN: ${{ github.token }}
            GIT_AUTHOR_NAME: github-actions[bot]
            GIT_AUTHOR_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
            GIT_COMMITTER_NAME: github-actions[bot]
            GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com
          run: |
            ARGS=(--actor gh-aw/unused-code-triage --max-creates 5 --max-updates 10)
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

1. `quality-artifacts/unused-code/summary.md` — concise summary of current Knip unused-code candidates.
2. `quality-artifacts/unused-code/knip.json` — full structured Knip JSON report.
3. `quality-artifacts/unused-code/beads-snapshot.json` — bounded snapshot of open Beads items on `refs/heads/memory/beads` (including each bead's `id`, `dedupeKey`, `revision`, and `status`).

## Your task

Inspect the report-only Knip candidates (unused exports, types, dependencies, devDependencies) and verify up to **5 highest-value, clearly actionable single-app findings** under `apps/<app>/`:

1. **Scope strictly to first-party single apps (`apps/<app>/`):**
   - **Skip** any app that has `apps/<app>/upstream.json` (e.g., `qsmbly`, `seedseg`, `dicompare`).
   - **Skip** shared packages (`packages/*`), native executables (`exes/*`), root `scripts/*`, and `test-utils/*`.
2. **Verify every candidate in source code before emitting a bead:**
   - Read the referenced file and search the app (`rg`) to confirm the symbol/dependency is genuinely unused.
   - **Skip** anything loaded dynamically at runtime (`_runtime/`, worker URLs, HTML `<script>`/`<link>`, `examples.json`, Vite config, or public API exports consumed by tests or other packages).
3. **Deduplicate cleanly against `beads-snapshot.json`:**
   - Use deterministic `dedupe_key` format: `knip:apps/<app>/<relative-file>:<symbol>`.
   - If a bead with the same `dedupe_key` is already open in `beads-snapshot.json` and nothing material changed, do **not** emit a redundant update.
   - If you do update an existing open bead, pass its exact `expected_revision` from `beads-snapshot.json`.
4. **Emit outputs:**
   - Call `upsert_unused_code_bead` for each verified finding (at most 5 new findings per run; priority `2` or `3`, or `1` only for obvious dead runtime dependencies).
   - If no new actionable single-app findings exist, call `noop` and explain why.
   - Never modify repository files, never open PRs or issues, and never include secrets or external untrusted content in bead fields.
