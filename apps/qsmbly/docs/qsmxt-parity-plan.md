# Running QSMxT's pipeline in the browser: the qsmbly parity plan

Status: agreed 2026-10-14. This document is the brief for the sessions that carry it out. Each
work item below is sized to be one PR (or a short series) and says which repository owns it.

## 1. Goal

Make qsmbly the best browser QSM tool it can be: intuitive, as feature-complete as the browser
allows, and reproducible against QSMxT. A qsmbly run must be something QSMxT can reproduce from
the command qsmbly prints, and the guarantee must come from **sharing code**, not from keeping two
implementations in step by hand.

Both upstream projects may change to make this possible:

- **QSM.rs** (`qsm-core`) owns algorithms and the per-stage pipeline functions. Breaking its API
  is fine; downstream catches up.
- **QSMxT** owns how stages are linked (which run, on what inputs, with which checks), the
  configuration, command and methods text, and the CLI/TUI. It must not implement algorithms.
- **qsmbly** owns the browser: UI, file loading, the viewer, model download and caching.

Every issue and PR filed for this work names its owner (QSM.rs, QSMxT or qsmbly).

## 2. Where things stand (QSM.rs v0.39.0, QSMxT v10.0.0, qsmbly main `d2afebc`)

### 2.1 It does not build

qsmbly pins `qsm-core` v0.38.0 (plus a patch from `stebo85/QSM.rs` for RS2-Net) and
`qsmxt-config` v9.22.0. Pinning `qsm-core` v0.39.0 and `qsmxt-config` v10.0.0 and dropping the
patch gives 24 compile errors in `rust-wasm/src/lib.rs`, in 14 functions:

| lib.rs function | Cause in the new API |
|---|---|
| `laplacian_unwrap_wasm` | `laplacian_unwrap` takes a 4th argument (solver) |
| `vsharp_params_from_radii` | `VsharpParams` gained `deconvolve` and `grid` |
| `ilsqr_wasm_with_progress` | `IlsqrParams` gained `pad_mm` |
| `tgv_qsm_wasm_with_progress` | TGV takes `TgvInput::{FieldPpm, WrappedPhase{..}}`; `te`/`fieldstrength` left `TgvParams`; returns `Result` |
| `harperella_wasm_with_progress`, `iharperella_wasm_with_progress` | `HarperellaInput`; return `Result` |
| `hd_bet_wasm` | `HdBetParams { inference: FullVolume \| SlidingWindow{patch, tile_step}, mirror_tta }` |
| `apply_mask_ops_wasm` | `to_mask_sections` takes the BET config |
| `bet_wasm_with_progress` | `BetParams.voxel_scale` |
| `calculate_swi_wasm` | CLEAR-SWI: `calculate_swi(phases, mags, tes, mask, grid, params) -> Result<SwiResult>` |
| `r2star_arlo_wasm`, `r2_epg_wasm`, `r2prime_wasm` | return `Result` (`r2prime` takes a 4th argument) |
| `get_mcpc3ds_defaults` | `qsmxt_config::Mcpc3dsConfig` was removed |

37 of the 75 functions `lib.rs` exports are no longer called from JS (they predate the move to
config-driven stages in #142), so several of these errors are in dead code.

The probe used to find these: worktree `/scratch/user/uqaste15/src/qsmbly-probe-v10` (Bunya),
error log `/scratch/user/uqaste15/src/qsmbly-probe-v10-check.log`.

### 2.2 The automated bump cannot work

`bump-qsmxt-config.yml` (triggered by QSMxT releases) moves only the `qsmxt-config` tag. With the
`[patch]` still in place, QSMxT v10's config crate would be compiled against the patched v0.38.0
`qsm-core`. PR #146 is that bump; its CI never ran (the run is waiting at "action required",
because the PR was opened by the workflow's token). The patch is obsolete anyway: RS2-Net shipped
in QSM.rs v0.39.0 (QSM.rs #131), which settles #143.

### 2.3 A runtime blocker in QSM.rs

`qsm_core::inversion::ilsqr` calls `ilsqr_traced`, which calls `std::time::Instant::now()` for
every stage and around every FFT (`FftClock::time`, `src/inversion/ilsqr.rs`). On
`wasm32-unknown-unknown` that compiles but panics ("time not implemented on this platform"). iLSQR
is QSMxT's default inversion and QSMART's inner solve, so both would crash in the browser. It is
the only such call outside test code in v0.39.0.

### 2.4 The same settings give different results

| | QSMxT v10 default | qsmbly today |
|---|---|---|
| Dipole inversion | iLSQR | RTS |
| V-SHARP | no deconvolution, radii 12→1 mm, native grid | deconvolution, radii from voxel size (18→2 mm at 1 mm) |
| Brain mask | phase-quality → Otsu → dilate 1, fill holes, erode 1 (qsm-core) | its own JS Otsu/threshold (`MaskController`, `ThresholdUtils.js`) |
| TGV α | QSMxT's `TgvConfig` default pair (ppm) | a "regularization level" preset (`get_default_alpha`) |
| B0 direction | from the NIfTI affine (`qsm_core::geometry::b0_direction_from_affine`) | hardcoded `(0, 0, 1)` in five places in the worker |

Wiring that differs as well:

- TGV: the worker converts the ppm field back to phase at TE1 (`ppmFieldToPhase`) for TGV to
  divide out again; QSMxT passes `TgvInput::FieldPpm`.
- Referencing: the TGV map is referenced over the un-eroded brain mask, which is the rim bias QSMxT
  fixed in #253 (reference over the map's support, zero outside, publish the support mask).
- QSMART: the worker assembles it from vasculature, SDF, inner inversion and offset calls in JS;
  QSMxT calls `qsm_core::pipeline::run_qsmart` and converts the vessel radius and Frangi scales
  from mm to voxels in its runner.
- SWI: the pre-CLEAR-SWI, first-echo API; QSMxT uses CLEAR-SWI on all echoes.
- Field mapping: qsmbly calls qsm-core directly; QSMxT goes through `src/pipeline/fieldmap.rs`,
  which adds its stricter input checks.
- JS still does numerics QSM.rs or QSMxT already provide: Otsu and threshold masks
  (twice), `computeWeightedEchoFit`, `boxFilter3dSeparable`, TGV parameter resolution, HD-BET patch
  estimates, and `RodentMask.js` edits the generated methods text.

### 2.5 Why it keeps happening

- The **parameter set** exists four times: `qsmxt-config`, the clap CLI, the TUI's form state
  (`src/tui/app.rs`: rows, string buffers, name→field match tables), and qsmbly (`index.html`,
  `PipelineSettingsController.js`, `config.js`, `ConfigBridge.js`). A new parameter means edits in
  five places in qsmbly alone.
- The **wiring** exists twice: QSMxT's `src/pipeline/runner.rs` (6,750 lines, wiring interleaved
  with file I/O, caching and provenance) and qsmbly's `js/qsm-worker-pure.js`.
- Logic qsmbly needs is already free of file I/O in QSMxT but lives in the binary crate, where
  qsmbly cannot link it: `pipeline/fieldmap.rs`, `pipeline/referencing.rs`, `pipeline/memory.rs`,
  `pipeline/requirements.rs`.
- QSM.rs's pipeline dispatchers (`run_dipole_inversion`, `run_bg_removal`, masking, separation)
  get deep-learning weights from `$QSM_MODEL_DIR`, the cache or a download
  (`models::primary_weight_bytes`), none of which exists in a browser. So qsmbly keeps a parallel
  dispatch (`run_dl_*_wasm`, the `DL_TILING` table).

## 3. Decision: one run engine, shared by `qsmxt run` and qsmbly

Options considered: port qsmbly in place (drift returns every release); rewrite the wiring in
qsmbly's Rust with parity tests (still two implementations); run the whole `qsmxt` binary in the
browser through WASI and a virtual file system (no interactivity, every intermediate goes through
an in-memory file system). **Chosen:** extract QSMxT's I/O-free run logic into a library crate
that compiles to `wasm32-unknown-unknown`, and make both front ends drive it.

### 3.1 Layers

| Layer | Owns | Change |
|---|---|---|
| QSM.rs (`qsm-core`) | algorithms, per-stage pipeline functions | runs in WASM everywhere; DL weights can be supplied from memory |
| `qsmxt-engine` (`crates/qsmxt-engine`, today's `qsmxt-config` renamed) | config schema, command, methods text, **settings schema**; which stages run and on what inputs; crop box and working grid; referencing; requirement checks; memory estimates; cache keys; scan facts from header + sidecar | run logic extracted from `src/pipeline/*`; adds the settings schema; re-exports `qsm-core` |
| `qsmxt` binary | BIDS discovery, file I/O, caching and provenance, executor (local/SLURM), CLI, TUI | `runner.rs` becomes file I/O around the engine |
| qsmbly | UI, file and DICOM loading, viewer, model download, in-browser cache | thin bindings; JS numerics deleted |

### 3.2 Engine API (sketch; the QSMxT PRs settle the details)

```rust
/// What a run's data can and cannot do, from NIfTI headers and BIDS sidecars:
/// dims, voxel size, affine, B0 direction, echo times, field strength, manufacturer,
/// slice thickness, which parts are present (mag/phase/real/imag, MESE, T1w, ...).
pub struct ScanFacts { /* ... */ }

pub struct Plan {
    pub stages: Vec<StageKey>,        // in execution order
    pub models: Vec<&'static str>,    // DL model ids the run needs (weights to fetch first)
    pub peak_memory_bytes: usize,     // from memory.rs
    pub warnings: Vec<String>,        // implied outputs that cannot be produced (requirements.rs)
}

/// Errors are the requirement errors QSMxT already raises (an asked-for output this run's data
/// cannot produce), worded identically in both front ends.
pub fn plan(config: &PipelineConfig, facts: &ScanFacts) -> Result<Plan, EngineError>;

/// Volumes in and out of stages. `qsmxt` implements it over its files and step cache
/// (`PipelineState`, `step_cache_key`, provenance sidecars); qsmbly keeps volumes in memory.
pub trait StageStore {
    fn input(&mut self, name: InputName) -> Result<Volume, EngineError>;   // echoes, custom mask, ...
    fn cached(&mut self, key: &StageKey, params_hash: &str) -> Option<StageOutputs>;
    fn record(&mut self, key: &StageKey, params_hash: &str, outputs: &StageOutputs) -> Result<(), EngineError>;
}

/// Progress, logs, and every intermediate and final output as it is produced.
pub trait Observer {
    fn stage(&mut self, key: &StageKey, event: StageEvent);
    fn progress(&mut self, done: usize, total: usize);
    fn output(&mut self, name: OutputName, volume: &Volume);
}

pub fn run(plan: &Plan, config: &PipelineConfig, facts: &ScanFacts,
           store: &mut dyn StageStore, observer: &mut dyn Observer) -> Result<(), EngineError>;
```

Design constraints:

- **No file system, no process spawning, no `Instant`, no native-only crates** in the engine.
  `log` is fine. Progress goes through `Observer`, not progress bars.
- **Memory.** The CLI loads each stage's inputs from disk and drops them; the engine must allow
  that (inputs requested through the store per stage, not held for the whole run). qsmbly's
  in-memory store has to stay inside the 4 GB WASM heap, so it keeps what the viewer shows and
  what a re-run needs, and nothing else.
- **Re-running from a stage.** Because cache keys are the engine's, qsmbly gets "change the
  inversion, re-run only the inversion" for free.
- **Single-run first.** Multi-run features (multi-orientation COSMOS/STI, cohort aggregation)
  stay in the CLI until the single-run engine is done.

### 3.3 Defaults and the browser profile

qsmbly's defaults are QSMxT's defaults. Where the browser cannot use a QSMxT default because of the
4 GB heap, the browser value is written **into the config**, so the TOML, the generated
`qsmxt run` command and the methods text all carry it and QSMxT reproduces the browser run:

- DL tile size/halo for whole-volume nets (`inversion.tile_size` / `tile_halo`, browser 56/4).
- HD-BET sliding window instead of full volume (`hd-bet` mask-op parameters).
- χ-separation and R2PRIMEnet patch sizes (QSM.rs `WASM_PATCH` constants today).

The profile is defined once in `qsmxt-engine` (e.g. `PipelineConfig::browser()`),
not in qsmbly's JS. Changing qsmbly's defaults changes what existing users get (RTS → iLSQR,
V-SHARP, mask, TGV α); the release notes say so.

### 3.4 Masks

The mask builder edits a **mask recipe** (mask sections: input, generator, refinements, two-pass)
that runs through the engine's own masking, with live previews computed by the same code. That
keeps it reproducible: the recipe appears in the command. Hand-drawn edits and uploaded masks
become a **custom mask**; the methods text and the command say a custom mask was supplied.

### 3.5 One settings schema

`qsmxt-engine` gains a description of every user-facing setting:

- config path (e.g. `bg_removal.vsharp.max_radius`), label, help text;
- type, units, range or step, enum options with their own labels and help;
- default, CLI flag;
- tab and sub-tab (the TUI's layout: Input / Preprocessing [Geometry, Masking, Motion] / QSM
  [Field map, Background, Inversion, Multi-orientation, Reference] / χ-separation / Other outputs
  [SWI/SMWI, Relaxometry, Segmentation, Export] / Execution / Methods);
- visibility as data (e.g. `{ "field": "bg_removal.algorithm", "in": ["vsharp"] }`).

Exported to JS through WASM, it drives qsmbly's settings dialog generically. Custom widgets stay
only where the browser adds something: the mask builder, echo times, model download size, the
memory estimate. QSMxT tests keep the schema honest (every `PipelineConfig` leaf is in the schema
or listed as not user-facing; every clap flag maps to a schema entry; TUI rows match the schema).
The TUI can later render from the schema, which removes its separate copy.

### 3.6 Parity guarantees (enforced in CI)

1. **Same code.** Both front ends call the engine.
2. **Native vs WASM.** The same configs run natively (`cargo test` in `rust-wasm/` on the host)
   and in WASM (Node, loading the built bundle) on a small phantom; outputs agree within a
   measured tolerance (NRMSE). Bitwise agreement is not expected: rustfft and tract pick different
   kernels per CPU and SIMD level, and threaded sums reorder.
3. **End to end.** CI builds `qsmxt` at the pinned commit, runs the command qsmbly generates on
   the phantom, and compares with the WASM run.

Built in 3.7 as `.github/workflows/parity.yml` (qsmbly), at the commit or tag
`rust-wasm/Cargo.toml` pins, on every PR and on the pin-bump PRs:

- **engine**: no algorithm runs. Every listed config and every option of the settings schema
  (each enum option, each switch, each number changed where it is shown, each mask preset, input
  and step), asked of the bundle under Node and of `qsmxt-engine` natively: config, settings view,
  plan, the dry run's step keys (algorithm, parameters and settings read, hashed), published names
  and sidecars, graph, methods, command and TOML must be equal.
- **e2e**: a handful of runs with the fastest algorithms (TKD; two-pass, SWI and T2*/R2*, an
  oblique scan resampled) on a 24×24×20 phantom, through qsmbly's own run and export code, against
  `qsmxt run` with the bundle's command and with its settings file: the same outputs, sidecars,
  settings file, graph, methods and run record; masks bitwise, every other output within 2e-6 of
  `qsmxt run`'s, relative to the volume's largest value (measured: bitwise or ≤ 1.2e-10 ppm on χ).
  Per-algorithm agreement belongs to QSM.rs's wasm harness.

## 4. Work plan

Phases 1 and 2 run in parallel; phase 3 starts as soon as the first engine slice lands (qsmbly
pins QSMxT by commit during development, as QSMxT pins QSM.rs). qsmbly is released when it runs on
the engine and QSMxT has released the engine; there is no interim port of today's JS worker.

Status (2026-10-16): phase 1 is merged (QSM.rs #190–#194, QSMxT #329 #330, qsmbly #147–#151).
Phase 2: 2.0 (QSMxT #331), 2.1 (#332), 2.2 (#333–#336) and 2.3 (#337–#339) are merged; 2.4 is in
progress. Phase 3: 3.1 and 3.2 are in progress. Step 3.6 (the
plan before running) is built in the new workspace, in U2 (qsmbly #171 and #172).

### UI redesign

A larger overhaul of qsmbly's UI is being considered, designed around what the engine makes
possible: the plan shown before a run (stages, memory, models to download, requirement problems),
outputs streamed as each stage finishes, "re-run from here", mask recipes and settings generated
from the schema. Steps that build or change UI wait for that redesign plan, so they are built
once, for the new UI, and not twice:

| Waits for the redesign | Does not |
|---|---|
| 3.4 mask builder, 3.5 "re-run from here", 3.6 plan before running, 4.2 settings renderer, the UI side of phase 5 | all of phase 2, 3.1 bindings, 3.2 worker relay (engine side), 3.3 deleting JS numerics that the UI does not use, 3.7 parity CI, 4.1 settings schema |

The steps that do not wait define what the new UI is built on, so they go ahead. Where one of
them would have to change today's UI just to keep it working (3.2 streaming outputs to the
viewer, or a numeric helper the current mask previews still call in 3.3), it does the least that
keeps today's UI working.

### Phase 1: unblock

| # | Owner | Work | Done when |
|---|---|---|---|
| 1.1 | QSM.rs | Take timing off iLSQR's library path (`ilsqr` must not touch `Instant`; tracing becomes opt-in for native benchmarks only). | no `Instant`/`SystemTime` reachable from non-test library code |
| 1.2 | QSM.rs | CI job that builds for `wasm32-unknown-unknown` and runs every `pipeline::*` stage (and each inversion/BFR algorithm) on a tiny phantom under Node (`wasm-bindgen-test`). | a reintroduced `Instant::now()` fails CI |
| 1.3 | QSM.rs | In-memory weight provider (e.g. `models::provide_weights(file_name, bytes)`), consulted before `$QSM_MODEL_DIR`/cache/download, so every DL-aware dispatcher (inversion, BFRnet, iQFM, HD-BET/RS2-Net masking, SynthSeg, R2PRIMEnet, χ-sep nets) runs in WASM. Verify sha256 against the registry. | `run_dipole_inversion` with `xqsm` runs in the 1.2 harness with provided bytes |
| 1.4 | QSM.rs | `run_qsmart` reports its intermediates (vessel mask, stage-1/2 local fields and χ) through a callback, so hosts can show or save them. | QSMxT saves them too (decided; 2.2) |
| 1.5 | QSMxT | `qsmxt-config` re-exports `qsm-core` and forwards `simd`, `onnx`, `parallel`, so a consumer pins QSMxT only. | qsmbly builds with no direct `qsm-core` pin |
| 1.6 | qsmbly | Single pin on QSMxT; drop the stebo85 `[patch]`; bump workflow edits one tag and CI really runs on its PRs (dispatch `ci.yml` on the bump branch, or open the PR with an app token); close #143 and #146. | a bump PR shows a CI result without manual approval |
| 1.7 | qsmbly | Delete the dead bindings (the 37 exports nothing calls) and their defaults plumbing; bring `staging` back in line with `main` (close or redo #144). | — |
| 1.8 | qsmbly | Show the QSMxT and QSM.rs versions from the build (WASM export), replacing `QSM_RS_VERSION = '0.38.0'` in `config.js`. | — |

### Phase 2: the QSMxT engine crate

Every PR keeps `qsmxt run` output bitwise unchanged: compare derivatives before/after on the BIDS
fixture, the CI phantom and one in-vivo multi-echo dataset. QSMxT CI gains a
`cargo build -p qsmxt-engine --target wasm32-unknown-unknown` check from the first PR.

| # | Work |
|---|---|
| 2.0 | Rename `qsmxt-config` to `qsmxt-engine` (crate and directory, release version stamping, docs) before the engine grows inside it; qsmbly follows (pin, bump workflow and its dispatch type, `build.rs`). Release assets and `qsmxt update` are unchanged. |
| 2.1 | Move into the crate the modules that are already I/O-free: `referencing.rs`, `requirements.rs` (`RunFacts` → `ScanFacts`), `memory.rs` (estimates; host memory queries stay in the binary), `fieldmap.rs` checks, scan metadata from header + sidecar (`resolve_geometry`, `scan_metadata`, `bids/sidecar.rs` interpretation), `step_cache_key` / `consumed_config`, `hz_per_ppm` etc. |
| 2.2 | Split the QSM chain stages in `runner.rs` into load → compute (engine) → save: phase scaling, magnitude / homogeneity, masking incl. two-pass and section combination, unwrap / field mapping (incl. robust-fit report), background removal and inversion incl. crop box and iQFM, TGV (`TgvInput`), QSMART (incl. the mm→voxel conversion; QSMxT saves its intermediates when intermediate outputs are requested, so default output is unchanged), iQSM/iQSM+, referencing over support or region. |
| 2.3 | Planner (`plan`) and run loop (`run`) with `StageStore`/`Observer`; `runner.rs` becomes the file-backed store plus BIDS naming and provenance. Required DL models come from `plan` (replaces per-stage `prefetch_weights`). |
| 2.4 | Remaining single-run stages: CLEAR-SWI and minIP, SMWI, T2*/R2* (ARLO), R2 (EPG, MESE) and R2′ incl. R2PRIMEnet, χ-separation (classical and DL), SynthSeg and region statistics, motion correction and registration, axial resampling and output space, slice-gap check, real/imaginary input (incl. GE corrections), coil combination of uncombined data. |
| 2.5 | Browser profile (§3.3) as a function of the engine, with tests that the generated command carries it. |
| 2.6 | Later: multi-run inputs (multi-orientation COSMOS/STI). |

### Pipeline graph

The engine draws the pipeline a run will take, and the one it took, as a graph that goes with the
methods text: each step a box (label, algorithm, key settings), each arrow the data one step reads
from another. Both come from the plan, so the picture cannot disagree with what runs, and qsmbly
and `qsmxt` draw the same graph.

Some things are only decided during a run: a supplied mask that cannot be used, or that
`--use-custom-masks` does not find, is computed instead; the reconstruction box depends on the
mask; each step is computed or reused from the cache. The run records these, and the graph after
the run shows them on its boxes. The methods text is generated from the plan and that record, not
from the configuration alone, so it says what was done, including those changes.

| # | Owner | Work | After |
|---|---|---|---|
| G1 | QSMxT | The graph from `plan`: step labels, algorithm and key settings per step, data-flow edges (from `graph.rs`'s "reads" table), two-pass as two branches joining at the combination. | 2.4 |
| G2 | QSMxT | A run record (each step computed, cached or skipped; run-time decisions and their reasons); the graph after the run; methods text from plan + record. | G1 |
| G3 | QSMxT | Mermaid (`pipeline.mmd`) and self-contained SVG (`pipeline.svg`, drawn by the engine, no Graphviz) renderers; `qsmxt run` writes them next to the methods text for each run, and a dataset graph (below) for the whole run; `qsmxt run --dry-run` writes and prints the planned graph. | G1, G2 |
| G4 | QSMxT | TUI "Pipeline" view: the graph as text, with memory and models, updated as settings change; a key writes the SVG and opens it. | G3 |
| G5 | qsmbly | The graph in the new UI, live during a run (queued, running, done, cached, stale). | the UI redesign |

Status (2026-10-19): G1–G3 are merged (QSMxT #369, #382, #386, #387); G4 is QSMxT #403. G5 is
qsmbly #188: the Pipeline tab's boxes carry a status strip (icon and word, a progress bar while the
step runs) from the run's stage events and, between runs, from the engine's dry run; the failed step
shows the engine's message. The graph itself stays the engine's.

A dataset gets one graph per run and a **dataset graph**: every run's graph merged, each step
once, labelled with how many runs took it (e.g. "Inversion (iLSQR), 320/320 runs"). A step only
some runs took is drawn differently (e.g. dashed) with its count ("R2PRIMEnet, 12/320 runs"), and
a step the runs took in different ways shows the split ("Mask: computed 318, supplied 2"). The
dataset's methods text comes from the same merged record.

Defaults until decided otherwise (§5): Mermaid and SVG only; one box per step, with files in
tooltips; the methods text describes what ran.

### Phase 3: qsmbly on the engine

| # | Work |
|---|---|
| 3.1 | New bindings: `plan`, `run` (with an in-memory `StageStore` and an `Observer` that posts progress, logs and outputs to the main thread), weight provider, schema, defaults, command, methods, TOML. Remove the per-algorithm wrappers and `run_dl_*`. Both bundles (base, DL) contain the engine; JS loads the DL bundle when `plan.models` is non-empty. |
| 3.2 | Worker becomes a relay: build `ScanFacts` + inputs as typed arrays (no `Array.from` copies), fetch `plan.models` weights (existing IndexedDB cache, Hugging Face mirror), run, stream outputs to the viewer. Cancel stays "terminate the worker". |
| 3.3 | Delete JS numerics: `MaskUtils`, `ThresholdUtils` (Otsu, thresholds), `PhaseUtils` (echo fit, `ppmFieldToPhase`), `FilterUtils`, `TgvParams`, `ScanParams` step logic, `HdBetEstimate`, and the methods-text edits in `RodentMask.js` (the methods text must come from `qsmxt-engine`; if it lacks a sentence, fix it there). |
| 3.4 | Mask builder on engine masking (§3.4): recipe editing with previews, custom-mask path for drawn or uploaded masks, mask alignment repair kept as a loading step. |
| 3.5 | "Re-run from here": after a run, changing a setting re-runs from the first affected stage (engine cache keys). |
| 3.6 | Show the memory estimate and requirement warnings from `plan` before running, in QSMxT's words. |
| 3.7 | CI parity jobs (§3.6, items 2 and 3). |

### Phase 4: settings from the schema

| # | Owner | Work |
|---|---|---|
| 4.1 | QSMxT | Settings schema in `qsmxt-engine` (§3.5), built from the TUI's labels, help and visibility, with the coverage tests. |
| 4.2 | qsmbly | Generic settings renderer from the schema, laid out by tab/sub-tab; `ConfigBridge.js` and the hand-written settings HTML go away (the settings object *is* a `PipelineConfig` JSON). |
| 4.3 | QSMxT | (Optional, later) TUI renders its rows from the schema. |

### Phase 5: features

qsmbly exposes whatever the engine supports. In scope: everything single-run in QSMxT —
real/imaginary and uncombined-coil input, motion correction, axial resampling, slice-gap check,
every masking option incl. two-pass, every unwrapping and B0-estimation option, every
background-removal and inversion method incl. deep learning, referencing to a region (needs
SynthSeg in the browser: test its memory first), CLEAR-SWI and SMWI, T2*/R2*, R2/R2′,
χ-separation, region statistics, and the methods/command/config exports.

Out of scope: multi-subject BIDS batches, SLURM, `qsmxt update`, cohort aggregation.

Open: multi-orientation (COSMOS/STI; several acquisitions in one session) and DICOM export.

## 5. Open questions

Decided (2026-10-15): the engine crate is `qsmxt-engine` and absorbs `qsmxt-config` (one crate,
one pin; `config`, `command` and `methods` become its modules). QSMxT saves QSMART's
intermediates too (1.4, 2.2).

Still open:

- The UI redesign (§4): its plan settles 3.4–3.6, 4.2 and the UI side of phase 5.
- The pipeline graph (§4), defaults in place until decided: formats (Mermaid and SVG; no DOT),
  detail (one box per step), and the methods text describing what ran rather than what was
  configured.
- The tolerance for native vs WASM parity: 2e-6 (relative) in CI since 3.7; masks bitwise.
- qsmbly's version number for the first engine-based release.

## 6. Pointers

- qsmbly's open issues this work resolves: #44 (results depend on input mode), #54 (numerics in
  JS), #102 (Laplacian field-map meaning), #143 (RS2-Net fork), #146 (bump PR).
- QSMxT code to read first: `src/pipeline/runner.rs` (`stage_*` functions, `stage_reference`,
  `crop_box_for`, `resolve_geometry`), `src/pipeline/{fieldmap,referencing,requirements,memory,graph}.rs`,
  `crates/qsmxt-config/src/{bridge,config,masking}.rs`, `crates/qsmxt-config/tests/param_coverage.rs`
  (`crates/qsmxt-engine/` after 2.0).
- QSM.rs: `src/pipeline/*`, `src/models/mod.rs` (weight resolution), `src/inversion/ilsqr.rs`.
- qsmbly: `rust-wasm/src/lib.rs`, `js/qsm-worker-pure.js`, `js/modules/ConfigBridge.js`,
  `js/controllers/PipelineSettingsController.js`, `js/app/config.js`, `scripts/generate-defaults.mjs`,
  `.github/workflows/bump-qsmxt-engine.yml`.
