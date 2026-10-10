# Mutation-testing pilot

Run `pnpm quality:mutations` after `pnpm install --frozen-lockfile --ignore-scripts`.
The pilot mutates only `packages/nii2tvx/src/disconnectome.js`. Its four helpers
name lesion results and classify grid errors for the browser and command line.
They do not process images. The dedicated `disconnectome.test.js` suite requires
no model files, native binaries, WASM builds or browser.

Stryker is pinned to `@stryker-mutator/core@10.0.0`. The current
[runner configuration](https://stryker-mutator.io/docs/stryker-js/configuration/#testrunner-string)
supports arbitrary test commands. The official plugin list and published package
schema do not provide a native node:test runner. This pilot uses the command
runner with `node --test` and `coverageAnalysis: 'off'`. Each mutant runs the
whole isolated suite. The command runner reports that suite as one test and
cannot distinguish uncovered mutations from mutations that survive assertions.

Only four small files are copied into Stryker's sandbox. Concurrency is two.
The sandbox stays inside the checkout at `.stryker-tmp` and is cleaned even on
failure. Node test fixtures use the host's `TMPDIR` storage volume locally and
the runner temporary directory in CI. The reporting adapter clears the inherited
`NODE_TEST_CONTEXT` marker so nested node:test suites execute independently.

## CI and failures

The independent `mutation-quality` workflow runs the full pilot weekly and on
manual dispatch. Pull requests run `pnpm quality:mutations:smoke`, which mutates
only the `tableName` function. Its requirement to kill at least one mutant proves
that instrumentation reaches the Node tests. It is not a mutation-score threshold.

Both modes write a GitHub summary and upload `quality-artifacts/mutations` with
`mutation.json`, `index.html`, `summary.md` and `stryker.log`. Surviving mutations
and scores are report-only. The summary lists survivors for review. Invalid
configuration, failing baseline tests, scanner crashes, runner runtime errors,
missing reports and runs with no assessed mutants fail the job. The adapter
removes previous reports before running so a failed scan cannot reuse an old score.

The repository tests exercise real Stryker configuration and baseline failures,
crash handling, report validation and the distinction between a surviving mutation
and a broken smoke canary. No exception is swallowed to keep the workflow green.

## Initial result and limits

The completed full pilot on 2026-10-10 killed all 10 generated mutants, with no
survivors, timeouts or errors. Stryker completed it in about two seconds locally.
The PR smoke killed both generated mutants in `tableName`. No surviving-mutant
follow-up is needed for this initial scope.

This score applies only to this helper and these mutation operators. It does not
measure scientific accuracy, native/browser parity or the rest of the package.
Keep the independent scientific references and golden-output tests unchanged.
Future survivors should be reviewed for equivalent behavior before changing tests.
Add a test only when the surviving change represents a relevant incorrect result.
Expand scope one fast, deterministic module at a time, with its own completed run.
