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
| `scripts/lib/workspace-graph.mjs` | Which directories and root files each app and CI job reaches, and so which apps a change tests; a missed reference skips the tests that would catch the change | `test/workspace-graph.test.mjs` |
| `packages/lcmodel/src/tissue.js` | LCModel's tissue- and alpha-corrected concentrations, the relaxation times behind them, when the correction applies, and its two downloads; the app and the `lcmodel` command line both use it | `packages/lcmodel/test/tissue.test.js` |
| `packages/lcmodel/src/lcmodel-io.js:1-321` (all but `fillGaps`) | The control file every LCModel fit runs with, and how the app reads LCModel's .COORD and .TABLE files back: the concentrations, QC summary, curves, diagnostics and stop messages users see and download | `packages/lcmodel/test/lcmodel-io.test.js` |
| `packages/lcmodel/src/voxel.js` | Which T1 voxels the spectroscopy voxel covers and the GM, WM and CSF fractions behind every tissue-corrected concentration | `packages/lcmodel/test/voxel.test.js`, without its three large-grid tests |

`formatG` is mutated by line range because the rest of `index.js` drives the
WebAssembly module. Its command selects the two `printf` tests by name; the rest
of `parity.test.js` needs a native build and is not part of this run. The
date-version range likewise leaves out the rest of `app-versions.mjs`, which
plans releases with Changesets on a workspace; `test/app-versions.test.mjs`
keeps covering that part. `fillGaps`, the last function in `lcmodel-io.js`, stays outside its range:
instrumenting its Fourier sums made each run of the suite take 4.4 s instead of
0.25 s, about 20 minutes for the module. `test/mutation-quality.test.mjs` fails
when the range stops ending at `presentRows` or another function follows it.
The voxel suite skips its oblique-volume tests on a 64³ grid and on twelve
poses on a 40³ grid, and its grid-orientation test
(`--test-skip-pattern=oblique --test-skip-pattern=oriented`).
Instrumented, they make every run take seconds, and the module took 175 s on
the hosted runner. A rotated box on a small rotated grid covers the same code:
it must match a direct count, sub-point for sub-point, voxel by voxel.
`test/mutation-quality.test.mjs` fails when the patterns skip any other test.
The two Carotid Flow modules share one suite of small
in-memory NIfTI files. `packages/carotid-flow/test/node.test.js` runs the command
line on the phantom and is not part of this run. The workspace graph's suite
builds small fixture trees for path rules and comment parsing; `test/app-plan.test.mjs`
reads the whole repository and stays out of the run.
`test/mutation-quality.test.mjs`
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
the runner temporary directory in CI. Each Stryker run gets its own directory
there as `TMPDIR`, removed when the run ends: Stryker kills a timed-out suite
before its cleanup hooks run, and the workspace graph's fixture trees would
otherwise stay behind. The reporting adapter clears the inherited
`NODE_TEST_CONTEXT` marker so nested node:test suites execute independently.

## CI and failures

The `mutation` job of the independent `quality` workflow runs every module
weekly and on manual dispatch. Pull requests run `pnpm quality:mutations:smoke`, which mutates
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
| `workspace-graph.mjs` (2026-10-17, hosted runner) | 371 | 0.6 s | 84 s |
| Full run, eight Stryker runs (2026-10-17, hosted runner) | 1013 | - | 179 s step |
| LCModel `tissue.js` (2026-10-22) | 427 | 0.14 s | 32 s |
| Full run, nine Stryker runs (2026-10-22, hosted runner) | 1511 | - | 335 s step |
| LCModel `lcmodel-io.js:1-321` (2026-10-22) | 506 | 0.25 s | 75 s locally, 51 s hosted |
| Full run, ten Stryker runs (2026-10-22, hosted runner) | 2017 | - | 268 s step |
| LCModel `voxel.js` (2026-10-22, initial) | 502 | 0.25 s instrumented | 80-91 s locally, 113 s hosted |
| LCModel `voxel.js` boundary weights (2026-10-22, local) | 500 | 2.067 s instrumented | 409 s |
| Full run, eleven Stryker runs (2026-10-22, hosted runner) | 2519 | - | 523 s step |
| PR smoke (`tableName`) | 2 | 0.13 s | 6 s wall |

On 2026-10-16 the two Carotid Flow modules added 39 and 42 mutants, each with a
0.23 s baseline: `series.js` took 9 s and `outputs.js` 14 s. The full run of
seven modules, 642 mutants, took 221 s wall on a host with a load average of 22
on 8 cores, where the five earlier modules alone took 179 s.

On 2026-10-22 the hosted runner took 335 s for the nine modules, 31 s of it
for `tissue.js`. The workspace graph, now 393 mutants with the comment fixtures,
took 182 s of that, up from 84 s on 2026-10-17. The then-current 10-minute job
timeout left about four minutes.

On 2026-10-17 the workspace graph added 371 mutants. Its suite writes a fixture
tree of about 150 files, two of them 1 MiB, for every mutant. On the hosted
runner it took 84 s, including eight timeouts that loop forever, and the full
run of eight modules took 179 s. Locally the module took 2.5 to 4 minutes on a
host with a load average of 15 to 25 on 8 cores; measure on an idle host.

The full run took about 4 s with the canary alone and 96 s with three modules.
Most of `lockfile-impact.mjs`'s time is its seven timeouts: each is a mutant that
loops forever and is stopped after Stryker's timeout. The hosted full run varies
by about a minute between runs, mostly in the workspace graph (116 to 182 s on
2026-10-22). With ten modules it took 268 to about 410 s. With `voxel.js` the
eleven modules took 523 s on 2026-10-22, with the workspace graph at 178 s; the
whole job took 560 s, including setup. That left only 40 s under the old
10-minute limit, less than the observed variation.

The workflow now allows 20 minutes. New modules still need a hosted full-run
measurement with room for setup and runner variation. If the full run approaches
that limit, split it across jobs before adding more modules. Pull requests run
only the mutation-detection canary; the full run remains scheduled or manual.

## Results and reviewed survivors

On 2026-10-22 the MRS voxel geometry, `packages/lcmodel/src/voxel.js`, joined
the run with 502 mutants. Its tests moved from `apps/lcmodel/test` into the
package so that Stryker's sandbox runs them against the mutated file. The
data-gated Osprey mask comparison stays in the app. The first run killed 336,
6 timed out and 160 survived. The only inverse checked was a permutation
matrix, which leaves most cofactor terms at zero. No box was rotated except in
the skipped test. No box hung over the image edge, the volume was never read on
a non-1 mm grid, and nothing checked overlapping maps, map values outside the
box or the no-tissue refusal. The suite now:

- inverts a dense 4x4 matrix from both sides
- checks a sheared, mirrored box's nominal volume
- compares a rotated box on a rotated 2 mm grid, voxel by voxel, with a direct
  count of sub-points mapped into the box
- covers boxes hanging over three edges, overlapping maps, NaN outside the box
  and both refusals
- checks that a box whose faces pass through voxel centres gives each face
  layer half its weight, and that axis-aligned boxes keep their exact volume
  with faces on voxel boundaries, on centres and between them, including
  sample-aligned quarter-voxel offsets, mirrored/permuted grids and joint rotations
- checks symmetric face, edge and corner tie weights, inverse-affine roundoff
  on either side of a face and geometric perturbations beyond the tolerance

The first version of this suite pinned the old default of five samples, whose
middle sub-point lay on such faces and gave a face layer 3/5 of its weight: a
20 mm box measured 20.2 mm a side. #550 changed the default to six, an even
count that avoids centre-plane sub-points. Review found that changing the count
alone moves the bias to other offsets: a 4 mm box shifted by a quarter voxel
measured 72.33796 mm³ instead of 64 mm³. Boundary points now contribute symmetric
quadrature weights of 1/2 per face axis, or 1/4 on edges and 1/8 on corners.
A 1e-10 tolerance in normalized box coordinates absorbs affine roundoff, at most
1e-8 mm for a 100 mm box. Other oblique and nonintegral geometry retains ordinary
finite-sampling error; these weights do not compute exact polyhedral intersections.

The original six-sample run killed 483 mutants and timed out on 6 loops that
never end. It left 13 survivors, including three untested inclusive-face tie
mutations. The symmetric boundary rule and its regressions supersede that run.
The final run killed 482 of 500 mutants, timed out on 6 loops that never end,
and left 12 survivors, with no uncovered mutants or errors. It used two workers
and took 409 seconds locally on 2026-10-22, with a 2.067-second instrumented
baseline and no concurrent heavy validation. Rerun with
`MUTATION_MODULE=lcmodel-voxel pnpm exec stryker run stryker.config.mjs`.
The repeated translated and transformed cases use compact grids while retaining
the exact 4 mm quarter-voxel regression and every boundary/transform condition.
The same three large-grid tests remain excluded from the mutation command.

Ten survivors are equivalent for the supported inputs; two numerical boundaries
remain coverage gaps:

- `voxel.js:21`, `new Array(16)` to `new Array()`: all 16 entries are assigned.
- `:39`, `< 1e-12` to `<= 1e-12`: at a determinant of exactly 1e-12 the
  original returns an inverse and the mutant throws. This retained
  near-singular boundary is not tested.
- `:56`, not cutting rows to four columns: NIfTI affine rows have four.
- `:75`, `<= FACE_ROUNDOFF` to `< FACE_ROUNDOFF`: the suite checks exact
  faces, roundoff on both sides and points beyond the band, but does not pin
  equality at the numerical band limit. Retained without an equivalence claim.
- `:76`, `distance < 0` to `distance <= 0`: the face-band branch already
  returns one half when the distance is zero.
- `:95` (three), starting the upper bound at positive infinity, and `:98`,
  taking a fourth corner coordinate: these only expand the scan bounds, and
  clamping to the image still visits every covered voxel.
- `:154`, the default `unlabelled` option as `""`: any value other than
  `exclude` counts the unlabelled remainder as CSF.
- `:159`, reading one weight past the end: it is `undefined` and skipped.
- `:172`, `all > w` to `all >= w`: when the maps add up exactly to the box,
  the scale is 1 either way.

On 2026-10-22 LCModel's control file and output parsing joined the run with 506
mutants. The suite fitted nothing new, but it only matched a few control lines
and read two real .COORD files that never exercise LCModel's edge formats. The
first run killed 301, 1 timed out and 204 survived. Untested parts included:
- every line of the control file
- the refusals and the TE and title rules
- the metabolite curves
- the diagnostic table
- negative shifts, three-digit phases and four-digit S/N, where LCModel's
  Fortran fields leave no blank
- cut files
- the gap threshold
- `parseTable`'s count field
- the CSV quoting
- `lcmodelError`
- the exact diagnostic explanations

The suite now holds two whole control files and a synthetic .COORD written in
`finout.rs`'s formats. It kills 473, and 2 time out, each a gap-scan loop that
never ends. Rerun with `MUTATION_MODULE=lcmodel-io pnpm exec stryker run
stryker.config.mjs`. All 31 survivors are equivalent for the files LCModel
writes:

- `lcmodel-io.js:145`, reading a line untrimmed or splitting on single blanks:
  the empty tokens either produces are skipped.
- `:157`, `:194`, `:198`, `:200`, `:202`, `:210` and `:254`, dropping a `^`
  anchor: each pattern can match the line's leading blanks, so the leftmost
  match already starts at the line start; `$$CONC` only starts a line.
- `:157`, one blank before the metabolite name; `:210`, one blank before a
  curve's name; `:290`, one blank between a diagnostic's level and routine: the
  formats write exactly one there (`1X, A6` for curves, `(I4, 1X, A9, 1X, A6,
  I3)` in ERRTBL, and one blank between ratio and name in the table).
- `:172`, `:173` and `:256`, other fallback values for a missing header or
  count: they yield the same `null` or `0`.
- `:175`, the three table-bound mutants (start one line early, read one line
  past the count, or read to the end): the line before the rows is the column
  header and every later line lacks a finite number followed by an `N%` column.
- `:198`, a one-digit misc-table count: the misc table has six lines.
- `:226`, one extra (NaN) step in the gap scan: on a uniform axis with a few
  gaps the median spacing does not move.
- `:237`, joining misc lines without a newline: no summary pattern spans two
  lines, and every number ends at a blank or a letter.
- `:243` to `:247`, single blanks in the summary patterns: F5591, F5593 and
  F5595 fix those blanks, and the F6.3 FWHM field leaves one below 10 ppm.
- `:278`, two optional-chaining removals: the chain has already short-circuited
  on a missing table, and `split` always returns a first element.
- `:299`, an unanchored `info` test: no other ERRTBL level contains "info".

On 2026-10-22 LCModel's tissue correction joined the run with 427 mutants. Its
suite already compared the corrected values with Osprey's `quantTiss` and
`quantAlpha` run in Octave, but only for the twelve metabolites it fitted. The
first run killed 252 and left 175 alive: most relaxation-table entries, the
LCModel name aliases, the field-strength limits, the zero-sum and timing
refusals, every reason `correctionFor` gives, the CSV columns and quoting, and
both downloads. The suite now holds every entry of both tables to Osprey's
`lookUpRelaxTimes`, copied verbatim, and covers the rest by behavior. That
initial expanded suite killed 425; no mutant timed out. Rerun with `MUTATION_MODULE=lcmodel-tissue pnpm exec
stryker run stryker.config.mjs`. The initial two survivors:

- `tissue.js:197`, `x == null` to `false` in the CSV number format: for `null`
  and `undefined`, `!Number.isFinite(x)` is already true, so the cell stays
  empty. Equivalent.
- `tissue.js:160`, `wconc * attmet` to `wconc / attmet`: the original suite
  used only ATTMET = 1. Writing the tests exposed the inverted attenuation
  factors in the implementation ([#545](https://github.com/neurodesk/webapps/issues/545)).

The #545 correction adds independent ATTH2O, ATTMET and WCONC scaling checks
for both tissue and alpha concentrations. It also corrects the pure-white-matter
expectation and uses the fitted MEGA-PRESS ATTH2O of 0.43. A second run on
2026-10-22 killed 427 of 428 mutants, with no timeouts or uncovered mutants.
The only survivor is the redundant null check described above. The ATTMET
mutation is now killed; it was a coverage gap in the exported correction
function, not an equivalent mutation across its supported inputs.

The 2026-10-20 workspace-graph comment fixtures cover whole-line comments,
preserved directives, block/JSDoc and inline comments, comment-looking string
and template lines, and parser-rejected source. Paired JavaScript/TypeScript
and top-level-await cases keep parsing sensitive to the filename and module
mode. A comment between `from` and a bare workspace specifier must leave
whitespace, not text that hides the import.

The module-only run on main assessed 393 mutants: 351 killed, 8 timed out and
34 survived. With the fixtures it kills 368, with the same 8 timeouts and 17
survivors (95.67% detected). Neither run has uncovered mutants or compile or
runtime errors. Comment parsing previously had coverage only in
`test/app-plan.test.mjs`, outside this module's sandbox. Production graph
behavior, CI selection and scientific gates are unchanged. Rerun with
`MUTATION_MODULE=workspace-graph pnpm exec stryker run
stryker.config.mjs`.

The three remaining comment-parsing mutants are equivalent:

- `workspace-graph.mjs:44`, dropping `$` from `LINE_COMMENT`: the greedy `.*`
  already ends at the line terminator or end of the input.
- `workspace-graph.mjs:79`, removing the `Line` filter or making it always true:
  the extra block-comment ranges start at `/*`, never at the `//` offset checked
  by the replacement callback.

The other 14 workspace-graph survivors are the previously reviewed cases below.

The 2026-10-17 package-metadata correction assesses 195 lockfile-analyzer mutants,
with 178 killed, 7 timed out and 10 survivors. No mutants are uncovered or have
compile or runtime errors. Rerun with `MUTATION_MODULE=lockfile-impact pnpm exec
stryker run stryker.config.mjs`.
The earlier root-quality ownership change assessed 163 mutants, with 146 killed,
7 timed out and 10 survivors. The current tests also cover required package
metadata on both original sides, removed root tools and transitives, peer-qualified
snapshots, malformed resolution mappings and absent top-level sections.
The eight earlier survivors below and the two root-tool survivors remain;
no new survivor remains from the metadata validation:

- `lockfile-impact.mjs:108`: a default excluded-tool list containing
  `"Stryker was here"` matches no npm package name, because spaces are invalid
  in a package name.
- `lockfile-impact.mjs:116`: running the root-tool normalization with an empty
  excluded-tool list only removes an empty `devDependencies` mapping. pnpm
  omits that empty mapping; all actual roots and their closures remain
  identical.

The pilot on 2026-10-10 killed all 10 mutants in `disconnectome.js`.

The full run on 2026-10-17 detected 977 of 1013 mutants (962 killed, 15 timed
out), with 36 survivors and no compile or runtime errors:

| Module | Killed | Timed out | Survived |
| --- | --- | --- | --- |
| `disconnectome.js` | 10 | 0 | 0 |
| `basis-select.js` | 274 | 0 | 10 |
| `formatG` | 45 | 0 | 3 |
| date versions | 73 | 0 | 0 |
| `lockfile-impact.mjs` | 131 | 7 | 8 |
| Carotid Flow `series.js` | 38 | 0 | 1 |
| Carotid Flow `outputs.js` | 42 | 0 | 0 |
| `workspace-graph.mjs` | 349 | 8 | 14 |

`basis-select.js` has grown 10 mutants since 2026-10-14; all 10 are killed.
The timeouts are real detections: each mutant (dropping the cycle guard, the
`while` body or the loop's exit in the link propagation) loops forever. So do the
workspace graph's eight: each drops the guard or the bookkeeping that stops the
`pnpm` script expansion, the root-file walk or `reachableFrom` from revisiting a
node, or makes every node name the same path.

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
text. The workspace graph had no suite the sandbox could run: its only tests
loaded the whole repository through `app-plan.test.mjs`. The first fixture tree
left 51 of 371 mutants alive. It had no file in `.turbo`, `.vite`,
`test-results` or `playwright-report`, no `.yml`, no `file:` dependency whose
path the text rules could not also find, no workspace devDependency or `exes`
package, no unscoped or spaced bare import, no `.mjs` file named inside a
package, no glob with text between its directory and `*`, no cycle between root
files, no empty `ci.yml` and no CI command in the split `'registry', 'x.json'`
form. Behavioral tests now cover these. The survivors that remain do not
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
- `lockfile-impact.mjs:55`, `/\(.*$/` to `/\(.*/`: a snapshot key has no line
  break, so `.*` already reaches its end.
- `lockfile-impact.mjs:73` and `:97`, an extra `"Stryker was here"` entry in the
  pending or link list: no snapshot and no importer has that name, so it adds
  nothing to a closure and links nothing.
- `lockfile-impact.mjs:90`, `snapshots[key]?.[field]` to `snapshots[key][field]`:
  `snapshotOf` returns only keys present in `snapshots`, and pnpm writes every
  snapshot as a mapping.
- Carotid Flow `series.js:31`, `<= 1e-5` to `< 1e-5` in the spacing check:
  both spacings are float32 values read from the headers, and the double nearest
  `1e-5` has its lowest set bit at 2^-69. Their difference can equal it only if
  one spacing has a float32 ulp of 2^-69 or less, that is, a spacing below 2^-45
  mm (about 3e-14 mm), which no scanner writes.
- `workspace-graph.mjs:24` and `:31`, `(?:\.\.\/)+` to `(?:\.\.\/)`: the
  patterns are not anchored, so the last `../` before `packages/` still matches.
- `workspace-graph.mjs:48` and `:49`, `'(catalog)'` or `'(site)'` to `''`: the
  names only key the two CI entry nodes. No changed path is empty, and the two
  names stay distinct.
- `workspace-graph.mjs:85`, dropping `.sort()` after `readdir`: on Linux and
  macOS libuv sorts directory entries by name, so the order is already sorted.
  CI plans on Linux.
- `workspace-graph.mjs:99`, `() => false` to `() => undefined`, `:105`, `return
  null` to no return, and `:104` and `:156`, `'utf8'` to `''`: `undefined` is as
  falsy as `false`, every caller reads the manifest with `?.`, and
  `JSON.parse` reads a `Buffer` as its UTF-8 text.
- `workspace-graph.mjs:132`, resolving every dependency spec as a path
  (`startsWith('file:')` to `true` or to `startsWith('')`): a version range,
  `workspace:`, `npm:`, repository or URL spec without its first five characters
  resolves inside the dependent's own directory, which `nodeOf` maps to the node
  itself, removed later, or to an app, which is never followed. An `http:` URL
  becomes an absolute path outside the repository, which maps to no node.
- `workspace-graph.mjs:162` and `:163`, a step without `run` or a filtered
  `pnpm --filter` command read as `"Stryker was here!"`, and the filter pattern
  stopping one character into the script name: none of these strings names a
  root file or starts with `pnpm `, and workspace script names hold only word
  characters, `:` and `-`, so the rest of the name cannot name a root file
  either.
- `lockfile-impact.mjs:101`, treating every version as a `link:`: the path
  formed from the rest of a registry version (`'1.0.0'.slice(5)` is empty, so the
  importer links itself) never names another importer.

Unspecified input:

- `lockfile-impact.mjs:86` and `:100`, `entry?.version` to `entry.version`, and
  `:100` `?? ''` to `?? "Stryker was here!"`: pnpm writes every importer entry with
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
