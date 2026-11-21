# CI development tiers

Keep iterative PRs in draft. Drafts run repository contracts (`workspace-contracts`),
fast quality checks (`correctness` and `dependencies`, deferring `unused-code` and
`mutation` until ready), shared package tests (`package-tests`, which runs in parallel
with `workspace-contracts` and skips doc/changeset/easter-egg-only drafts), the homepage
easter egg unless every changed path lies in a tree it cannot read, and app unit and build
tests (`app-tests`) for directly edited `apps/<id>/` files and `models/<id>.manifest.json`.
If the diff cannot be determined, the app planner keeps its conservative full
selection. Changes confined to shared packages receive package tests during
development; their downstream applications run when the PR is ready. Changes confined
to `site/app-theme.css` test its direct app consumers (`SITE_THEME_CONSUMERS`) plus the
complete composite site (`siteCode = true`), and `site/fonts/` tests the complete
composite site, without running all 63 per-app unit/WASM matrices.

A draft starts no browser job (`browser-e2e`, `browser-e2e-gpu`). To run the
browser tests of a draft, dispatch `ci` on its branch:

```sh
gh workflow run ci.yml --ref <branch> -f scope=affected
gh run list --workflow ci.yml --branch <branch> --event workflow_dispatch --limit 1
```

The dispatch plans what the branch changed since it left `main` as a ready
pull request would (unit, browser and macOS GPU tests of those apps, and the
composite site when the plan needs it), not the draft's narrower plan. Its
result shows in Actions and on the commit, not in the pull request's checks
list: PR #681's checks held only its pull request run while a newer dispatch
run of the same commit held 115 more. It does not count against the
full-plan budget, which counts only pull request runs (`listPullRequestRuns`).

This costs feedback. In a snapshot of the 48 hours to 18 November 2026, 46 of
63 draft `ci` runs ran browser jobs: 61 jobs, 548 minutes on Linux and 56 on
macOS, 262 of them in runs a later push cancelled. No failure was recorded
among the 61 (two were still running when the snapshot was taken), so no draft
run in that window is known to have found a browser failure first. A person or agent who relied
on draft browser runs now dispatches `ci` or marks the pull request ready,
where a ready pull request has a budget of two full-plan runs in 24 hours
([enforcement](#enforcement-in-ci)).

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

Every workflow that builds on such a tree now starts with a `gate` job that
calls `.github/workflows/pr-gate.yml`, and its entry jobs wait for
`needs.gate.outputs.run`. It lists the shared filters in the gate job's
`shared_paths` and only its own paths in `on.pull_request.paths`
([one run for shared paths](#one-run-for-shared-paths)).
`scripts/lib/workflow-gate.mjs` decides with both kinds of filter:

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

The gate job skips draft pull requests (and `converted_to_draft`) at the workflow level
with zero runners (`NOT_DRAFT_CONDITION`), and answers `true` for a dispatch without a
checkout. A ready pull request over its full-plan budget
([enforcement](#enforcement-in-ci)) fails the gate, even for the workflow's
own paths, as a draft would skip it, where the change gives `ci` a full plan
wider than its draft plan: there its `ci` run withholds the plan too and fails
`full-plan-withheld` (`budgetedDecision`). The gate fails rather than skips so
that the suite never reads as green; a check that fails runs the workflow. On ready
pull requests and non-PR events the gate always finishes: a skipped gate skips
every job after the entry jobs (and `native.yml` calls also require `NOT_DRAFT_CONDITION`,
keeping fail-open intact for ready pull requests and schedules). `test/workflow-gate.test.mjs`
holds the rules, and fails when a workflow adds a shared filter without the gate.

Replay a pull request locally with
`node scripts/workflow-gate.mjs --workflow <name> --base <sha> --head <sha>`,
or for every workflow `native.yml` calls with
`node scripts/workflow-gate.mjs --native --base <sha> --head <sha>`.

### One run for shared paths

GitHub starts every workflow whose filters match, so a shared filter in 30
workflows started 30 runs for each push to a pull request that touched the
tree, and most of them only ran their gate. Over 16-18 November 2026, 194
native workflow runs did nothing but answer "do not run", and each night
started 29 sweeps.

A shared filter now lives in the gate job's `shared_paths`, and a pull
request that changes one starts `native.yml` instead. Its gate
(`pr-gate.yml` with `workflow: native`) decides for every workflow with
`shared_paths` at once (`dispatchDecision`), and `native.yml` calls the ones
that run through `workflow_call`:

- A workflow one of whose own paths changed was started by GitHub itself,
  and its own gate decides with both kinds of filter. `native.yml` skips it,
  with the explicit verdict "starts itself", only when that start is certain
  (`certainOwnStart`): fewer than 3,000
  changed files, and an own match that is neither side of a rename or copy,
  is a plain ASCII path, and falls under a literal filter, a directory
  followed by `**` or one `*` in the last segment, without a hidden file
  under a wildcard, in a filter list without exclusions. Anything else it
  decides too, so a workflow can run twice, never not at all.
- A workflow none of whose shared paths changed is one GitHub would not have
  started. Shared filters match as GitHub's do (`*` any character but `/`,
  `**` any character, a newline included), and a path outside the plain
  ASCII set counts as matching all of them. Any other workflow gets the
  decision its own gate would have given.
- A called workflow runs on the pull request's own event, commit and ref:
  GitHub gives a called workflow its caller's `github` context. Its own gate
  answers `true` without a checkout, because `github.workflow_ref` names
  `native.yml`.
- A draft names every workflow in the gate's `calls` list, generated into
  `native.yml`, without a checkout.

Running is the default. The gate answers with the workflows it decided to
skip, each by an explicit verdict (`skips`), and each call's generated `if:`
(`callCondition`) skips it only when a gate that succeeded names it there.
Absence means run: a workflow the answer leaves out, through a dropped,
truncated, recased or unknown name or an empty list, runs. The decide step
passes on the script's answer only when `jq` finds exactly one array whose
names all come from `calls` (`sweeps` on the schedule), and fails, with a
warning, when the script fails or prints anything else. So a failed
checkout, install or script, a gate that hits its timeout or is skipped,
and any answer the step does not pass on run every workflow `native.yml`
calls (on the schedule, every one it sweeps). The one outcome that skips
calls without being named is a budget denial the gate confirmed: the script
writes `withheld=true` before any other output, summary or annotation, the
step then succeeds so that the output arrives, every call skips, and the
`full-plan-withheld` job fails the run. A missing or unreadable budget
answer, or one not read within the deadline, is no denial.

Inside the gate the decision fails open too (`scripts/lib/native-decision.mjs`):
every workflow it may call starts selected, and a stage that throws, cannot
be read or is cut off by the five-minute deadline, which covers the budget
reads, leaves the workflows it was deciding selected, never named in
`skips`. An unreadable diff
(read NUL-delimited by `readChangedPaths`, so a name keeps its spaces, and
never taken for an empty one) selects every workflow; a workflow file or
registry that cannot be read selects every workflow not certainly started by
its own paths; a failed decision selects its workflow; a summary that cannot
be written changes nothing. `test/native-decision.test.mjs` evaluates every
call condition for each gate outcome and for a seeded stream of corrupted
skip lists passed through the real decide step, runs that step under
`bash -eo pipefail` with failing stubs, and makes each stage fail in turn.

`test/workflow-gate.test.mjs` checks, over every workflow `native.yml` calls
and sample diffs of its own and shared paths, that the two routes together
run a workflow exactly when its own gate did before, and twice only where
its own start is not certain.

`node scripts/native-workflow.mjs` writes `native.yml` from the workflow
files: its pull request paths are the union of every `shared_paths` and the
gate's own files, and it has one job per workflow, granting the permissions
that workflow's jobs ask for and passing the secrets on. Adding
`shared_paths` to a workflow means adding `workflow_call` to its triggers and
running the script; the test fails when `native.yml` is stale.

GitHub's limits on reusable workflows shape the rest
([reusing workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)):

- One workflow file can call at most 50 unique reusable workflows, nested
  ones included, through at most ten levels. In November 2026 `native.yml`
  reached 32 (30 workflows, `node-cli-portable` and `pr-gate`). The test fails
  before the count passes 50; the next step then is one called workflow for the
  portable command lines, which build through `node-cli-portable` from each
  package's `release.json` and differ only in their inputs.
- `uses` takes no expressions, so each called workflow is a job of its own.
- A called workflow reads `native` in `github.workflow`. Each one names its
  concurrency group after itself, and none reads `github.workflow`.
- Every called workflow runs in one workflow run, where an artifact name
  must be unique: `node-cli-portable` names its archives after the package.
- Re-running failed jobs of `native.yml` reruns the called workflows' failed
  jobs at the first attempt's commit.

A workflow that runs inside `native.yml` reports under it: its checks are
named `native / <workflow> / <job>`, and a failed sweep is a failed
scheduled `native` run, whose report names every affected workflow before
its per-job details. `native.yml` counts as notarizing because the workflows
it calls do, so a notarization refused inside it is alerted too. Its
workflows' pushes and release dispatches still run as the workflow itself.

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
the other's question: a push runs when a path under its `shared_paths`
changed, and the sweep runs when one of the workflow's own paths
changed beyond bookkeeping (a merge whose push run failed or was cancelled).
Without a green run, or when no changed path matches a push filter, a push
runs. Every workflow whose `push` filter covers a whole app, package or
`exes/` directory, where each release writes its bumps and changelogs, calls
the gate too, even without `shared_paths`; for those the
schedule (NeuroFlow, the SDC registration gate) stays a plain nightly run,
since there is nothing to sweep.
`release.yml` plans with `--release`, so its version bumps still select the
apps to publish.

Shared paths reach a gated workflow on main through the nightly sweep:
`native.yml`'s schedule, for every workflow it calls that a push also starts.
Its gate runs a workflow when a path under the workflow's `shared_paths`
changed on main since the workflow last finished green there, by a merge or
an earlier sweep (`sweepWorkflow`). That is the newest green push run of the
workflow, or the newest scheduled `native.yml` run in which the workflow's
part was green: the gate decided and each of its jobs passed or was skipped
(`dispatchedRuns`). A sweep that fails, or that GitHub drops, leaves that
commit where it was, so the next sweep still sees the change. Without such a
run the workflow runs, and so it does when a history read fails or the
deadline cuts it off: the reads list jobs in pages of 30 and retry gateway
errors (`createGitHubClient`), and a registry that cannot be read runs all of
them. The sweep does not ask whether the change reaches
the workflow: it is what first tests a file read through a computed path, and
what builds every target for a shared change the pull request built on Linux
only. A night without such a change costs one gate job in all.

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
- A failed sweep fails the scheduled `native` run and opens an issue through
  `workflow-reports.yml`, like every scheduled workflow; the failed jobs
  carry the workflow's name.
- Replay a sweep with
  `GITHUB_REPOSITORY=neurodesk/webapps GITHUB_TOKEN=$(gh auth token) node scripts/workflow-gate.mjs --native --sweep`.

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

### Daily measures

After the budgets, the report shows whether the CI got cheaper and faster.
These measures are report-only: none fails the job. Job minutes are the time
each job held a runner, from the jobs of every run that was not skipped. They
count the latest attempt of each run only, cancelled minutes too: the job
listing leaves out the earlier attempts of a re-run.

| Measure | Definition | Target |
| --- | --- | --- |
| Job minutes per merged pull request | For each pull request merged in the window: its runs of every workflow on its head branch from its opening to its merge (earlier days included), its merge queue runs, and the push runs of its merge commit, also those created after the window up to the report. Median and the three largest. | - |
| Fixed-job share | Of the job minutes of pull request `ci` runs, the share in `plan` and `fixed` jobs, for draft, ready, whole-catalogue, unknown-tier and all runs. | Draft runs under 30% |
| Ready to green | For each ready pull request `ci` run that succeeded, the start of its latest attempt to completion, so a late re-run does not count the wait before it; a re-run of failed jobs counts only the re-run. Median and 90th percentile, apart for whole-catalogue runs. | Median under 20 minutes |
| Merge to live | For each push to main (the first run of its commit), to the completion of the first successful `deploy-github-pages` run on main of that commit or a later one, also after the window. A deploy on main runs main's head when it is created, so one of a commit the pushes do not name counts for the pushes created before it, not those created in the same second. Median and maximum; pushes not yet live are listed. | - |
| Runs that tested nothing | Runs that were skipped, ran no job, or ran only `plan` and `report` jobs. Count and share of all runs. | - |
| Cancelled minutes | Job minutes of cancelled runs. | - |

A pull request `ci` run is whole-catalogue when it ran at least 100 jobs, ready
when a job only a ready pull request starts (`full-plan`, `full-plan-withheld`,
`composite-site` or one of the five site checks, which a re-run of one failed
check runs alone) took a runner, and draft otherwise. A ready run that selects
neither the site nor more than its draft plan counts as draft. A cancelled run
that lists such a job, neither skipped nor given a runner, is of unknown tier:
a run cancelled while planning cancels those jobs whatever its plan. The
report shows these runs in their own row.

`WORKFLOWS` in `scripts/lib/ci-measures.mjs` gives each workflow, by name, and
each `ci` job, by the name the API lists it under (its `name:`, else its id), a role: `plan` (planner, gate, plan marker), `fixed` (the baseline
group the share is measured against: `workspace-contracts`, which still runs on
every `ci` run, and `homepage-easter-egg`, which still runs on every push,
nightly and dispatch and which a pull request skips only when every changed
path lies in a tree it cannot read), `app`,
`site`, `test`, `deliver` or `report`. In a test workflow the reusable gate's
jobs plan, also inside a workflow `native.yml` calls (`bison-native / gate /
decide`), and every other job tests. A workflow or `ci` job the table does not
name is `unclassified`: it counts in the totals and in no share, and the report
lists it, also when it started no job. `test/ci-measures.test.mjs` requires an
entry for every workflow file (`.yml` or `.yaml`) and every job of `ci.yml`
under its API name, and that each test workflow's gate jobs plan, so rename
both together.

The targets are the CI optimisation program's goals of November 2026. In the
48 hours to 18 November 2026 11:00 UTC the draft share was 58%, ready to
green 34 minutes and merge to live 20 minutes. They become budgets only once
the changes that reach them have landed and the numbers have held; a budget
opens an issue on every miss.

The draft share reads worse as drafts get cheaper. Since drafts start no
browser job, the same 68 draft runs of that window would hold 1,015 fixed
minutes of 1,139 instead of 1,743, counting completed job times: the share
rises from about 58% to about 89%, while a
draft run falls from 25.6 to 16.8 minutes, 14.9 of them fixed. With only the
apps it edits left to test, a draft is mostly its fixed jobs, so a share
under 30% is out of reach until the fixed jobs themselves shrink. Read the
fixed and total minutes the row prints next to the share, and the minutes per
draft run they give.

The budgets come first, on about 80 requests a day (the run listings and one
job count per `ci` pull request run that did work), and alone decide the exit
code; nothing the measures do changes it. The measures then read the deploys,
the merged pull requests and their runs outside the window, and the jobs of
every run that was not skipped. Every one of these reads goes through one
runner, `limitedReads` in `scripts/lib/github-actions.mjs`. It reads listings
a page at a time and charges each page and each retry before sending it, so the
measures send at most 600 requests (`--max-requests`) however many listings run
at once. That is well below the 1,000 an hour a workflow token may make, which
other workflows share. The runner also kills every request 10 minutes after the
report started (`--time-limit`), well below the job's `timeout-minutes` of 15.
Each run, job, pull request and deploy record must have the fields the measures
use, of the API's types, before a measure reads it. Once the cap or the time
limit is reached or a request is refused (a rate limit, for instance), the
report sends no further request. Each measure that lacks data, for that reason
or because a record failed the check, shows `unavailable:` with the reason,
never a zero, `undefined` or `NaN`. A step summary or a standard output that cannot be written loses
the measures, not the exit code. The report prints both request counts.

The 48 hours to 18 November took 987 measure requests in about four minutes,
980 of them job pages. The two 24-hour halves of that window needed 304 and 676
job pages and its one complete UTC day 240, so on a busy day the cap can leave
the job measures unavailable. Of the 980 pages, 235 list runs of report-only
workflows (185 `workflow_run` reporter runs and 50 scheduled reports). The
report still reads them: they give the report role's 131 job minutes and tell a
run that started no job from one that only reported. `workflow-reports.yml`
has since replaced the two `workflow_run` reporters with four scheduled runs a
day, and another pull request of the CI optimisation program of November 2026
replaces the 194 runs that only ran a gate with one native run per pull request.

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
runs, of any pull request activity type, `ready_for_review` and cancelled runs
included. A partial plan counts as much as a whole-catalogue one: on
13 November 2026 one pull request ran its 14 selected apps nine times. Once
the runs fill the budget of 2, the run uses the draft plan, skips the
composite site, and its `full-plan-withheld` job fails, so a withheld run never
reads as the complete affected-app check. The pull request's gated native
workflows skip at the same commits ([gate](#pull-request-gate-for-shared-path-filters)).
The window is rolling rather than the report's UTC day.

To test every app at that head, add the `full-ci` label and use **Re-run all
jobs** on the run and on `native` (whose gate succeeds with the denial, so
only re-running all its jobs reads the label), and **Re-run failed jobs** on
each other native workflow whose gate failed (that re-runs the gate and what
waits for it); the planner and the gate
read the labels when they run, so no new trigger is needed. Pushing a new
commit after adding the label also starts every check again. **Re-run failed jobs** keeps the withheld plan. The label stays until
someone removes it, and every later push then gets the full plan again, so
remove it once the head you will merge has passed. A failure to read the runs
or labels keeps the full plan.

## Parked: merge queue support and a required check

Both were built, measured or reviewed in November 2026 and parked on the
branch `ci/merge-queue-support`, for the maintainer to decide:

- Merge queue support (a `merge_group` trigger, and a push to `main` that skips
  what a green queue run of each of its commits tested). With one entry per
  queue run it adds about 12% runner minutes over the 12 pushes of 16 to 18
  November 2026: the pushes repeat 1,294 fewer minutes and the queue runs add
  about 1,508.
- `ci-required`, one aggregate job a ruleset could require. A review found
  that it does not yet mean "the ready run of this head was green": a matrix
  leg can be cancelled while `needs` reads success, a draft run publishes the
  same check on the same commit, unexpected skips pass, it pushed a 99-job
  plan over the 100-job budget threshold, and the standalone publisher has
  no supported bypass. The branch lists each with its fix.

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
edit or a change to a per-app job of `ci.yml`, leaves them to the nightly run, so a shared change
that breaks only such a path is found the next night rather than before merge.
The planner marks each browser matrix entry with `heavy_tests`, and the jobs
set `NEURODESK_E2E_SKIP_HEAVY`, which `e2eTier` turns into a `grepInvert`.
A whole-catalogue plan for a change the planner could not narrow, such as an
edit to a per-app job of `ci.yml`, counts as shared. Only a plan with no diff at all (the nightly,
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
information and standalone entries, the offline asset lock, and the `site`
keys of `registry/apps.yml` that no app page carries (`SITE_DATA_KEYS`: the
hub, categories, analytics period, domain, and a catalogue's heading,
description, hosting and desktop suite). A change to a check, a helper it
imports, `scripts/build-site.mjs`, a site job of `ci.yml`, or a `site` key the
composite build writes into every app page (a catalogue's id, host, title or
brand, the analytics id) checks every app.
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
  those whose code names `HANDOFF_CATALOG_READERS` (DICOM View). A change to
  which apps are registered also selects the apps that reach
  `AUTOMATION_CATALOG_READERS` (Pipeline Builder, whose bundle has a tool per
  operation of every registered app). A file of one app that another app's code
  names by a relative path selects that app too: DICOM View and SeedSeg stage
  dicompare's embedding kit, and seven apps' tests read the CALMaR T1 fixture.
  That rule sees literal relative paths to files and directories only; a glob,
  an interpolated path or a repository-root-relative string selects nothing
  more, so it adds to the selection without being a complete map.
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

## Site keys, ci.yml jobs and the fixed jobs

Over 16 to 18 November 2026 two small changes cost 2,577 runner minutes of
whole-catalogue runs. PR #864 changed a comment in the `composite-site` job of
`ci.yml` and the interface audit it runs; PR #872 changed a link in the `site`
section of `registry/apps.yml`. The planner then tied any `ci.yml` edit and any
`site` change but a category to every app.

A `site` change now narrows per key. `SITE_KEY_READERS` lists every key of the
section (`[]` is each entry of a list) with the files an app build or an app's
tests run that read it: the analytics measurement id (every themed build), the
catalogue ids (the standalone check every themed build runs), and the desktop
identities, catalogue hosts and primary domain (the desktop scripts that
dicompare and Pipeline builder reach). `suite.mjs` and `pack.mjs` hold a whole
catalogue entry, so every catalogue key counts as read by them. A changed key
selects the apps that reach a reader, once the head registry passes the
validation every build runs; the hub, the analytics period and the categories
select only the site build. A key the table does not list, at any depth and
whatever its value (an empty mapping, a list, a new key under `site.hub`),
anywhere in the base or head section, selects every app. Key paths are
compared as arrays of raw segments, so a single key named `brand.home` is not
the listed `brand` then `home`: a key with a dot or bracket is one the table
does not list. `test/app-plan.test.mjs` lists every file an app build or app
test runs that loads the registry or reads its `site` section, reads each
one's text for the keys it reads (a chain from `.site`, a list iterated with a
callback, the catalogue helpers; a chain that stops at a mapping or list, or a
whole catalogue entry, reads every key below it) and fails when the table does
not list the file for one. Any other use of the registry object the check does
not recognise, such as nested destructuring, a spread or a call to an unknown
function, a computed member (`registry[key]`) or computed destructuring
(`const { [key]: section } = registry`), reads every key. The easter egg reads
`registry/apps.yml`, so a pull request that changes the registry runs it.

A `ci.yml` change is compared job by job on the parsed workflow, so a comment
changes nothing (`CI_JOB_SCOPES` in `scripts/lib/app-plan.mjs`). It narrows only
when the base and head have the same jobs and every job that needs a changed
job, or that a changed job needs (the plan aside), at the base or the head, has
the changed job's scope. Then a change confined to `composite-site` or a job
that only consumes its build (the five site checks, `processing-workflows`,
`agent-interactions`, `example-cache-retention`) selects the site build, with
its per-app checks over every app because it changes code they run; one confined to
`homepage-easter-egg` runs the easter egg; and one confined to
`workspace-contracts`, which runs on every run anyway, or to the `full-plan`
markers selects nothing more. An added or removed
job, a `needs` link to a job of another scope, the plan, the per-app jobs and
every key outside `jobs` still select every app, as does a change whose base
text is unknown. The nightly run tests every app, so a narrowed `ci.yml`
change that breaks an app job is found there.

`workspace-contracts`, `homepage-easter-egg` and `app-plan` used 1,015 minutes
in 63 draft runs, the two fixed jobs alone 956; the easter egg used 445 minutes
in 102 runs in which no pull request touched it. `workspace-contracts` still
runs on every run and tests every package (`pnpm test:packages`), as before.
`homepage-easter-egg` runs on every push, nightly and dispatch but
`scope=gpu`, as before, and also when the plan fails (`!cancelled()`). A pull
request skips it only on proof: the plan succeeded and wrote `skip` to its
`easter_egg` output, which it does only when every changed path lies in a tree
the job cannot read (`easterEggCannotRead` in `scripts/lib/app-plan.mjs`). Any
other output, an empty one included, runs it. The trees are `apps/`, `exes/`,
`models/`, `docs/` and every package outside the job's closure, which is
`packages/analytics` alone. A workspace manifest in them still runs it
(`WORKSPACE_MANIFESTS`: `package.json`, `package.json5` and `package.yaml`).
pnpm reads each as its own project, a second one beside `package.json`
included, so one can take the easter egg's name; the job's `pnpm install`
reads every manifest and runs their install scripts. Any other path runs it: every root file, `.github/`, `.changeset/`,
`scripts/`, `test-utils/`, `test/`, `registry/`, `site/`, `templates/`, the
lockfile and workspace files, and a path no rule knows. `EASTER_EGG_INPUTS`
lists the files the job reads, the evidence that no skip tree holds one:
`test/app-plan.test.mjs` pins the job's commands and the package scripts they
run, follows the imports and URLs of the test, the inputs and every source
file of the easter-egg packages, and requires every file the job's
environment names (the Playwright reporter in `PW_TEST_REPORTER`) to be in
the table and outside the skip trees.

Every root `package.json` script a `ci.yml` job runs, directly or through
another script, is a planner input, read from `ci.yml` (`jobScripts` in the
workspace graph): one only the site jobs run selects the site build, any other
every app. `test/ci-required-jobs.test.mjs` runs twice per run, in `app-plan`
(`pnpm check:integration`) and in `workspace-contracts` (`pnpm
test:contracts`). It fails when a required job is missing, carries
`continue-on-error`, runs under another condition or waits for other jobs than
it pins, or has a run step that can be skipped other than the nine it lists,
and when either guard step is missing, conditional or soft. It also fails when
a required job needs a job that can be skipped on a run where the required job
is due: it simulates every trigger of `ci.yml` (each event, pull request
action and draft state, dispatch scope and branch) with every value of the
outputs the job and the jobs it waits for read. A job whose condition admits a
skipped dependency with a status function (`!cancelled()`, `always()`) may
need one; a condition the simulation cannot evaluate fails it.
The five site checks and `processing-workflows` are required and state that
they are due when the site was built (`needs.composite-site.result ==
'success'`), which GitHub's implicit `success()` already demanded; a dispatch
with `scope=affected` and no site in its plan skips them with the build.
`example-cache-retention` may fail by design and is not required. A change
that removes both guards is caught only by review and by the full plan it
triggers: a change to the plan job or to a root script `ci.yml` runs selects
every app.

Package suites can be narrowed safely only from recorded evidence of what each
suite reads at run time, not from scanning text for paths. The wall time of
the package tests can be cut without any selection risk by running them in
parallel shards.

Text references widen the selection: a JavaScript comment line naming a path
is skipped, any other mention counts, and a path built at run time
(`join(root, 'apps', id)`) reaches every app. The changed paths are read
NUL-delimited (`changedPathsFromGit`), so git neither quotes nor trims a name,
and hold both sides of every rename and copy, so a moved input still selects
what read it. A diff git cannot produce is never an empty one: the plan then
tests every app, the site build and the easter egg, and the workflow gate runs
its workflow.

Replayed over 22 merged pull requests, #864, #872 and the 20 merged up to
#887 (`scripts/app-plan-shadow.mjs`, the planner before and after the review
fixes against the same oracle), the planner had 0 app misses before and after.
The fixes cost 35 instead of 31 of 1,386 app-test jobs: #872 and #861 now test
dicompare and Pipeline builder, whose desktop scripts read every catalogue key.
Under the skip list a pull request skips the easter egg in 7 of the 22 (#883,
#875, #871, #869, #867, #865, #855); the others change `.github/`, a root file,
`test/`, `scripts/`, `registry/`, `site/`, `.changeset/` or a `package.json`.
The second replay, of the planner before and after the skip list, selected the
same apps with 0 misses. The oracle has no expectation of
its own for site keys or `ci.yml` jobs, and the report lists the 4 rows
narrowed through them (#864, #872, #861, #854); an independent oracle for both
is a follow-up. Replayed over every `ci` run of 16 to 18 November (each pull
request diffed from main as it stood when its run started, each push from its
parent), the planner leaves out 2,288 minutes of per-app jobs (2,304 before the
fixes, the #864 and #872 runs). The easter egg used 437 minutes in those runs,
376 in 93 pull request runs and 62 in 12 pushes; the skip list leaves it out
of 19 of the pull request runs, 79 minutes. 57 of the 74 pull request runs that
still run it changed `.github/`, most of them this CI work itself.

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
runs on main, nightly, or manual dispatch. A draft runs no GPU job; a ready
pull request runs its directly selected GPU apps.

A manual `ci` run plans like a pull request: `gh workflow run ci --ref
<branch>` tests the apps the branch changed since it left main (on main,
since the last finished run, as a push does). `-f scope=gpu` runs only the macOS GPU suite of
those apps, `-f scope=site` only the composite site, its agentic checks (with
`agentic_mode`) and the homepage easter egg, and `-f scope=all` every app. Like a pull request,
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
retested in full only by the next nightly. The agentic jobs only the nightly
or a dispatch runs (`agent-interactions`, `processing-workflows`) are not
carried: the nightly runs the interactions again. PR pushes cancel earlier runs
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
