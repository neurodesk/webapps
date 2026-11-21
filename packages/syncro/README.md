# SYNcro

Normalize a primary NIfTI scan of any contrast to the MNI152 1 mm brain template: SynthSR synthesizes a T1-weighted
image, MindGrab extracts its brain, Greedy (or ANTs SyN) registers it to the template, and the scan, a pathological
modality and a lesion map follow the same transforms; niimath masks the result.

One Rust core (`exes/syncro`) decides every step and its exact command line. The standalone `syncro` command runs
those commands as native processes; the web app runs the same core as WebAssembly and maps each command to its
browser runtime. Both write the commands in `commands.sh`.

## Standalone command

The archive holds `syncro` (or `syncro.exe`), the native tools in `bin/` (`synthsr`, `brainchop-mindgrab`,
`greedy-rs`, `niimath`; their models are built in), the MNI template in `templates/` and every tool's licence in
`licenses/`. It needs no Node.js, Python, FreeSurfer, network or model download. Keep the extracted directory
intact: `syncro` finds its tools next to itself (or set `SYNCRO_HOME`), then on `PATH`.

```bash
version=MAJOR.MINOR.YYYYMMDD
curl -fLO "https://github.com/neurodesk/webapps/releases/download/syncro-v${version}/syncro-${version}-linux-x64.tar.gz"
curl -fLO "https://github.com/neurodesk/webapps/releases/download/syncro-v${version}/syncro-${version}-linux-x64.tar.gz.sha256"
sha256sum -c "syncro-${version}-linux-x64.tar.gz.sha256"
tar -xzf "syncro-${version}-linux-x64.tar.gz"
"./syncro-${version}-linux-x64/syncro" self-check
"./syncro-${version}-linux-x64/syncro" input.nii.gz results
```

```
syncro INPUT OUTPUT_DIR [--lesion FILE] [--pathological FILE] [--ct] [--normalization greedy|ants]
       [--threads N] [--device auto|cpu|metal|cuda] [--keep-synth] [--resume]
```

- `--threads` (default `SLURM_CPUS_PER_TASK`, else every core) caps every tool: SynthSR, MindGrab, Greedy, niimath
  and ANTs.
- `--device` chooses where SynthSR and MindGrab run; `auto` takes each tool's fastest (Metal on Apple silicon,
  CUDA for MindGrab on NVIDIA). SynthSR has no CUDA build and runs on the CPU there (about 10 s, 8 GB).
- `--normalization ants` runs ANTs SyN with the schedule the web app's ANTs kernel runs. ANTs is not bundled:
  install it and put it on `PATH` or set `ANTSPATH`; `syncro` stops with that message otherwise.
- `--ct` marks a CT in Hounsfield units. Modality is explicit; there is no automatic CT detection.
- `--resume` reuses the steps an interrupted run finished. It refuses a directory that is not a SYNcro run and
  any change to an input's name or content, the options or the tools.

A gantry-tilted scan (a sheared affine, as CT often has) is resampled onto an orthogonal grid that covers it,
filled with its darkest voxel, before anything else; its lesion map follows on the same grid.

On a 1 mm T1 with a TRACE scan and lesion, an M4 Pro took 17 s with Greedy and 22 s with ANTs, against 91 s and
108 s for the earlier Node command. The tools run one at a time; the largest is SynthSR on the CPU (about 8 GB
per its README; MindGrab peaks at 2.6 GB), so a Slurm job without a GPU should request 12 GB:

```bash
#!/bin/bash
#SBATCH --cpus-per-task=4
#SBATCH --mem=12G
set -euo pipefail
/shared/software/syncro-VERSION-linux-x64/syncro /data/input.nii.gz /scratch/my-job/syncro --threads "$SLURM_CPUS_PER_TASK"
```

## Images and outputs

One scalar primary NIfTI, an optional pathological-modality scan (`--pathological`, registered to the primary
first) and an optional binary lesion map on the pathological scan's grid when given, otherwise the primary's (a
one-voxel border is allowed). Outputs: `w<input>` for each normalized input, `wb<primary>` the normalized
brain-extracted primary, `wbt1<primary>` the normalized synthetic brain, and with `--keep-synth` `t1<primary>` in
native space. `provenance.json` records the commands, each tool's path, version and SHA-256, and timings. Scans
are resampled as float32 with a zero background (`--ct`: the lower of zero and the scan's minimum); lesions are
uint8. Inputs whose names would give duplicate outputs are refused.

## Development and validation

- `exes/syncro`: the core (`core`), the command line (`cli`) and the WebAssembly build (`wasm`); `cargo test`
  there checks the de-shearing against the JavaScript it replaced and the commands of every input case.
- `pnpm --filter @neurodesk/syncro test:core` builds the WebAssembly core and checks it emits the same commands.
- `scripts/package-syncro.py package TARGET` assembles an archive from the tool releases pinned in `tools.json`
  and runs `validation/package-check.mjs` on the extracted copy.

[validation/README.md](validation/README.md) holds the container comparisons, which predate the Rust core. Current
evidence covers a few real scans, not clinical validation. Review the acquired image, brain mask and MNI alignment
before using results.

Code is Apache-2.0 with upstream attribution. The MNI template has separate FSL non-commercial terms in
`data/FSL-LICENSE.txt`.
