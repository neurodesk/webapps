# fastprep

Rust port of fastprep.py: lean fMRIPrep-style preprocessing. fastprep orchestrates only. It reads NIfTI headers
(at most 348 decompressed bytes per image), BIDS sidecars and small tool outputs; separately installed tools touch
every voxel.

```bash
make build
FASTPREP_HOME=/path/to/home target/release/fastprep bids_dir out_dir participant -w work
```

`$FASTPREP_HOME` (default: the executable's directory) holds `bin/` (niimath, brainchop-mindgrab,
brainchop-mindmap, greedy-rs, synthsr, topofit, glm, meica, sdc; searched before `PATH`) and
`templates/tpl-MNI152NLin2009cAsym/`. The bids_dir is the folder that holds `sub-*`.

Build the optional PEPOLAR solver with `cargo build --release --manifest-path exes/sdc/Cargo.toml -p sdc`.
A development home can link the release builds, so rebuilding updates it:

```bash
mkdir -p ~/fastprep/bin && cd ~/fastprep/bin
E=~/src/webapps/exes
ln -sfn $E/fastprep/target/release/fastprep $E/glm/target/release/glm $E/greedy/target/release/greedy-rs \
  $E/synthsr/target/release/synthsr $E/sdc/target/release/sdc .
ln -sfn ~/src/niimath/src/niimath ~/src/brainchopC/src/brainchop-mind{grab,map} .
ln -sfn ~/src/topofit/node/topofit.mjs topofit
ln -sfn ~/src/meica-rs/target/release/meica .
ln -sfn ~/src/fastprep/templates ~/fastprep/templates
FASTPREP_HOME=~/fastprep ~/fastprep/bin/fastprep BIDS OUT participant -w WORK
```

Differences from fastprep.py:

- Resume uses completion records in `work/steps/` (argv, settings and input/output size and mtime), not output
  existence. Work directories from fastprep.py rerun.
- Steps run sequentially. Peak RAM is not sampled.
- Opposite-PE (PEPOLAR) EPI pairs use the existing sdc PyHySCO solver instead of Python's SuCor. Invalid pairs get SynthSR SDC when
  `--synthsr` allows it.
- Only single-file NIfTI-1 (`.nii`, `.nii.gz`) inputs are accepted.
- BOLD `RepetitionTime` must be a positive finite JSON number. Discovery rejects strings, nulls and
  non-positive values before preprocessing. Reports escape metadata at the HTML boundary.
- `commands.sh` starts each invocation with an `export` line of the tool environment.

Fixed here; fastprep.py still has these:

- Resume refreshes the chosen BOLD→T1 coreg transform when it changes, and its QC reference whenever the chosen
  candidate reran; Python keeps both once they exist.
- Tissue PVE maps follow the segmentation step's resume record (work copies are kept), not an existence check.
- GLM completion records include the BOLD JSON sidecar, so a `StartTime` change reruns the task analysis.
- SliceTiming is reversed for `SliceEncodingDirection` `k-`; for `i`/`j` slice timing is skipped with a warning.
- A subject with neither T1w nor BOLD is skipped instead of crashing.
- A SliceTiming list with non-numbers is treated as absent (no STC), instead of writing it through.
- The events file is found for an uncompressed `_bold.nii` as well as `.nii.gz`.
- Report text follows what ran: Methods claims STC only along a k slice axis and names runs that fell back to the
  rigid coreg; "other temporal filtering" when FRISGO ran; tSNR scope for short runs; acquired PEPOLAR is named as PyHySCO only when it ran; `--frisgo off` is named as the reason; Dataset comes from a BOLD
  run (a synthetic T1w is in the output folder); the surfaces figure needs surfaces to have run. The browser
  report shows a Runtime fact in place of the CLI's Threads/GPU facts.
- The browser BOLD size check counts phase echoes (MEDIC).
- A step's declared outputs are deleted before it reruns. niimath gave the aCompCor step, which re-reads its own
  `-save notgm`, the previous run's file, so a resume after a T1w grid change failed. Verified: a resume after
  `--synthsr off --no-robustfov` matches a clean run. Derivatives from an earlier configuration are not removed.

The goal is otherwise byte parity of `commands.sh` and outputs with fastprep.py; list any new divergence here.

## ME-ICA

Runs with three or more magnitude echoes get ME-ICA after `bold_apply` (`--meica auto|on|off`,
`--meica-tree`), as fastprep.py: the echoes are resampled onto the boldref grid with the run's own FRISGO, STC, HMC
and SDC, `meica` (meica-rs) classifies the components, and `meica --denoise` writes `desc-denoised` beside each
`desc-preproc` series. `glm --meica-qc` relates the components to the task design and motion for the report.
On motor3T (2026-10-21) the commands, every ME-ICA output and the report sections match fastprep.py. In the
browser, `packages/fastprep` runs `meica` on `@niivue/meica`'s single-threaded WASM and `glm --meica-qc` on the glm
WASM; its Node run of motor3T (`validation/node-demo.mjs`) classifies the same 17 components (10 accepted, 7
rejected), with denoised series at median voxel r 0.997 to native (the browser's niimath and MindGrab already
move preproc to r 0.9993).

## GPU slots

`--gpu-slots N --gpu-lock-dir DIR` (default `/tmp`) caps concurrent GPU steps across every fastprep instance, users
included, with `flock`ed `fastprep-gpu-{i}.lock` files: the kernel drops a crashed holder's lock, so no stale slots.
A lock file that cannot be opened is an error, not a wait. Files are opened `O_NOFOLLOW` and made 0666 only when
they are a lone (one link) file owned by the caller, so a planted symlink or hard link cannot redirect the chmod.

## Status

No bundled release yet (`WITHOUT_COMMAND_LINE` in `test/standalone.test.mjs`): it waits on packaging niimath,
brainchop, greedy-rs, synthsr, topofit and glm, and on TopoFit's licence. The browser host is
`packages/fastprep`; the demo is `apps/fastprep`.

Open: SuCor parity; TopoFit licence; native release packaging; per-tool browser
peak-memory measurement.

### PEPOLAR implementation and deliberate divergence

PEPOLAR uses `sdc pyhysco` (the existing PyHySCO 0.0.4 Rust/WASM port), not the Python
reference's SuCor. Each reference is temporally averaged without motion correction.
The pair must have opposite i/i- or j/j- directions, equal finite positive readout
times, matching spatial grids, orthogonal voxel axes and at least three voxels per
spatial axis. Through-plane k encoding and sheared or mismatched grids are refused.
The corrected pair's mean is brain-extracted and used to register the Hz field to
BOLD. As in the solver's pinned fixtures, shifts are `Hz * TotalReadoutTime * PE sign`
voxels; Jacobian intensity modulation is enabled when applying them. Corrected solver
references have jointly normalized intensities and are used for registration only.

The native host needs the `sdc` binary from `exes/sdc` in `<home>/bin` or PATH. The
browser loads `@neurodesk/sdc` lazily when this command first runs. Browser NIfTI
headers preserve the reference metadata through the shared writer; native sdc uses
its own minimal header, so compressed bytes are not claimed identical across hosts.
No pinned Python reference checkout was available for issue #509: Python parity is
unverified, and SuCor/PyHySCO field estimates intentionally differ. Existing phasediff
commands remain unchanged.
