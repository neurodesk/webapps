# Mutation testing

Run `pnpm quality:mutations` after `pnpm install --frozen-lockfile --ignore-scripts`.
Stryker mutates the modules listed in `scripts/lib/mutation-modules.mjs`. Each
entry names the source (or a line range of it), the files its suite needs in the
sandbox, and the `node --test` command that specifies it. The adapter runs
Stryker once per module, selecting it with `MUTATION_MODULE` in
`stryker.config.mjs`, so each mutant runs only its own suite. Without the
variable the config selects the smoke canary's module, so Knip and a bare
`stryker run` can load it. None of the suites
needs model files, native binaries, WASM execution, a GPU, a browser or the
network.

| Module | What a wrong result breaks | Suite |
| --- | --- | --- |
| `packages/nii2tvx/src/disconnectome.js` | Disconnectome table names and grid refusals shared by the app and command line | `packages/nii2tvx/test/disconnectome.test.js` |
| `packages/lcmodel/src/basis-select.js` | Which LCModel basis set the app preselects, which ones it marks unusable, and the advice it shows; a mismatched basis biases concentrations | `packages/lcmodel/test/basis-select.test.js` |
| `packages/nii2tvx/src/index.js:24-35` (`formatG`) | The browser TSV must equal the native `printf("%g")` output byte for byte | the `printf("%g")` tests in `packages/nii2tvx/test/parity.test.js` |
| `scripts/lib/app-versions.mjs:44-73` (`releaseDate`, `validateReleaseDate`, `nextVersion`) | The `MAJOR.MINOR.YYYYMMDD` version `pnpm release`, `pnpm new-app` and the daily desktop stamp write; a wrong result publishes a downgrade or an impossible date | `test/date-versions.test.mjs` |
| `scripts/lib/lockfile-impact.mjs` | Which workspace importers a `pnpm-lock.yaml` change affects, and so which apps CI tests; a missed importer skips the tests that would catch a broken dependency | `test/lockfile-impact.test.mjs` |
| `packages/carotid-flow/src/series.js` | The frames, grid and header Carotid Flow measures, and which amplitude and phase pairs it refuses; the app and the `carotid-flow` command line both read through it | `packages/carotid-flow/test/series-outputs.test.js` |
| `packages/carotid-flow/src/outputs.js` | The names and bytes of Carotid Flow's downloads and the command line's files, and the measurements automation reports | `packages/carotid-flow/test/series-outputs.test.js` |

`formatG` is mutated by line range because the rest of `index.js` drives the
WebAssembly module. Its command selects the two `printf` tests by name; the rest
of `parity.test.js` needs a native build and is not part of this run. The
date-version range likewise leaves out the rest of `app-versions.mjs`, which
plans releases with Changesets on a workspace; `test/app-versions.test.mjs`
keeps covering that part. The two Carotid Flow modules share one suite of small
in-memory NIfTI files. `packages/carotid-flow/test/node.test.js` runs the command
line on the phantom and is not part of this run. `test/mutation-quality.test.mjs`
fails when a range no longer covers exactly its functions or the name pattern
selects other tests.

Stryker is pinned to `@stryker-mutator/core@10.0.0`. The current
[runner configuration](https://stryker-mutator.io/docs/stryker-js/configuration/#testrunner-string)
supports arbitrary test commands. The official plugin list and published package
schema do not provide a native node:test runner, so the command runner runs the
suites with `node --test` and `coverageAnalysis: 'off'`. It cannot map tests to
files, which is why each module is a separate run: in one shared run every
mutant would execute every suite, and the slower runs could turn into false
timeouts. The runner reports a suite as one test and cannot distinguish
uncovered mutations from mutations that survive assertions.

Only the module's listed files are copied into Stryker's sandbox. Concurrency is two.
The sandbox stays inside the checkout at `.stryker-tmp` and is cleaned even on
failure. Node test fixtures use the host's `TMPDIR` storage volume locally and
the runner temporary directory in CI. The reporting adapter clears the inherited
`NODE_TEST_CONTEXT` marker so nested node:test suites execute independently.

## CI and failures

The independent `mutation-quality` workflow runs every module weekly and on
manual dispatch. Pull requests run `pnpm quality:mutations:smoke`, which mutates
only the `tableName` function (`smoke` in the configuration). Its requirement to
kill at least one mutant proves that instrumentation reaches the Node tests. It
is not a mutation-score threshold.

Both modes write a GitHub summary with one row per module and upload
`quality-artifacts/mutations`: `<module>/mutation.json` and `<module>/index.html`
for each run, `summary.md`, and `stryker.log` with every run's output. Surviving mutations and scores are report-only. The summary
lists survivors for review. Invalid configuration, failing baseline tests,
scanner crashes, runner runtime errors, missing reports, a report whose modules
differ from the configuration, and a module with no assessed mutants fail the
job. The first failing module stops the run. The adapter removes previous reports before running so a failed scan cannot
reuse an old score.

The repository tests exercise real Stryker configuration and baseline failures,
crash handling, report validation and the distinction between a surviving mutation
and a broken smoke canary. No exception is swallowed to keep the workflow green.

## Runtime budget

Measured locally on 2026-10-15 (two workers, `Done in` from each module's log):

| Run | Mutants | Baseline suite | Stryker time |
| --- | --- | --- | --- |
| `disconnectome.js` | 10 | 0.13 s | 1 s |
| `basis-select.js` | 284 | 0.16 s | 26 s |
| `formatG` | 48 | 0.14 s | 4 s |
| date versions | 73 | 0.86 s | 23 s |
| `lockfile-impact.mjs` | 146 | 0.23 s | 60 s |
| Full run, five Stryker runs | 561 | - | 122 s wall |
| Carotid Flow `series.js` (2026-10-16) | 39 | 0.23 s | 9 s |
| Carotid Flow `outputs.js` (2026-10-16) | 42 | 0.23 s | 14 s |
| Full run, seven Stryker runs (2026-10-16, loaded host) | 642 | - | 221 s wall |
| PR smoke (`tableName`) | 2 | 0.13 s | 6 s wall |

On 2026-10-16 the two Carotid Flow modules added 39 and 42 mutants, each with a
0.23 s baseline: `series.js` took 9 s and `outputs.js` 14 s. The full run of
seven modules, 642 mutants, took 221 s wall on a host with a load average of 22
on 8 cores, where the five earlier modules alone took 179 s.

The full run took about 4 s with the canary alone and 96 s with three modules.
Most of `lockfile-impact.mjs`'s time is its seven timeouts: each is a mutant that
loops forever and is stopped after Stryker's timeout. The workflow's 10-minute
timeout leaves room for slower hosted runners. Keep the full run under five
minutes locally; add a module only with its own completed run and a measured
cost.

## Results and reviewed survivors

The 2026-10-17 root-quality ownership change adds 17 lockfile-analyzer mutants.
The targeted run assesses 163, with 146 killed, 7 timed out and 10 survivors.
It completes in 64 seconds on this host. These are one-run execution counts,
not a performance comparison. The new tests caught missing validation of a
root-only tool snapshot and incorrect handling of empty or absent root importers.
The eight earlier survivors below remain. The two additional survivors are
equivalent for pnpm-written lockfiles:

- A default excluded-tool list containing `"Stryker was here"` matches no npm
  package name, because spaces are invalid in a package name.
- Running the root-tool normalization with an empty excluded-tool list only
  removes an empty `devDependencies` mapping. pnpm omits that empty mapping;
  all actual roots and their closures remain identical.

The pilot on 2026-10-10 killed all 10 mutants in `disconnectome.js`.

The full run on 2026-10-16 detected 620 of 642 mutants (613 killed, 7 timed
out), with 22 survivors and no compile or runtime errors:

| Module | Killed | Timed out | Survived |
| --- | --- | --- | --- |
| `disconnectome.js` | 10 | 0 | 0 |
| `basis-select.js` | 274 | 0 | 10 |
| `formatG` | 45 | 0 | 3 |
| date versions | 73 | 0 | 0 |
| `lockfile-impact.mjs` | 131 | 7 | 8 |
| Carotid Flow `series.js` | 38 | 0 | 1 |
| Carotid Flow `outputs.js` | 42 | 0 | 0 |

`basis-select.js` has grown 10 mutants since 2026-10-14; all 10 are killed.
The timeouts are real detections: each mutant (dropping the cycle guard, the
`while` body or the loop's exit in the link propagation) loops forever.

The first run of `basis-select.js` left 134 of 274 mutants alive: the suite
never exercised related sequence families, unrecorded parameters, the field and
echo-time tiers, the notes users read or most header-parsing rules. The first run
of `formatG` left 14 of 48: infinities, negative values and six-digit exponents
were untested. The first run of the date-version functions left 13 of 73: no test
gave an unknown bump, an invalid date to `nextVersion`, a same-day patch, a
minor or major bump with an earlier date, a multi-digit series or a version with
a prefix or suffix, and none read the format message. The first run of
`lockfile-impact.mjs`, with only the linked-importer test that `app-plan.test.mjs`
had called directly, left 72 of 146: the planner tests reached it only through
the whole workspace graph, so none of them could run in its sandbox.
`test/lockfile-impact.test.mjs` now checks transitive, removed, republished,
peer-suffixed, optional, dev, aliased and cyclic dependencies, the summary of
more than five packages, added, removed and edited importers, multi-hop links,
an order-independent report and every error that sends the planner to the full
catalog. Neither Carotid Flow module was in the run before 2026-10-16. A one-off
run against the command-line suite alone detected 33 of 39 `series.js` mutants
and 18 of 42 `outputs.js` mutants: that suite names every input `neck.nii` and
never checks an upper-case, doubled or missing extension, the per-side masks,
the measurements, the spacing tolerance, the frame-count refusal or the error
text. Behavioral tests now cover these. The survivors that remain do not
change a result the app, the pipeline, the command line or the CI planner exposes:

Equivalent mutants:

- `basis-select.js:27` `if (!name)` to `false`: `String(null)`, `String(undefined)`
  and `""` match no sequence family either.
- `basis-select.js:51` and `:55`, `>=` to `>` at the 20 % and 5 % field limits:
  for a ratio near 1 the mismatch `|q - 1|` is a multiple of 2^-53, and the
  doubles nearest 0.2 and 0.05 are not, so the mismatch never equals either limit.
- `basis-select.js:140` reading the whole text instead of its first 64 KiB: a
  `.BASIS` file's header namelists precede its spectra, so the first match is the
  same. The limit only bounds the regular-expression scan.
- `formatG` line 26, `x === 0` to `false`: zero then takes the fixed branch and
  still prints `0`.
- `formatG` line 27, `x > 0` to `x >= 0`: only reached for infinite `x`.
- `formatG` line 32, `/^[-+]/` to `/[-+]/`: the exponent string has a sign only
  at its start.
- `lockfile-impact.mjs:46`, `/\(.*$/` to `/\(.*/`: a snapshot key has no line
  break, so `.*` already reaches its end.
- `lockfile-impact.mjs:59` and `:83`, an extra `"Stryker was here"` entry in the
  pending or link list: no snapshot and no importer has that name, so it adds
  nothing to a closure and links nothing.
- `lockfile-impact.mjs:76`, `snapshots[key]?.[field]` to `snapshots[key][field]`:
  `snapshotOf` returns only keys present in `snapshots`, and pnpm writes every
  snapshot as a mapping.
- Carotid Flow `series.js:31`, `<= 1e-5` to `< 1e-5` in the spacing check:
  both spacings are float32 values read from the headers, and the double nearest
  `1e-5` has its lowest set bit at 2^-69. Their difference can equal it only if
  one spacing has a float32 ulp of 2^-69 or less, that is, a spacing below 2^-45
  mm (about 3e-14 mm), which no scanner writes.
- `lockfile-impact.mjs:87`, treating every version as a `link:`: the path
  formed from the rest of a registry version (`'1.0.0'.slice(5)` is empty, so the
  importer links itself) never names another importer.

Unspecified input:

- `lockfile-impact.mjs:72` and `:86`, `entry?.version` to `entry.version`, and
  `:86` `?? ''` to `?? "Stryker was here!"`: pnpm writes every importer entry with
  a `version`. The fallbacks only decide whether an entry without one is skipped
  or throws a `TypeError`, which fails the plan job loudly; no rule specifies
  either for a lockfile pnpm does not write.

Score changes without a specified ranking. These are not equivalent, but no
documented rule decides the order they change, so a test would pin an
implementation weight rather than a requirement:

- `basis-select.js:53` and `:76`, `score -= 100` to `+=`, and `:80` `dataSeq === null`
  to `true` or `!==` for sequence-known data: they reorder only unusable sets,
  which always follow every usable set and are labelled unusable in the menu.
- `basis-select.js:80` `dataSeq === null` to `false` or `!==` for data of unknown
  sequence, and `:89` `score -= 10` to `+=`: they move a difference basis by 40
  or 20 points against unedited sets for the same data. The difference basis
  stays usable, warned and below any unedited set that matches field and echo
  time, which the suite checks.

This score applies only to these modules and these mutation operators. It does
not measure scientific accuracy, native/browser parity or the rest of either
package. Keep the independent scientific references and golden-output tests
unchanged. Review future survivors for equivalent behavior before changing
tests, and add a test only when the surviving change represents a relevant
incorrect result. Expand scope one fast, deterministic module at a time, with
its own completed run.
