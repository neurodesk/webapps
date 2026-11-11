# CI development tiers

Keep iterative PRs in draft. Drafts run repository contracts, package tests,
lint, and app unit/browser tests for directly edited `apps/<id>/` files and
`models/<id>.manifest.json`. If the diff cannot be determined, the app planner
keeps its conservative full selection. Changes confined to shared packages
receive package tests during development; their downstream applications run
when the PR is ready.

Mark the PR ready when it is ready for integration testing. `ready_for_review`
and every subsequent push to a ready PR run the complete affected-app plan,
composite checks, and path-selected native/reference suites. Reopening also
refreshes the checks. Converting a PR back to draft cancels the previous PR
run without starting CI test jobs on the unchanged head. GitHub prevents merging
a draft PR. Before merging a ready PR, verify the full checks on its current
head; this change does not configure repository branch protection.

## Pull request gate for shared path filters

GitHub matches a workflow's `paths` against the whole pull request on every
push. A filter on a shared tree (`packages/components/**`, `pnpm-lock.yaml`,
`registry/**`) therefore started native suites for changes that never reached
them: over 7-9 November 2026, 25,817 of the 27,539 pull request minutes in
path-filtered workflows came from runs whose pull request touched none of the
workflow's own code.

Every workflow with such a filter now starts with a `gate` job that calls
`.github/workflows/pr-gate.yml`, and its entry jobs wait for
`needs.gate.outputs.run`. `scripts/lib/workflow-gate.mjs` decides:

- A changed file under any other filter (the workflow's own package, app,
  `exes/` directory, workflow file, or a single generated import) runs it.
- Otherwise it runs when a script the workflow runs loads a changed file
  (`scripts/lib/module-closure.mjs`): any script of a package it owns (command
  line, tests, validation harnesses, browser pages) or a root script one of
  its steps, or the steps of a local reusable workflow it calls, name. A
  deleted file still counts for the module that names it. It also runs when the lockfile change resolves a package it
  owns differently, or when the app planner, given the whole diff, selects an
  app it filters on. A dependency's `package.json` that only gained `exports`
  entries does not count.
- Python, shell and PowerShell under `scripts/`, `test-utils/` and `test/`
  are not followed, so a change to one runs every workflow whose filters match
  it. A change to any `packages/*/release.json` runs the callers of the shared
  packager, whose release tests read every specification.
- The import closure is a lower bound: a file read through a computed path is
  not seen. Name such a file in the workflow's `paths` to make it the
  workflow's own.
- When it cannot decide (no diff, an unreadable lockfile, a script error) it
  runs.

The gate answers `false` for a draft and `true` for a push or a dispatch
without a checkout. The job always finishes: a skipped gate would skip every
job after the entry jobs. `test/workflow-gate.test.mjs` holds the rules, and
fails when a workflow adds a shared filter without the gate.

Replay a pull request locally with
`node scripts/workflow-gate.mjs --workflow <name> --base <sha> --head <sha>`.

## Pushes to main and the nightly sweep

A gated workflow's `push` filter lists only its own paths, so a merge starts
the native suites it changed and no others. On 10 November 2026 three merges
each started 25 to 37 native workflows on Linux, macOS and Windows through
shared push filters, about 5,200 runner minutes in one day.

Shared paths reach a gated workflow on main through its nightly sweep. Each
has one `schedule`, and for that event the gate runs the workflow when a path
under one of its shared pull request filters changed on main during the last
26 hours (`sweepWorkflow`). The sweep does not ask whether the change reaches
the workflow: it is what first tests a file read through a computed path, and
what builds every target for a shared change the pull request built on Linux
only. A night without such a change costs each workflow one gate job.

- Do not add a shared path to a gated workflow's `push` filter. Name a single
  file there when a push must test it at once.
- To test a shared change on every target before merging, dispatch the
  workflow on the branch.
- A failed sweep opens an issue through `nightly-failures.yml`, like every
  scheduled workflow.
- Replay a sweep with
  `node scripts/workflow-gate.mjs --workflow <name> --sweep-hours 26`.

## Daily usage budget

`ci-usage.yml` runs `scripts/ci-usage-report.mjs` once a day. It lists the
day's workflow runs by wall time and fails, which opens an issue, when a
budget in `scripts/lib/ci-usage.mjs` is exceeded:

| Budget | Limit | What exceeding it means |
| --- | --- | --- |
| Whole-catalogue `ci` runs of one pull request | 2 | Fixes were pushed to a ready pull request. Convert it to draft first. |
| Whole-catalogue pull request `ci` runs in total | 8 | A file the planner ties to every app is changing often. Read the `app-plan` summaries. |
| Workflows one push to main runs, besides `ci` and the deploy | 10 | A `push` filter names a shared path. |

A whole-catalogue run is a `ci` run with at least 100 jobs. Run the report for
any day with `node scripts/ci-usage-report.mjs --until <ISO time>`. Change a
budget only with the measurement that justifies it.

## Agent procedure

Follow the draft lifecycle in [AGENTS.md](../../AGENTS.md#ci-scope).
Keep the PR in draft through local validation and review fixes, and batch
related fixes into a push. Converting a ready PR back to draft must happen
before pushing further edits, so the push receives development feedback.
Use an explicit PR number with `gh pr ready` and `gh pr view` to avoid
changing another PR when working across branches. This also applies when
fixing an `upstream/*` PR created by the sync bot.

If a check fails because of runner infrastructure and no code change is
needed, rerun only the failed jobs on the same head with
`gh run rerun <run-id> --failed`. Keep that PR ready; marking it ready again
after a draft transition would start another set of checks. Investigate test
failures before rerunning them.

The workflows enforce which tests run for the current draft state. They do
not automatically convert PRs to draft or infer whether a push is iterative.
The agent must verify draft status before pushing development changes, and
verify full checks on the final ready head before merging. A previous green
head or a green draft run does not satisfy that requirement.

## Workflow coverage

No label or previous successful commit opts a new commit out of testing.
The existing wide-PR macOS GPU policy remains: full-catalog GPU validation
runs on main, nightly, or manual dispatch. Directly selected GPU apps still
run during draft feedback.

Main CI lets a running push finish while GitHub replaces older pending pushes
with the newest pending push. The next run still compares against the last
green main run, covering accumulated merges. PR pushes cancel earlier runs
of the same PR. Schedule and manual runs keep their separate concurrency
groups, and native release/signing conditions are unchanged.

NeuroFlow and the SDC registration gate start for a pull request only on their
own paths: the builder, the template apps and NeuroFlow's scripts and tests;
the SDC pipeline, the registration kernel and their reference pins. Both take
hours of runner time, so a change to a package they only build on reaches them
on the push to main and in their nightly runs, whose filters stay broad. To
test such a change before merging, dispatch the workflow on the branch.
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
