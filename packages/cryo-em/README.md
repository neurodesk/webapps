# @neurodesk/cryo-em

The job specification of the compute server's `relion` tool
([ADR-0004](../../docs/adr/0004-hpc-batch-compute-for-cryo-em.md)): which RELION
5.1.1 commands exist, what each accepts, and the command line each runs. The
command line equals what RELION's own GUI writes to `note.txt` for the same
settings.

Three consumers share it:

- the cryo-EM app, to build and check specs before sending them;
- the Node reference server (`test-utils/compute-reference-server.mjs`), which
  imports `src/spec.js`;
- the Rust server (`exes/compute-server`), which loads `src/commands.json` with
  `include_str!` and interprets it the same way. Its tests read
  `test/fixtures/argv-cases.json` and must produce the same commands byte for
  byte, and `test/fixtures/validation-cases.json`, whose specs it must accept
  and normalise, or refuse with the same message, as `validateRelionSpec` does.

## API (`src/spec.js`)

| Export | Purpose |
| --- | --- |
| `validateRelionSpec(spec, { parts, profile })` | Checks a spec and fills in defaults. `parts` are the received multipart names; `profile` (`{ cpus, gpus }`), when given, must be able to run the command. Throws an `Error` naming the first problem (`invalid-spec`). |
| `relionCommand(validated, { directory, profile, inputPaths })` | `{ program, args, mpiRanks, threads, gpus, then }` for job directory `directory` (`Class2D/job006`). |
| `relionLaunch(command, profile)` | `{ mpiRanks, threads, gpus }`; throws when the profile cannot run the command. A server checks each profile against its default commands at startup. |
| `relionOutputs(validated)` | Files the job writes, relative to its directory, with `required`. |
| `parseRelionLogLine(validated, line)` | `{ level, progress }`: `info`, `warning` or `error`, and `[fraction, stage]` or `null`. |
| `resolveInputPaths(validated, directory)` | Input paths inside the container. |
| `typedNumber(value)` | A `number` option as typed into the GUI. |
| `relionNumber(value)` | RELION's `floatToString`, for values the GUI computes. |
| `RELION_COMMANDS`, `jobTypeDirectory(command)`, `RELION_DEFINITION` | The command ids, their job directory types, and the parsed table. |

The server runs `program args`, under `mpirun --bind-to none -np <mpiRanks>`
when `mpiRanks` is above 1, then each `then` entry in order, and stops at the
first non-zero exit. The working directory is the project (`/project`).
`import` runs `ln -sfn` first and `relion_import` as its `then` step (see
below); `initialmodel` has three `then` steps (the GUI's `rm`,
`relion_align_symmetry` and `touch`); `select` with several runs of classes
has more.

## The command table (`src/commands.json`)

JSON has no comments, so `$schema-notes` gives a summary and this section is
the full schema. Each `commands.<id>` has:

- `jobType`: the RELION job directory type (`Class2D`).
- `launch`:
  - `rule: "single"`: one process.
  - `rule: "cpuRanks"`: `max(1, floor(cpus / threadsPerRank))` ranks.
  - `rule: "refineRanks"`: the smallest odd number of ranks that is at least
    `max(3, gpus + 1)`. A profile with fewer CPUs than ranks is refused.
  - `threads`: when true, `--j` is `floor(cpus / ranks)`, at least 1. Otherwise 1.
  - `gpu`: when true, `gpus` is the profile's GPU count, and `{ "gpus": true }`
    conditions hold when it is above 0. Otherwise 0.
- `inputs.<name>`:
  - `accept`: any of `path` (a project-relative file of an earlier job,
    `<Type>/jobNNN/<file>`), `part` (`{ "part": "<name>" }`, an uploaded MRC
    stored as `<Type>/jobNNN/<name>.mrc`), `dataRoot` (`{ root, path,
    pattern }`, resolved to `/data/<root>/<path>/<pattern>`) and `dataFile`
    (`{ root, path }`, one regular file in a data root, resolved to
    `/data/<root>/<path>`).
  - `from`: job types a path may come from. `suffix`: the path's required
    ending. `pattern`: a regular expression the path must contain.
  - `optional`, and `when`: the input applies only when the condition holds.
    Given while it does not apply is an error.
- `options.<name>`:
  - `gui`: the RELION job option variable (`run.job`), for the reference runs.
  - `type`: `bool`, `int`, `number`, `enum`, `string` (with `pattern`) or
    `int-list` (`minItems`, `maxItems`, unique items).
  - `default` (the GUI's `initialise*Job()` default) or `required: true`.
  - `min`, `max` (inclusive), `multipleOf`, `enum`.
  - `when`: as for inputs. Its condition may only read options without `when`.
- `rules`: `{ when, error }`; the spec is refused with `error` when `when` holds.
- `derived.<name>`: a value computed from options, written by `{derived:<name>}`:
  - `multiply`: `floatToString(float(option) * by)`.
  - `enumIndex`: the option's index in its `enum`, in decimal.
  - `powerSpectrumGrouping`: `ROUND(float(dose) / float(dosePerFrame))`, 1 when
    that is 0 (MotionCorr's `--grouping_for_ps`).
  - `extractBackgroundRadius`: Extract's `--bg_radius`. The diameter, or
    `0.75 * size` when it is negative, halved, scaled by `rescale / size`
    when `doRescale`, truncated to an integer.
- `steps`: `steps[0]` runs first (the main program, except for `import`'s
  link); later steps run after it.
  - `program`, `args`, `when`. `mpi: true` appends `_mpi` when there is more
    than one rank, and is required on the first step of an MPI launch.
  - `builder: "selectClasses"`: see [Class selection](#class-selection).
- `outputs`: `{ path, required, when }`, relative to the job directory.
- `progress`: `null`, or a `kind` and `stage` (see [Log lines](#log-lines)).

`constants` holds fixed values: the container's CTFFIND executable, the optics
group name and RELION's Topaz executable name.

### Arguments

An argument is a string or a group. A group `{ "when": C, "args": [...],
"else": [...] }` emits `args` when `C` holds, otherwise `else` (if present).
Groups nest. Strings expand:

| Placeholder | Value |
| --- | --- |
| `{dir}` | The job directory with a trailing slash (`Class2D/job006/`), as RELION's `outputname` |
| `{input:NAME}` | The input's path |
| `{inputDir:NAME}`, `{inputPattern:NAME}` | A `dataRoot` input's directory, `/data/<root>/<path>` (`/data/<root>` when the path is empty), and its pattern |
| `{option:NAME}` | The option's value: `number` as typed (see Numbers), `int` in decimal, `enum` and `string` as given |
| `{option:NAME:03}` | An `int` option zero-padded to three digits (more when larger) |
| `{derived:NAME}` | A derived value |
| `{threads}` | `--j` |
| `{const:NAME}` | A constant |

An argument that is the empty string stays an empty argument (`--gpu ""`).

Conditions:

| Condition | Holds when |
| --- | --- |
| `{ "option": N, "eq": v }`, `ne`, `gt`, `ge`, `lt`, `le` | The option compares so with `v` |
| `{ "option": N, "in": [...] }`, `notIn` | The option is (not) in the list |
| `{ "input": N, "present": true }` | The input was given (`false`: not given) |
| `{ "gpus": true }` | The launch has GPUs (`false`: none) |
| `{ "all": [...] }`, `{ "not": C }` | All hold; `C` does not |

### Numbers

The GUI passes a typed option to the program as the text the user typed
(`joboptions[...].getString()`), so a `number` option is written as typed:
the shortest decimal that reads back as the same double, without an exponent
(`0.8851234`, `60`, `0.0000001`), negative zero as `0`. `typedNumber` does
this; the Rust port must match it (Rust's `{}` for `f64` gives the same text
except `-0` for negative zero).

Values the GUI computes (`--psi_step`, `--offset_step`, `--bg_radius`) go
through `floatToString`: printf `%.6g` of the `float` value (`0.666`,
`2.46914`, `1.23457e+06`), computed in `float` and `double` as
`pipeline_jobs.cpp` does. Like printf, it rounds the exact binary value with
ties to even (`123456.5` is `123456`). Negative zero is written as `0`.
`relionNumber` reproduces this. Integers are written in decimal.

## Argv parity

`test/gui-cases.js` lists, per case, the lines RELION 5.1.1 writes to
`note.txt` for those settings, spacing included. `note.txt` has no MPI
launcher: RELION adds `mpirun -n N` only to the line it executes. The tests
compare each line as the words a shell gives for it: whitespace separates,
double quotes group, `""` is an empty word, and `` `which relion_x` `` is
`relion_x`. Every RELION program gets `--pipeline_control <dir>/`, as the
GUI's `prepareFinalCommand` adds it. `validation/pipeliner-parity.mjs` checks
the lines against RELION itself (see Validation against RELION).

Where this differs from the GUI by design:

- `import` first runs `ln -sfn /data/<root>/<path> <dir>data` and then
  `relion_import --i "<dir>data/<pattern>"`. `relion_import` itself refuses
  an absolute `--i` ("Please import files by a relative path", import.cpp)
  and RELION asks for a symbolic link inside the project, which a GUI user
  makes by hand. The link lives in the job directory, so the movie names in
  `movies.star` are `<dir>data/<file>`, and later jobs read them through it
  because every job mounts the data roots at the same `/data/<root>`. The
  parity check leaves the `ln` line out.
- `select` with `mode: "classes"` has no GUI command (see below).
- Only the options in the table exist. Continuation, helical processing,
  template and Topaz picking, re-extraction, MTF files, scratch directories,
  and the GUI's "Additional arguments" are not offered.
- Acquisition values with a placeholder GUI default are required:
  `import.angpix`, `kV`, `Cs` and `motioncorr.dosePerFrame`.
- Ranges (`min`, `max`) are this package's. The GUI's slider limits are only
  hints and RELION accepts typed values beyond them.

### Resources

- `motioncorr` (RELION's own implementation, CPU): ranks of 4 threads,
  `max(1, floor(cpus / 4))` ranks with `--j floor(cpus / ranks)`.
- `ctffind`, `autopick` (LoG) and `extract` take no `--j` in the GUI: one rank
  per CPU.
- `refine3d`: as above, with `--gpu ""` on GPU profiles, so RELION spreads the
  followers over the visible devices.
- `class2d` (VDAM) and `initialmodel`: one process, `--j` all CPUs,
  `--gpu ""` on GPU profiles.
- `maskcreate`: one process, `--j` all CPUs. `import`, `select` and
  `postprocess`: one process.

### Class selection

RELION's GUI selects classes interactively in `relion_display`. For
`mode: "classes"` the classes are grouped into runs of consecutive numbers.
One run is one `relion_star_handler --select rlnClassNumber --minval a --maxval
b` call writing `particles.star`. Several runs write
`classes_<aaa>_<bbb>.star` each, and `relion_star_handler --combine` joins them
into `particles.star`. Particles keep their order within a run, and runs follow
in ascending class order. Only the last call has `--pipeline_control`, so the
success marker appears only when `particles.star` is complete. This mode writes
no `class_averages.star`.

`mode: "ranker"` is the GUI's automatic selection, `relion_class_ranker`
with `--auto_select --min_score`. The container's `relion_python_classranker`
finds RELION's Python environment, so no `--python` is passed, as in the GUI.

## Log lines

- Level: `error` when the line contains the word `ERROR`, `warning` for
  `WARNING` or `Warning`, otherwise `info`.
- `bar` (preprocessing): RELION's progress bar
  (`  3/ 10 sec ......~~(,_,">`) has `floor(60 * done / total)` dots, so the
  fraction is dots / 60. A line can hold several `\r`-separated updates; the
  last counts.
- `iterations` (`class2d`, `initialmodel`): `Gradient optimisation iteration N
  of M` gives `(N - 1) / M`.
- `autoRefine` (`refine3d`): auto-refinement prints no total.
  `Auto-refine: Iteration= N` gives the estimate `min(0.9, N / 25)`, and
  `Refinement has converged` gives 0.9.
- `import`, `select`, `maskcreate` and `postprocess` report no progress.

## Validation against RELION

Both scripts need Docker and the `relion` image (RELION 5.1.1 with
CTFFIND 4.1.14, from the neurocontainers `relion` recipe).

### Arguments: `validation/pipeliner-parity.mjs`

ADR-0004's argument gate, run without the GUI:

```sh
node packages/cryo-em/validation/pipeliner-parity.mjs --image relion:5.1.1
```

For every case in `test/gui-cases.js` except `select` in `classes` mode, it
makes a fresh project whose job counter gives the case's `jobNNN`, adds the job
with `relion_pipeliner --addJobFromStar` and `--addJobOptions` (inputs, every
option through its `gui` variable, `nr_mpi`, `nr_threads`, `use_gpu` and
`gpu_ids` from the case's profile) and runs it with `--RunJobs`. RELION then
writes `note.txt` as the GUI does (`PipeLine::runJob`). The RELION programs and
`mpirun` on `PATH` are stubs that only write the success marker. It fails
unless RELION's words equal `relionCommand()` and its text equals the case's
`gui` lines, printing a word diff. `--addJobFromStar` makes a new job, as the
GUI's Run! does; `--addJob` would mark MotionCorr, CtfFind, AutoPick and
Extract as continuations (`--only_do_unfinished`).

It also adds each command once without options and checks RELION's defaults,
read back from `job.star`, against the table's `default`s.

`validation/relion-gui.mjs` holds what the table does not: each job type's
label, the input variables, the GUI settings the package fixes (LoG picking,
VDAM, the class ranker) and the gain rotation and flip texts. `--case <text>`
runs matching cases, `--cases <module>` checks another module's `GUI_CASES`,
`--notes <file>` writes RELION's lines as JSON and `--keep` keeps the
projects.

### Plumbing: `validation/container-chain.mjs`

Runs the generated commands for a whole chain (import, motioncorr with the
gain as a data-root file, ctffind, LoG autopick, extract, class2d, select by
the class ranker and again by class number, initialmodel, refine3d,
maskcreate, postprocess) in the container on the CPU, as the compute server
runs them: one container per step, the project at `/project` as the working
directory, the tutorial at `/data/examples/relion-tutorial` read-only, and
`mpirun --bind-to none -np N` for MPI steps. After each job it checks
`RELION_JOB_EXIT_SUCCESS` and every required output of `relionOutputs()`.
Selecting the ranker's classes by number must give the ranker's particles.
Settings are reduced (9 movies, 64 px particles, fewer classes and
mini-batches); Refine3D runs to convergence. It is not ADR-0004's GPU
reconstruction gate. `validation/cpu-chain-report.md` records a run.

```sh
node packages/cryo-em/validation/container-chain.mjs \
  --movies <dir holding the tutorial's Movies/> --project <empty dir> --record run.json
```

## Regenerating the fixture

```sh
pnpm --filter @neurodesk/cryo-em fixture
pnpm --filter @neurodesk/cryo-em test
```

Run it after changing `src/commands.json`, `src/spec.js`,
`test/gui-cases.js` or `scripts/write-validation-fixture.mjs`; the tests fail
while a fixture is stale. Each `argv-cases.json` entry holds the spec, the
received parts, the profile, the directory and the expected `relionCommand`
result. `validation-cases.json` holds `cases` (spec, parts, optional profile,
and either the normalised `validated` spec or the `error` message) and
`numbers` (`[value, relionNumber(value)]`).
