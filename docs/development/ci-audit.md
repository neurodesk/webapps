# CI coverage and runtime audit

Audit date: 2026-10-15. Timings below describe individual GitHub runs, not a
benchmark of the changes in this branch. Runner load, selected apps, caches and
test data affect comparisons.

## Observations

- Of the eight scheduled `ci` runs from October 8 through October 15, four were
  cancelled and four failed. The concurrency group shared by scheduled runs and
  pushes allowed pushes to interrupt nightly coverage.
- [October 14 nightly](https://github.com/neurodesk/webapps/actions/runs/38507042570)
  ran for about 110 minutes. Its composite job spent 84 minutes 53 seconds on
  agent interactions before starting the interface audit, upload workflows and
  mobile checks. SynthSeg's hardware GPU job failed. This is evidence to retain
  GPU checks, not to defer them because they are assumed reliable.
- [October 15 PR run](https://github.com/neurodesk/webapps/actions/runs/38774528547)
  spent 3,422 test seconds in SynthSeg's CPU browser suite. Default segmentation
  took 1,208 seconds, fast segmentation 602, the coarser grid 912 and automation
  retaining the requested grid 615. These are distinct scientific paths; all
  four must remain in the PR tier.
- [October 15 main run](https://github.com/neurodesk/webapps/actions/runs/38790156792)
  took about 11 minutes without selecting app matrices. The homepage job took
  about 5.5 minutes and the composite interface audit about four minutes.
- CI builds each browser app before its suite, but many Playwright server
  commands built it again. The prebuilt flag was respected by the example
  smoke driver but not by these commands.

## Coverage ownership

| Coverage | Owner | Reason to retain |
| --- | --- | --- |
| Repository contracts | `ci / workspace-contracts`, `test:contracts` | Discovers every root `*.test.mjs`, except the built runtime and homepage tests assigned below. |
| Shared package unit tests | `ci / workspace-contracts`, `test:packages` | Runs shared scientific and infrastructure package tests even when app selection is narrow. |
| Native tract conversion and WASM parity | `ci / workspace-contracts` | Native binary must exist before package parity tests; otherwise comparisons can skip. |
| Correctness lint | `quality / correctness` | Central typed and JavaScript correctness rules. |
| Workspace syntax/type tasks | `ci / workspace-contracts` | Preserves workspace checks not replaced by central lint. |
| Dependency and unused-code analysis | `quality / dependencies` and `quality / unused-code` | Their analyses are distinct from root tests of the tools. |
| Mutation checks | `quality / mutation` | PR smoke plus the complete scheduled/manual mutation run. |
| App unit tests and builds | `ci / app-tests` | Affected-app matrix and conservative dependency fallback. |
| Scientific browser tests | `ci / browser-e2e` and `browser-e2e-gpu` | Pinned data, output parity, CPU and real GPU behavior. Broad PRs defer the GPU matrix to main/nightly under the existing policy. |
| Built runtime assembly | `ci / composite-site` | Requires the assembled production site. Source-only runtime contract tests belong to root contracts. |
| Production browser, automation, interface, upload and mobile checks | `ci / composite-site` | Different checks of the deployed layout and workflows; retain all. |
| Agent interactions | Scheduled/manual CI | External model calls are separate from deterministic browser coverage. |
| Homepage game and leaderboard | `ci / homepage-easter-egg` | Nested packages and homepage integration have independent tests. |
| Committed N4 WebAssembly rebuild | `n4-wasm-source` | A Docker ITK-Wasm build with an 8 GB limit, so weekly and manual only; `dwi-native` tests the committed module on each change. |
| Native portability and release parity | Native workflows and reusable portable workflow | Different OS/runtime and packaged artifacts; not duplicates of browser unit tests. |
| Offline desktop | `standalone` and `standalone-catalog` | Offline provisioning, platform packaging and desktop behavior. |
| Deployed service and download links | Deployment and `standalone-links` | Live integration failures can occur without a source change. |

Repeated checks against a separately built release or deployed artifact are
intentional. A matching command name alone is not enough to remove a check.
Correctness lint also runs in scheduled/manual `ci`, where the independent
PR/push quality workflow does not run automatically.

## Scheduled failure reports

`workflow-reports.yml` runs at 00:47, 06:47, 12:47 and 18:47 UTC and on
manual dispatch (`scripts/report-workflow-failures.mjs`). It keeps no cursor.
Each tick asks the Actions API for the runs created in the last 14 days that
a report can concern, whatever their latest conclusion: scheduled runs on the
default branch, and every run of each notarizing workflow but pull request runs,
listed by workflow file so that no event is missed (a release, a dispatch on a
tag, an event only an older ref declares). It reads every attempt of each run,
the earlier ones from the attempts endpoint when a run was rerun, and reports
each completed attempt that has no report marker in the issues yet
(`scripts/lib/workflow-reports.mjs`). The API can qualify a run's workflow path
with a ref (`.github/workflows/ci.yml@main`); every attempt is compared by its
path without the ref (`workflowPath`). The markers are
the only state, so a failed, cancelled, overlapping or late tick and a rerun
lose nothing, and a repeated tick writes nothing. The reporter's own failed
scheduled ticks are reported like any other scheduled workflow, so a broken
reporter is noticed once a tick succeeds again. A report arrives up to six
hours after the attempt finishes.

What a tick does not report: an attempt of a run created more than 14 days
before the tick, which is a rerun of an older run (GitHub allows reruns for
30 days) or a failure missed by a reporter outage longer than 14 days; and an
attempt that completed before `CUTOVER`, which the `workflow_run` reporters
this one replaced handled with the same markers (see the handoff below). In the 30 days to
18 November 2026, every rerun of a scheduled or notarizing run started within
43 hours of its run. The lookback is 14 days and not 30 because an attempt
without a marker is read again on every tick: the failed notarizing attempts
without a notarization failure (148 in those 30 days, 34 with a failed macOS
job whose log is downloaded again) and the passing scheduled attempts of the
workflows with a job that continues on error (`ci.yml` and `deploy-pages.yml`,
whose passing run can contain a failed job).
Measured on 18 November 2026 with every attempt of the lookback past the
cutover, which is the steady state, a dry-run tick listed 11,060 runs, read
2,086 attempts, re-read 141 attempts without a marker and made 402 HTTP
requests in 10 minutes; the job's limit is 30. Most of the listing is the
notarizing workflows' pull request runs (8,906 of the 10,143 they had in those
14 days), read only to be left out, so fewer native workflow runs per pull
request make a tick cheaper. A 30-day lookback would about double the cost.

Every scheduled run on the default branch is checked; no workflow list is
kept. The reporter opens one bot-authored issue per failing workflow,
comments on new run attempts and reopens the issue if a later run fails.
An attempt is reported once, whichever issue of the workflow holds its
marker, so an overlapping or repeated tick writes nothing. A report reopens a
closed issue only when the issue was closed before that report; an issue closed
after its report stays closed. Successful runs do not close issues; this avoids
a delayed success hiding a newer failure.

Reports include failed steps, bounded log excerpts, artifact links, the commit
and a rerun command. Cancelled nightlies report incomplete coverage. Superseded
Pages deployments are excluded unless they also have a failed job. The reporter
checks out trusted default-branch code and never downloads or executes artifacts.
It shares the approval report's GitHub client, which retries a read after a
dropped connection or a gateway error
([CI approval reporting](../quality/ci-approval-reporting.md)) and lists jobs
in pages of 30; writes are not retried. A report that fails does not stop the
others, and the tick then fails so the next one checks that run again.

For read-only verification, set `GH_TOKEN` or `GITHUB_TOKEN` and
`GITHUB_REPOSITORY`, then run
`node scripts/report-workflow-failures.mjs --dry-run --since <ISO time> --until <ISO time>`.
`--since` replaces the cutover and `--until` the tick time. It reads the issues
and prints, for each attempt that completed in that range, whether it would
open an issue, comment on one, or was already reported, and how many HTTP
requests the tick made. A dry run writes nothing, not even the step summary.

### Handoff from the workflow_run reporters

`CUTOVER` (`2026-11-18T13:00:00Z`) splits the attempts by when they completed
(`updated_at`), not by when their run started: an attempt that completed at or
after it and has no marker is reported by the first tick, whatever the old
reporters did with it; one that completed before it is left to them. The
`workflow_run` reporters keep reporting until the merge with the same markers,
and a `workflow_run` workflow starts runs only from the default branch, so none
starts after the merge. `CUTOVER` had passed before the pull request left
draft, so every merge comes after it. To hand over:

1. Before merging, wait until this lists nothing, so that no attempt completed
   before `CUTOVER` is still waiting for an old reporter:

   ```sh
   for workflow in nightly-failures.yml notarization-alert.yml; do
     for status in queued pending waiting in_progress; do
       gh run list --repo neurodesk/webapps --workflow "$workflow" --status "$status"
     done
   done
   ```

2. Merge outside the 30 minutes before a scheduled tick (00:47, 06:47, 12:47
   and 18:47 UTC), so that step 3 ends before the schedule's first tick.
3. After the merge, wait until the command of step 1 lists nothing again.
   A run that broke because the merge removed its script left its attempt
   without a marker; the first tick reports it. Cancel a run that stays queued
   (`gh run cancel <id> --repo neurodesk/webapps`) for the same reason.
4. Dispatch the first tick:
   `gh workflow run workflow-reports.yml --repo neurodesk/webapps --ref main`.

The old and the new reporter then never write at the same time, and every
report the old ones made carries a marker the first tick reads.

## Apple notarization alerts

The same tick checks the failed and timed-out attempts of every workflow that
notarizes macOS packages, of any event on any branch or tag, release dispatches
included, but not pull requests. The workflows are derived from the workflow files
(`workflowFacts`: a file that mentions notarization, `APPLE_ID` or
calls `node-cli-portable.yml`, reusable workflows excluded). When a failed
macOS job log shows Apple refusing a notarization (an expired agreement or
bad credentials from the notary service, HTTP 401 or 403, or a submission whose
status is Invalid or Rejected), it opens the issue "Apple notarization is
failing" assigned to the account owner, or comments on it, reopens it and
assigns the owner again, once per run attempt. Ticks never overlap; two
alert issues opened anyway merge into the oldest. It reads up to 64 MiB of each failed macOS job's log and warns when a log was
longer. A Developer ID certificate or keychain failure before notarization is
not detected. A failed attempt is alerted even when a rerun passed before the
next tick. Close the issue
after renewing the agreement and rerunning the failed jobs.

## Boundaries

Existing `@slow` tags identify repeated coverage, not permission to remove unique
methods, options or geometries. The full tier must remain available on nightly,
manual and release runs. Sharding must preserve the union of test identities and
keep each test in exactly one shard.

The existing slow declarations were checked against the retained browser cases:

| App | Retained completed scientific path |
| --- | --- |
| brain-extraction | BET mask parity and real MindGrab CPU/SynthStrip mask parity in `app.spec.js`. |
| ants | The 1 mm SyN example and template-grid alignment in `smoke.spec.js`. |
| elastix | Rigid, affine and B-spline example registrations in `smoke.spec.js`. |
| syncro | Pinned T1 normalization with WASM SynthSR in `quality.spec.js`. |
| spinalcordtoolbox | Cord segmentation remains covered; repeated runs checking editing and parked results remain in the full tier. |

The slow cases also make additional reference or interaction assertions. Those
assertions are deferred to nightly/manual/release runs, not deleted. Routine main
pushes now use the same tier as PRs. No new slow tags were added.

SynthSeg sharding is unchanged. Its expensive cases share a spec and validation
report; merely increasing the shard count does not distribute those cases safely.

Local browser invocations must still build their inputs. A prebuilt CI invocation
must use a build with the same model-asset configuration as the test server.

The homepage job remains conservative until its nested package and homepage
dependencies can be scoped without missing imported registry, analytics or shell
changes. No claim of complete scientific coverage follows from this workflow
audit; existing reference tests and data-gate contracts remain the evidence for
the scientific paths they exercise.

## Validation after rollout

Compare completed runs with the same selected apps and tiers. Report both elapsed
time and summed runner time: sharding can lower elapsed time while increasing
setup cost. Check that nightly runs finish despite main pushes and that a failed
scheduled run produces one issue with failed jobs, steps and diagnostic links.
The `workflow_run` reporter becomes active only after its workflow exists on the
default branch; unit tests cannot prove live token permissions or delivery.
