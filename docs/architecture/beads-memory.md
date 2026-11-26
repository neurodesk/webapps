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
- **Conflict-free sync:** `sync` merges per-item by `(revision, updatedAt)` and unions `journal` entries and `evidence` links, then pushes with `--force-with-lease`.
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

Scheduled GitHub Agentic Workflows (`gh-aw`) must never hold direct write tokens in the LLM container. Instead:

1. A deterministic pre-step runs `node scripts/beads.mjs export --format snapshot --max-items 100` to hand the read-only agent a bounded, sanitized view.
2. The read-only agent emits structured mutation intents (`ops.json`).
3. After `gh-aw` threat detection passes, a privileged `safe-outputs` job executes reviewed default-branch code:

```bash
node scripts/beads.mjs apply ops.json \
  --safe \
  --actor "gh-aw/unused-code-triage" \
  --max-creates 5 \
  --max-updates 10 \
  --single-app
```

In `--safe` mode, `applyOperations` enforces strict schema and string-length bounds, requires `expectedRevision` on updates, enforces `dedupeKey` idempotency, rejects deletes, rejects shared-scope writes when `--single-app` is set, and validates the entire batch atomically before committing.
