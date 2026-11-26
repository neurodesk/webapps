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

1. **Read-only `agent` job (`contents: read`, `copilot-requests: write`):** Generates the Knip unused-code report (`node scripts/report-unused-code.mjs --baseline ""`) and exports a bounded snapshot of `memory/beads` (`node scripts/beads.mjs sync --remote origin` + `export --format snapshot --max-items 100`). The GitHub Copilot agent inspects candidates read-only and emits structured `upsert_unused_code_bead` items (or `noop`).
2. **`detection` job:** `gh-aw` threat detection validates the agent output before any write job can run.
3. **Deterministic `upsert_unused_code_bead` safe-outputs job (`contents: write`, default-branch checkout with `persist-credentials: false`):** Runs [scripts/apply-beads-safe-outputs.mjs](../../scripts/apply-beads-safe-outputs.mjs) (backed by [scripts/lib/beads-safe-outputs.mjs](../../scripts/lib/beads-safe-outputs.mjs)) which validates registered first-party non-upstream apps, checks file existence and realpath containment under `apps/<app>/`, applies `--safe --single-app --max-creates 5 --max-updates 10`, commits to `refs/heads/memory/beads`, and pushes only when the branch actually changed.

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
