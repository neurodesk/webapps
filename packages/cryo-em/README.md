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
  `test/fixtures/argv-cases.json` and must produce the same commands byte for byte.

## API (`src/spec.js`)

| Export | Purpose |
| --- | --- |
| `validateRelionSpec(spec, { parts, profile })` | Checks a spec and fills in defaults. `parts` are the received multipart names; `profile` (`{ cpus, gpus }`), when given, must be able to run the command. Throws an `Error` naming the first problem (`invalid-spec`). |
| `relionCommand(validated, { directory, profile, inputPaths })` | `{ program, args, mpiRanks, threads, gpus, then }` for job directory `directory` (`Class2D/job006`). |
| `relionLaunch(command, profile)` | `{ mpiRanks, threads, gpus }`; throws when the profile cannot run the command. A server checks each profile against its default commands at startup. |
| `relionOutputs(validated)` | Files the job writes, relative to its directory, with `required`. |
| `parseRelionLogLine(validated, line)` | `{ level, progress }`: `info`, `warning` or `error`, and `[fraction, stage]` or `null`. |
| `resolveInputPaths(validated, directory)` | Input paths inside the container. |
| `relionNumber(value)` | RELION's `floatToString`. |
| `RELION_COMMANDS`, `jobTypeDirectory(command)`, `RELION_DEFINITION` | The command ids, their job directory types, and the parsed table. |

The server runs `program args`, under `mpirun --bind-to none -np <mpiRanks>`
when `mpiRanks` is above 1, then each `then` entry in order, and stops at the
first non-zero exit. The working directory is the project (`/project`).
`initialmodel` has three `then` steps (the GUI's `rm`, `relion_align_symmetry`
and `touch`); `select` with several runs of classes has more.

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
- `steps`: `steps[0]` is the main program; later steps run after it.
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
| `{option:NAME}` | The option's value: `number` as `floatToString`, `int` in decimal, `enum` and `string` as given |
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

RELION writes job option values as `floatToString` produces them: printf
`%.6g` of the `float` value (`0.885`, `-1`, `50000`, `1.23457e+06`). Values
the GUI derives (`--psi_step`, `--offset_step`) are computed in `float` and
`double` as `pipeline_jobs.cpp` does. Integers are written in decimal.
Negative zero is written as `0`. `relionNumber` reproduces this; the Rust
port must match it on every case in the fixture.

## Argv parity

The tests hold each command to a hand-derived GUI command:
`test/gui-cases.js` lists, per case, the lines `getCommands*Job()` in RELION
5.1.1's `src/pipeline_jobs.cpp` writes to `note.txt` for those settings,
spacing included, with `mpirun -n N` removed. A line is compared as the words
a shell gives for it: whitespace separates, double quotes group, `""` is an
empty word, and `` `which relion_x` `` is `relion_x`. Every RELION program gets
`--pipeline_control <dir>/`, as the GUI's `prepareFinalCommand` adds it.

ADR-0004's argument gate records the real `note.txt` from the GUI in the
container, with the same settings and profile, and compares it the same way
after normalising `jobNNN`.

Where this differs from the GUI by design:

- `import` reads `--i /data/<root>/<path>/<pattern>`. The GUI refuses absolute
  paths and wants a symbolic link inside the project; data roots are mounted at
  the same absolute path in every job instead.
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

## Regenerating the fixture

```sh
pnpm --filter @neurodesk/cryo-em fixture
pnpm --filter @neurodesk/cryo-em test
```

Run it after changing `src/commands.json`, `src/spec.js` or
`test/gui-cases.js`; the tests fail while the fixture is stale. Each fixture
entry holds the spec, the received parts, the profile, the directory and the
expected `relionCommand` result.
