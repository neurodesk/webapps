# CI development tiers

Keep iterative PRs in draft. Drafts run repository contracts, package tests,
lint, and app unit/browser tests for directly edited `apps/<id>/` files and
`models/<id>.manifest.json`. If the diff cannot be determined, the app planner
keeps its conservative full selection. Changes confined to shared packages
receive package tests during development; their downstream applications run
when the PR is ready.

Mark the PR ready when it is ready for integration testing. `ready_for_review`
and every subsequent push to a ready PR run the complete affected-app plan,
composite checks, and path-selected native/reference suites. Reopening and
converting a PR back to draft also refresh the checks. GitHub prevents merging
a draft PR. Before merging a ready PR, verify the full checks on its current
head; this change does not configure repository branch protection.

No label or previous successful commit opts a new commit out of testing.
The existing wide-PR macOS GPU policy remains: full-catalog GPU validation
runs on main, nightly, or manual dispatch. Directly selected GPU apps still
run during draft feedback.

Main CI lets a running push finish while GitHub replaces older pending pushes
with the newest pending push. The next run still compares against the last
green main run, covering accumulated merges. PR pushes cancel earlier runs
of the same PR. Schedule and manual runs keep their separate concurrency
groups, and native release/signing conditions are unchanged.

NeuroFlow push triggers now match its PR paths. Its nightly backstop remains.
Native workflows that call the portable packager use generated Node-driver
paths: run `node scripts/sync-native-driver-paths.mjs` after changing their
imports. The contract suite checks the generated paths and the existing
command-line dependency lower bound. Component filters stay broad because
many native workflows also build and exercise browser reference apps.
The closure scanner does not resolve computed imports; caller-pinned runtime
and package filters remain explicit. Expanding this narrowing requires
checking those reads as well as imports.

`setup-wasm-pack` caches the pinned executable by version, OS and architecture,
independently of app Rust caches. On a miss it builds the same locked version.
CI and Pages use this action. Application bundle reuse across jobs is deferred
until artifact provenance and runtime staging can be checked separately.

## Evidence and limits

The November 3 Opus audit collected 1,394 completed workflow runs from the
November 1–3 09:54 UTC cohort, excluding failure-report workflows and 12
uncollected completed runs. It measured 36,818 Linux minutes by rounding each
job's execution up to a minute. PRs accounted for 26,671; pushes for 6,283.
The PR `ci` workflow used 15,017, including 5,803 in cancelled runs. Native
workflows used 11,405 Linux minutes on PRs. Composite-site used 898 across all
CI events and Pages used 511. These are execution usage, not billed minutes.

Full-catalog PR runs sampled at 554–608 Linux minutes. Draft tiers reduce how
often that cost is incurred during iteration, but only if work is kept in
draft. Ready PRs retain full coverage on every update. No numerical saving is
claimed until comparable post-change runs are measured. Shadow replay checks
the unchanged ready-PR planner; draft omissions are intentional, not oracle
misses that should be silently ignored.

Before this change, the five most recent completed `ci` runs collected with
`node scripts/ci-minutes-report.mjs --since 2026-11-01 --limit 5` included three
finished full-catalog PR runs: median 583 Linux minutes, p90 608. The limited
sample excludes 58 other completed runs and is not the monthly total.

`node scripts/app-plan-shadow.mjs --last 10` replayed PRs #680, #679, #678,
#677, #676, #674, #673, #672, #671 and #670 with zero oracle misses. It selected
391 of 474 app-test jobs, 407 of 494 browser jobs and 76 of 90 GPU jobs. This
validates ready-PR coverage, not a forecast of draft-tier savings.
