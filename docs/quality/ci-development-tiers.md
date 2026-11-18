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
head; this change does not configure repository branch protection. A ready PR
that has already used its whole-catalogue runs gets the draft plan and a
failing `full-plan-withheld` job instead ([enforcement](#enforcement-in-ci)).

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

The gate answers `false` for a draft and `true` for a dispatch without a
checkout. A ready pull request over its full-plan budget
([enforcement](#enforcement-in-ci)) fails the gate, even for the workflow's
own paths, as a draft would skip it, where the change gives `ci` a full plan
wider than its draft plan: there its `ci` run withholds the plan too and fails
`full-plan-withheld` (`budgetedDecision`). The gate fails rather than skips so
that the suite never reads as green; a check that fails runs the workflow. The job always finishes: a skipped gate would skip every
job after the entry jobs. `test/workflow-gate.test.mjs` holds the rules, and
fails when a workflow adds a shared filter without the gate.

Replay a pull request locally with
`node scripts/workflow-gate.mjs --workflow <name> --base <sha> --head <sha>`.

## Pushes to main and the nightly sweep

A gated workflow's `push` filter lists only its own paths, so a merge starts
the native suites it changed and no others. On 10 November 2026 three merges
each started 25 to 37 native workflows on Linux, macOS and Windows through
shared push filters, about 5,200 runner minutes in one day.

A release still matched those own paths: on 13 November 2026 two release
merges (#835, #826) re-ran 24 and 15 native workflows on every OS, 1,368
runner minutes, for version bumps and changelogs whose release dispatches then
built the same packages. So the gate decides pushes too (`mainWorkflow`): the
workflow runs unless every path under its `push` filter that changed since it
last finished green on main, by a push or a sweep, is release bookkeeping
(below). A skipped push still finishes green and moves the base the sweep
reads, and a skipped sweep the base the next push reads, so each also asks
the other's question: a push runs when a path under a shared pull request
filter changed, and the sweep runs when one of the workflow's own paths
changed beyond bookkeeping (a merge whose push run failed or was cancelled).
Without a green run, or when no changed path matches a push filter, a push
runs. Every workflow whose `push` filter covers a whole app, package or
`exes/` directory, where each release writes its bumps and changelogs, calls
the gate too, even without a shared pull request filter; for those the
schedule (NeuroFlow, the SDC registration gate) stays a plain nightly run,
since there is nothing to sweep.
`release.yml` plans with `--release`, so its version bumps still select the
apps to publish.

Shared paths reach a gated workflow on main through its nightly sweep. Each
has one `schedule`, and for that event the gate runs the workflow when a path
under one of its shared pull request filters changed on main since the
workflow last finished green there, by a merge or an earlier sweep
(`sweepWorkflow`, `resolveTestedBase`). A sweep that fails, or that GitHub
drops, leaves that commit where it was, so the next sweep still sees the
change. Without such a run the workflow runs. The sweep does not ask whether the change reaches
the workflow: it is what first tests a file read through a computed path, and
what builds every target for a shared change the pull request built on Linux
only. A night without such a change costs each workflow one gate job.

Release bookkeeping is left aside, because every release writes it into the
shared packages: a `CHANGELOG.md`, a workspace `package.json` whose only
change is its `version`, a version-only change at an `EMBEDDED_VERSION_SITES`
site (`scripts/lib/release-bookkeeping.mjs`) and, for a workflow that builds
registry apps, a valid `registry/standalone.json` in which none of their
entries changed. The same rule, without the download catalog part, keeps the
app planner from selecting apps for a release and the pull request gate from
running a workflow for one: before it, a version bump of
`packages/components` selected all 63 apps.
Replayed over the releases of 3, 8 and 11 November 2026, such a release ran
27 of the 29 scheduled gated workflows before this rule and 1 after it
(`hmc-native`, for a generated source file the same release changed). The
version a portable package lists for a bundled workspace package in its
notices is the one thing such a skipped sweep leaves a day stale.

- Do not add a shared path to a gated workflow's `push` filter. Name a single
  file there when a push must test it at once.
- To test a shared change on every target before merging, dispatch the
  workflow on the branch.
- A failed sweep opens an issue through `nightly-failures.yml`, like every
  scheduled workflow.
- Replay a sweep with
  `GITHUB_REPOSITORY=neurodesk/webapps GITHUB_TOKEN=$(gh auth token) node scripts/workflow-gate.mjs --workflow <name> --sweep`.

## Daily usage budget

`ci-usage.yml` runs `scripts/ci-usage-report.mjs` at 06:41 UTC. It lists, by
wall time, the workflow runs created in the UTC day that ended at the last
midnight, so consecutive reports share a boundary and every run has had hours
to start its jobs. It fails, which opens an issue, when a budget in
`scripts/lib/ci-usage.mjs` is exceeded:

| Budget | Limit | What exceeding it means |
| --- | --- | --- |
| Whole-catalogue `ci` runs of one pull request | 2 | Fixes were pushed to a ready pull request. Convert it to draft first. |
| Whole-catalogue pull request `ci` runs in total | 10 | A file the planner ties to every app is changing often. Read the `app-plan` summaries. |

The total is five pull requests at their own budget. Replayed over the 60
pull requests merged from 8 to 12 November 2026, the planner selected every
app for 13 of them, at most 5 on one day (`scripts/app-plan-shadow.mjs --last
60`). The seven days before the limit existed had 11 to 32 such runs each,
because ready pull requests took several pushes.

A whole-catalogue run is a `ci` run with at least 100 jobs; one still going
when the report runs counts. Runs are grouped by pull request number, and a
fork's by repository and branch. The report also lists the workflows each push
to main ran. That list has no budget, because a release rightly runs most of
them. Run the report for
any day with `node scripts/ci-usage-report.mjs --until <ISO time>`. Change a
budget only with the measurement that justifies it.

### Enforcement in CI

The report fires the next morning, after the runners are spent: on 13 November
2026 one pull request started seven whole-catalogue runs, six of them cancelled
by its next push, and agents bypassed the draft rule by converting to draft,
pushing and marking ready within ten seconds. So `scripts/app-plan.mjs` also
applies the per-pull-request budget when it plans a ready pull request's run.

When the complete plan would select more apps than the draft plan, the run
starts the `full-plan` marker job, and the planner counts the pull request's
earlier full-plan runs from the last 24 hours (`fullPlanDecision` in
`scripts/lib/ci-usage.mjs`): runs that started the marker, and whole-catalogue
runs, whatever event started them, `ready_for_review` and cancelled runs
included. A partial plan counts as much as a whole-catalogue one: on
13 November 2026 one pull request ran its 14 selected apps nine times. Once
the runs fill the budget of 2, the run uses the draft plan, skips the
composite site, and its `full-plan-withheld` job fails, so a withheld run never
reads as the complete affected-app check. The pull request's gated native
workflows skip at the same commits ([gate](#pull-request-gate-for-shared-path-filters)).
The window is rolling rather than the report's UTC day.

To test every app at that head, add the `full-ci` label and use **Re-run all
jobs** on the run and **Re-run failed jobs** on each native workflow whose gate
failed (that re-runs the gate and what waits for it); the planner and the gate
read the labels when they run, so no new trigger is needed. Pushing a new
commit after adding the label also starts every check again. **Re-run failed jobs** keeps the withheld plan. The label stays until
someone removes it, and every later push then gets the full plan again, so
remove it once the head you will merge has passed. A failure to read the runs
or labels keeps the full plan.

## Heavy browser tests

In a whole-catalogue run on 15 November 2026 the CPU browser jobs spent 359
minutes in tests, and 22 tests over 4 minutes spent 211 of them: SDC's SyN run
36, GlioMODA's mirrored run 21, FireANTs' SyN reference 16, the
white-matter-lesions five-fold ensemble 14, both BISON examples 25, four
SynthSeg fixture runs 33. Most are their app's reference parity check.

Tests over 5 minutes are tagged `@heavy` (14 tests, 177 of those minutes; also
NODDI's reference 11, CALMaR's SOOP example 10.4, white-matter-lesions'
per-fold downloads 5.8 and N4's reference 5.2). The next slowest test took
4.6 minutes. On pull requests and pushes to main, in the CPU job, they run only
for an app the change edits:
its `apps/`, `packages/` or `exes/` directory or its model manifest, release
bookkeeping aside, or an app a failed run on main left untested. An app a
change reaches only through shared code, such as a `packages/runtime-support`
edit or a `ci.yml` change, leaves them to the nightly run, so a shared change
that breaks only such a path is found the next night rather than before merge.
The planner marks each browser matrix entry with `heavy_tests`, and the jobs
set `NEURODESK_E2E_SKIP_HEAVY`, which `e2eTier` turns into a `grepInvert`.
A whole-catalogue plan for a change the planner could not narrow, such as a
`ci.yml` edit, counts as shared. Only a plan with no diff at all (the nightly,
a dispatch of every app, an unknown base) is a full run. The macOS GPU job
runs every test, since the threshold is a CPU measurement: SynthSeg's four
`@heavy` tests take 12 to 25 seconds on Metal. Dispatched, nightly and release
runs include every test. To run them before merging a shared change, dispatch
`ci` on the branch.

## Composite site checks

`composite-site` builds the site once with `pnpm build`. It runs the three
checks that read `dist-sites/` and the per-app builds (`audit:artifacts`,
`runtime-assets.test.mjs`, `catalog-sites.test.mjs`) and uploads `dist/` as one
zstd tar: 283 MB from 668 MB in 2.3 s on 18 November 2026. Five jobs download
it through `.github/actions/composite-site` and check it in parallel:

- `site-runtime`: resource cache and threaded runtime startup.
- `site-audit`: the example cache and the interface audit.
- `site-e2e`: composite smoke, e2e types and the workspace e2e catalog.
- `site-mobile`: interface workflows, scan pickers and mobile layouts.
- `site-catalog`: component browser checks, automation contracts and the
  cross-browser handoff.

`agent-interactions`, `processing-workflows` (a dispatch with
`agentic_mode=pipeline`) and `example-cache-retention` wait for all five, as
they waited for the one serial job before the split, which ran every check in
sequence for 31 to 33 minutes and was the last job of every ready one-app pull
request. The artifact is kept 3 days. Re-running one failed check after that
fails at the download with a message to use "Re-run all jobs", which builds
the site again.

The per-app checks read `SMOKE_APPS` (`scripts/lib/smoke-apps.mjs`), which
`composite-site` sets with `scripts/site-check-apps.mjs`:

| Event | Apps the per-app site checks cover |
| --- | --- |
| Draft pull request | None: the site is not built |
| Ready pull request, push, dispatch with `scope=affected` | The selected apps, the canaries seedseg, dicompare and syncro, and the apps a check compares them with or reads files from |
| Any of these when the plan selects every app or `site_code` is true | Every app |
| Nightly, dispatch with `scope=all` or `scope=site` | Every app |

`site_code` is the planner's answer to "does the change reach code the site
jobs run?". Every reason that selects the site build counts, except data the
per-app checks do not read: the composite-only site files, registry, app
information and standalone entries, and the offline asset lock. A change to a
check, a helper it imports or `scripts/build-site.mjs` checks every app.
Catalogue-level checks (landing page, catalogue sites, runtime assembly,
artifact budgets, automation contracts) run whenever the site is built. A
canary that is not a registered app of its shell, or a shell without a canary,
fails the selection.

A narrowed check is sound only where its result for an app depends on that app
alone. Two places keep the other dependencies inside the selection:

- The planner selects every app whose built pages change with the change. An
  app's page carries the handoff catalog of every app its hosts serve, so a
  `registry/apps.yml` change to what that catalog lists (an app's id, path,
  title, `handoff`, `support_status` or hosts) selects the apps that render it:
  those whose code names `HANDOFF_CATALOG_READERS` (DICOM View). A file of one
  app that another app's code names by a relative path selects that app too:
  DICOM View and SeedSeg stage dicompare's embedding kit, and seven apps' tests
  read the CALMaR T1 fixture.
- A check whose result for one app depends on another declares it as `needs`,
  and `smokeApps` adds those apps before the check runs (null runs every app):

| Check | Listed app | Also runs |
| --- | --- | --- |
| MindGrab CPU parity (`parityPeers`) | A consumer of a shared CPU binary | One other consumer of it, from `runtime-assets/manifest.json` |
| BET startup (`betNeeds`) | `calmar`, which owns the fixture | `qsmbly` and `brain-extraction` |
| Asyncify startup (`asyncifyNeeds`) | `synthsr`, which installs the ONNX Runtime API it loads | Every `ort-web-asyncify` consumer in the registry |

A parity peer runs only the binaries it shares with a listed app, so the peer
of `lcmodel` segments with mindmap alone. The parity check now runs every
shared CPU binary in two apps and fails one compared in a single app. Before, the nightly ran mindmap, mindsnap and
16chan18cls in one app each, so their parity compared an output with itself.
The three extra segmentations take about 125, 126 and 54 s (nightly run
44230450914), so `site-runtime` takes about 5 minutes longer on a
whole-catalogue run.

A failed site job names no app, so the next push to main diffs from the last
green `ci` run instead and carries no app: it checks the apps that the merges
since that run reach, its own change's apps and the canaries. That covers what
a failed push run checked, since that run's changes are among those merges. It
does not cover an app that a failed nightly run found broken but no merge since
the last green run reaches. The next nightly run checks it again, as does a
dispatch with `scope=all` or `scope=site`.

On 18 November 2026, against a full local build, the one-app selection
`niimath` with the canaries took 23 s for runtime startup (9.7 minutes for the
catalogue in CI), 125 s for the interface audit (8.1 minutes), 36 s for mobile
layouts (1.8 minutes), 17 s for interface workflows (1.0 minute), 50 s for the
composite smoke (1.8 minutes) and 49 s for the e2e catalog (2.4 minutes).
dicompare, the only React app, takes 77 s of that audit.

## Module-level selection in the component package

Every app depends on `packages/components`, so a change anywhere in it used
to select all 63 apps. On 10 November 2026 four pull requests changed
`src/file-io/tiff.js` or a module beside it, and each of their ready pushes
tested the whole catalogue.

The planner now asks which apps load the changed module
(`scripts/lib/shared-module-users.mjs`). A user's entry points are the import
specifiers and paths its text names; the modules it loads are their import
closure inside the package. A change to `src/file-io/tiff.js` selects 30 apps,
`src/fft/index.js` 14, and a module the shell or `/ui` loads still selects all.

The analysis reads text, so it errs towards more apps:

- A directory reference loads every file in that directory.
- A computed specifier, an import-map prefix, the package root or a path that
  does not exist loads the whole package. The six import-map apps copy the
  source directory and are selected by every change.
- Declaration files, styles, the manifest, scripts and tests of the package reach all its users,
  as before. A manifest that only gains `exports` entries selects nothing.
- A root script that reads a list of modules from the source directory names
  the list in `LISTED_READS`. When the script's text stops matching, it loads
  the whole package again.

It cannot see a module loaded through a name built at run time from a
directory listing. `test/shared-module-users.test.mjs` checks every literal
component import in every app against the selection. With `tiff.js` broken on
purpose, `dcm2niix` and `niimath` (not selected) built and `structure-tensor`
and `stardist` (selected) failed.

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

A manual `ci` run plans like a pull request: `gh workflow run ci --ref
<branch>` tests the apps the branch changed since it left main (on main,
since the last finished run, as a push does). `-f scope=gpu` runs only the macOS GPU suite of
those apps, `-f scope=site` only the composite site and its agentic checks
(with `agentic_mode`), and `-f scope=all` every app. Like a pull request,
`affected` builds the composite site only when its plan needs it. On 13 November 2026 all
three manual runs tested every app (3,037 runner minutes) to reach the GPU
suite or the agentic checks. A dispatch no longer moves the tested base main's
pushes diff from, since its scope can leave apps out.

Main CI lets a running push finish while GitHub replaces older pending pushes
with the newest pending push. The next run compares against the nearest
finished main run, covering accumulated merges. When that run failed, the
push also selects the apps whose `app-tests` or browser jobs did not pass
there (`resolveCiBase`, `carriedApps`): on 13 November 2026 synthsr's GPU job
failed for 7 hours, and each push in that time tested all 63 apps from the
last green run; replayed, the second of them selects synthsr alone. A failed
job that belongs to no app, such as the plan itself or a site job (it checked
only the apps of its own run), a job of that attempt that has not finished, or
an app id the registry does not know sends the push back to the last green run. A carried app runs all its jobs again, but a push
leaves out `@slow` tests, so an app a nightly failed in a `@slow` test is
retested in full only by the next nightly. Jobs only the nightly runs
(`agent-interactions`) are not carried: the nightly runs them again. PR pushes cancel earlier runs
of the same PR. Schedule and manual runs keep their separate concurrency
groups, and native release/signing conditions are unchanged.

NeuroFlow and the SDC registration gate start for a pull request only on their
own paths: the builder, the template apps and NeuroFlow's scripts and tests;
the SDC pipeline, the registration kernel and their reference pins. Both take
hours of runner time. A merge starts NeuroFlow on the same paths, because
nearly every merge touches a package its apps build on: on 10 November 2026
that started 19 push runs, of which 14 were cancelled by the next merge. Its
nightly run has no filter and covers those packages. The SDC gate also starts
on main for the files it imports from other packages. To test such a change
before merging, dispatch the workflow on the branch.
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
draft. Ready PRs retain full coverage on every update until they reach the
whole-catalogue budget. No numerical saving is
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
