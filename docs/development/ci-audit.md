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
| Correctness lint | `code-quality` | Central typed and JavaScript correctness rules. |
| Workspace syntax/type tasks | `ci / workspace-contracts` | Preserves workspace checks not replaced by central lint. |
| Dependency and unused-code analysis | Dedicated quality workflows | Their analyses are distinct from root tests of the tools. |
| Mutation checks | `mutation-quality` | PR smoke plus the complete scheduled/manual mutation run. |
| App unit tests and builds | `ci / app-tests` | Affected-app matrix and conservative dependency fallback. |
| Scientific browser tests | `ci / browser-e2e` and `browser-e2e-gpu` | Pinned data, output parity, CPU and real GPU behavior. Broad PRs defer the GPU matrix to main/nightly under the existing policy. |
| Built runtime assembly | `ci / composite-site` | Requires the assembled production site. Source-only runtime contract tests belong to root contracts. |
| Production browser, automation, interface, upload and mobile checks | `ci / composite-site` | Different checks of the deployed layout and workflows; retain all. |
| Agent interactions | Scheduled/manual CI | External model calls are separate from deterministic browser coverage. |
| Homepage game and leaderboard | `ci / homepage-easter-egg` | Nested packages and homepage integration have independent tests. |
| Native portability and release parity | Native workflows and reusable portable workflow | Different OS/runtime and packaged artifacts; not duplicates of browser unit tests. |
| Offline desktop | `standalone` and `standalone-catalog` | Offline provisioning, platform packaging and desktop behavior. |
| Deployed service and download links | Deployment and `standalone-links` | Live integration failures can occur without a source change. |

Repeated checks against a separately built release or deployed artifact are
intentional. A matching command name alone is not enough to remove a check.
Correctness lint also runs in scheduled/manual `ci`, where the independent
PR/push quality workflow does not run automatically.

## Scheduled failure reports

`nightly-failures.yml` observes completed scheduled workflows on the default
branch. It opens one bot-authored issue per failing workflow, comments on new
run attempts and reopens the issue if a later run fails. Reprocessing the same
attempt does not add a duplicate comment. Successful runs do not close issues;
this avoids a delayed success hiding a newer failure.

Reports include failed steps, bounded log excerpts, artifact links, the commit
and a rerun command. Cancelled nightlies report incomplete coverage. Superseded
Pages deployments are excluded unless they also have a failed job. The reporter
checks out trusted default-branch code and never downloads or executes artifacts.
Skipped reports for PR/push completions cannot replace a pending nightly report.

For read-only verification, set `GH_TOKEN` or `GITHUB_TOKEN` and
`GITHUB_REPOSITORY`, then run
`node scripts/report-nightly-failure.mjs --run-id RUN_ID --dry-run`.
This renders a report without creating or changing an issue.

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
