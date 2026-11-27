# Beads agent memory (`memory/beads`)

This repository separates permanent engineering rules from transient execution state using a four-layer memory model:

1. **Invariants & contracts:** Root [AGENTS.md](../../AGENTS.md), scoped `apps/<id>/AGENTS.md` / `packages/*/AGENTS.md` / `exes/AGENTS.md`, and executable tests under `test/`.
2. **Declarative catalog truth:** `registry/apps.yml`, `registry/app-information.yml`, `registry/standalone.json`, and `models/*.manifest.json`.
3. **Point-in-time evidence & ADRs:** `docs/adr/`, `docs/architecture/`, and `docs/quality/`.
4. **Dynamic execution state (Beads):** Dependency-aware work items, multi-app rollout queues, upstream/hardware blockers, `discovered-from` follow-ups, and cross-worktree claim leases stored on a CI-silent orphan Git branch (`refs/heads/memory/beads`).

> **Hard invariant:** No CI job, build, test, or `scripts/lib/app-plan.mjs` rule may ever read `memory/beads` or require Beads to exist. Ordinary fork checkouts and contributor PRs remain 100% independent of Beads.

## Storage layout

Beads live on the orphan branch `memory/beads` as plain-text, per-item JSON files:

```text
memory/beads
├── schema.json            # { "schemaVersion": 1, "format": "neurodesk-beads" }
└── beads/
    ├── bd-4a91f0c2.json   # One deterministic hash-named JSON file per bead
    └── bd-81c02e11.json
```

- **Zero working-tree pollution:** [scripts/beads.mjs](../../scripts/beads.mjs) and [scripts/lib/beads.mjs](../../scripts/lib/beads.mjs) read and commit directly through Git plumbing (`ls-tree`, `cat-file`, `hash-object`, `mktree`, `commit-tree`, and compare-and-swap `update-ref`). Every parallel T3/git worktree shares `refs/heads/memory/beads` automatically through `--git-common-dir` without dirtying any checkout or touching `main`.
- **Zero CI blast radius:** Every `on: push` workflow trigger in `.github/workflows/` filters to `branches: [main]` (or tags), so `memory/beads` pushes are CI-silent and never appear in `main` diffs or `app-plan.mjs`.
- **Conflict-free sync:** `sync` merges per-item by `(stateRevision, stateUpdatedAt)` with explicit lifecycle and per-claim lease reconciliation, unions `journal` entries and `evidence` links, and pushes with `--force-with-lease`.
- **Public-repo safety:** Treat `memory/beads` as world-readable if pushed to `origin`. Never store credentials, private review notes, raw non-collaborator issue text, or unpublished data in beads.

## Everyday CLI usage

```bash
# Initialize the orphan branch locally (idempotent)
node scripts/beads.mjs init

# Inspect actionable (open, unblocked, unleased) work
node scripts/beads.mjs ready
node scripts/beads.mjs ready --single-app --json

# Create or idempotently refresh a finding by dedupe key
node scripts/beads.mjs upsert \
  --dedupe-key "agents:topofit:niimath-stl" \
  --title "Drop direct niimath callMain path in topofit" \
  --kind maintenance --priority 2 \
  --scope app:topofit \
  --evidence "apps/topofit/AGENTS.md"

# Add a blocking dependency (cycle-checked)
node scripts/beads.mjs dep add <bead-id> --blocked-by <blocker-id>

# Claim with an auto-expiring lease (default 24h), log progress, and close
node scripts/beads.mjs claim <bead-id> --owner "t3/my-branch" --branch "t3/my-branch" --ttl-hours 24
node scripts/beads.mjs note <bead-id> --message "Verified fluent STL parity locally"
node scripts/beads.mjs close <bead-id> --reason "Merged fluent niimath STL cleanup" --pr 999

# Export a bounded snapshot (for gh-aw pre-steps) or JSONL (for external tooling)
node scripts/beads.mjs export --format snapshot
node scripts/beads.mjs export --format jsonl

# Sync with a remote orphan branch
node scripts/beads.mjs sync --remote origin --push
```

## Safe-outputs applier contract (Phase 2 `gh-aw` bridge)

Scheduled GitHub Agentic Workflows (`gh-aw`) must never hold direct write tokens in the LLM container. The weekly unused-code triage workflow ([unused-code-triage.md](../../.github/workflows/unused-code-triage.md), compiled to [unused-code-triage.lock.yml](../../.github/workflows/unused-code-triage.lock.yml)) enforces a strict three-stage pipeline:

1. **Read-only `agent` job (`contents: read`, authenticated via `secrets.COPILOT_GITHUB_TOKEN` fine-grained PAT with Copilot Requests permission only):** Checks out the default branch with `persist-credentials: false`, generates the Knip unused-code report (`node scripts/report-unused-code.mjs --baseline ""`), exports a bounded snapshot of `memory/beads` (`node scripts/beads.mjs sync --remote origin` + `export --format snapshot --max-items 100`), strips `.git` before `gh-aw` credential setup, and marks `apps/` and `quality-artifacts/unused-code/` read-only. The GitHub Copilot agent runs with `tools.bash: false`, `tools.edit: false`, and `tools.github: false`, inspecting files solely through read-only `mcp-scripts` (`read_triage_artifact`, `list_app_files`, `read_app_file`, `search_app_files`) and emitting structured `upsert_unused_code_bead` items (or `noop`).
2. **Fail-closed `detection` job:** `gh-aw` threat detection runs with `continue-on-error: false` (`report-as-issue: false`). All built-in issue-reporting hooks (`noop`, `report-failure-as-issue`, `report-failed-jobs`, `report-missing-tool`, `report-incomplete`, `report-missing-data`) are disabled so no job in the workflow holds `issues: write`.
3. **Deterministic `upsert_unused_code_bead` safe-outputs job (`contents: write`, default-branch checkout with `persist-credentials: false`):** Gated on `needs.detection.outputs.detection_success == 'true' && needs.detection.outputs.detection_conclusion == 'success'` and enforced again via `--require-clean-detection`. Runs [scripts/apply-beads-safe-outputs.mjs](../../scripts/apply-beads-safe-outputs.mjs) (backed by [scripts/lib/beads-safe-outputs.mjs](../../scripts/lib/beads-safe-outputs.mjs) and `applyRemoteBeadsRef` in [scripts/lib/beads.mjs](../../scripts/lib/beads.mjs)), which validates registered first-party non-upstream apps, checks real app roots and regular-file containment under `apps/<app>/`, applies `--safe --single-app --max-creates 5 --max-updates 10` directly against the fetched remote tip, and pushes with `--force-with-lease` (revalidating `expected_revision` on concurrent push races rather than silently merging; dry-run previews and failed pushes leave local `refs/heads/memory/beads` untouched so retries always publish cleanly).

### Running, previewing, and recompiling

- **Manual dry-run preview:** Trigger `unused-code-triage` via `workflow_dispatch` with `dry_run: true` to inspect the generated `GITHUB_STEP_SUMMARY` without committing or pushing to `refs/heads/memory/beads`.
- **Recompiling after editing `.github/workflows/unused-code-triage.md`:**

```bash
gh aw compile --strict --approve unused-code-triage
```

- **Direct local `--safe` applier invocation:**

```bash
node scripts/beads.mjs apply ops.json \
  --safe \
  --actor "gh-aw/unused-code-triage" \
  --max-creates 5 \
  --max-updates 10 \
  --single-app
```

In `--safe` mode, `applyOperations` enforces strict schema and string-length bounds, requires `expectedRevision` on updates, enforces `dedupeKey` idempotency, rejects deletes, rejects shared-scope writes when `--single-app` is set, and validates the entire batch atomically before committing.

## Automated draft PR worker (Phase 3 `gh-aw` worker)

The weekly worker ([beads-pr-worker.md](../../.github/workflows/beads-pr-worker.md), compiled to [beads-pr-worker.lock.yml](../../.github/workflows/beads-pr-worker.lock.yml)) runs under workflow-level `concurrency: beads-pr-worker` (no overlapping runs) and turns at most one ready single-app `maintenance` bead per run into a **draft PR** for human review (never auto-merging):

1. **Deterministic pre-selection & immutable artifact (`scripts/select-bead-for-pr.mjs`):** Runs inside the read-only `agent` job (`contents: read`, `pull-requests: read`, `copilot-requests: none`, authenticated via `secrets.COPILOT_GITHUB_TOKEN`) before Copilot starts. Refuses non-default refs, pulls `origin/memory/beads` read-only, fetches all open PRs (full pagination, fail-closed on page cap) and closed PRs back to the 30-day cutoff (enforcing a default cap of 2 open `beads/*` PRs and skipping beads with an open or recently closed unmerged PR), selects one registered first-party non-upstream single-app `maintenance` bead, writes `quality-artifacts/beads-worker/selected-bead.json`, uploads it as an immutable `beads-worker-selection` artifact before Copilot starts, and prepares the local `beads/<beadId>-<app>` branch with zero remote push credentials.
2. **Scoped implementation & local verification:** Copilot verifies the finding is safe inside `apps/<app>/`, applies the minimal fix (refreshing `pnpm-lock.yaml` only when `apps/<app>/package.json` changes, never editing `AGENTS.md`/`AGENT.md`/`CLAUDE.md`, `package.json` `scripts`, or non-registry dependency specs), runs the app's own tests/lint/build, commits locally, and verifies strict single-app containment with `node scripts/verify-bead-pr-diff.mjs`.
3. **Fail-closed threat detection & draft-only `safe_outputs`:** `gh-aw` threat detection runs fail-closed (`continue-on-error: false`). Its built-in `create-pull-request` safe output enforces `staged: ${{ inputs.dry_run }}`, `draft: true`, `auto-merge: false`, `max: 1`, `base-branch: main`, `allowed-branches: ["beads/*"]`, `allowed-files: ["apps/**", "pnpm-lock.yaml"]`, `excluded-files` for upstream-synced apps (`qsmbly`, `seedseg`, `dicompare`) and `apps/**/{AGENTS,AGENT,CLAUDE}.md`, `protected-files: request-review`, `fallback-as-issue: false`, `signed-commits: true`, and `github-token-for-extra-empty-commit: none` (human review clicks "Ready for review" to trigger full CI).
4. **Unconditional post-PR audit, auto-close & Beads recording (`verify_and_record_bead_pr` → `scripts/record-bead-pr.mjs`):** Runs whenever `needs.safe_outputs.outputs.created_pr_number` is non-empty (not dependent on any agent tool call). Downloads the immutable `beads-worker-selection` artifact, fetches the exact PR by `created_pr_number` and its paginated file list from the GitHub API, verifies open draft status, default-branch base, `github-actions[bot]` author (note: `GH_AW_GITHUB_TOKEN` PAT is intentionally not configured; setting one would change the PR author and fail closed unless `EXPECTED_PR_AUTHOR` is updated), exact `beads/<beadId>-<app>(-<16-hex>)?` branch, strict single-app file containment (no agent guide files, `pnpm-lock.yaml` only alongside `apps/<app>/package.json`), `package.json` `scripts`/non-registry spec checks, byte-for-byte `pnpm-lock.yaml` regeneration when touched, and live bead eligibility (`open`, `maintenance`, unblocked, unleased). Any violation posts a diagnostic comment and **closes the violating draft PR** without touching `memory/beads`. Clean runs record `links.pr` and a fixed deterministic journal note (no agent-authored text) on `refs/heads/memory/beads` with `--force-with-lease`.

- **Manual dry-run or targeted run:** Dispatch `beads-pr-worker` with `dry_run: true` (enforced via `create-pull-request.staged: ${{ inputs.dry_run }}`, plus optional `bead_id: bd-xxxxxxxx`) to run full verification without opening a PR or modifying `memory/beads`.
- **Recompiling after editing `.github/workflows/beads-pr-worker.md`:**

```bash
gh aw compile --strict --approve beads-pr-worker
```
