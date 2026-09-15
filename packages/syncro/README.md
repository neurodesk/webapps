# SYNcro

Normalize a primary NIfTI scan to the MNI152 1 mm brain template. The shared browser pipeline follows native SYNcro: SynthSR, configurable MindGrab/SynthStrip brain extraction, configurable Greedy/ANTs normalization, pathological-modality alignment, lesion propagation and niimath masking. The packaged Node fallback retains SynthStrip and ANTs for portable CPU execution.

## Portable Windows and Linux builds

Download the Windows x64 or Linux x64 archive from the webapp's **Standalone** dialog. Each archive contains `syncro` or `syncro.exe`, a private Node runtime, native ONNX Runtime, the ANTs WebAssembly kernel, the MNI template, and the checksum-pinned SynthSR and SynthStrip models. You do not need to install Node.js, Python, FreeSurfer, or a display server.

On Linux, download, verify, extract, and check the current release:

```bash
version=MAJOR.MINOR.YYYYMMDD
curl -fLO "https://github.com/neurodesk/webapps/releases/download/syncro-v${version}/syncro-${version}-linux-x64.tar.gz"
curl -fLO "https://github.com/neurodesk/webapps/releases/download/syncro-v${version}/syncro-${version}-linux-x64.tar.gz.sha256"
sha256sum -c "syncro-${version}-linux-x64.tar.gz.sha256"
tar -xzf "syncro-${version}-linux-x64.tar.gz"
"./syncro-${version}-linux-x64/syncro" self-check
"./syncro-${version}-linux-x64/syncro" input.nii.gz results --threads 4
```

On Windows, run these commands in PowerShell:

```powershell
$Version = 'MAJOR.MINOR.YYYYMMDD'
$Archive = "syncro-$Version-windows-x64.zip"
$Base = "https://github.com/neurodesk/webapps/releases/download/syncro-v$Version"
Invoke-WebRequest "$Base/$Archive" -OutFile $Archive
Invoke-WebRequest "$Base/$Archive.sha256" -OutFile "$Archive.sha256"
$Expected = (Get-Content "$Archive.sha256").Split()[0]
if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower() -ne $Expected) { throw 'Checksum mismatch' }
Expand-Archive -Path $Archive -DestinationPath .
& ".\syncro-$Version-windows-x64\syncro.exe" self-check
& ".\syncro-$Version-windows-x64\syncro.exe" input.nii.gz results --threads 4
```

Keep the extracted directory intact. Releases built with this packaging include both models and run offline by default. No model download or cache preparation is needed on the destination machine. Older releases that lack a `models` directory are not complete offline distributions.

Use `--ct` for a CT image in Hounsfield units. Modality is explicit; there is no intensity-based CT autodetection. CT has not yet been validated against the reference container in this port.

## Offline HPC jobs

Use the complete Linux archive above, or the Neurodesk Webapps Apptainer release described in [the desktop guide](../../packages/desktop/STANDALONE.md). The portable SYNcro executable runs without a display server.

Example SLURM script (adapt partitions, paths and resource requests to your system):

```bash
#!/bin/bash
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=01:00:00
set -euo pipefail
/shared/software/syncro-VERSION-linux-x64/syncro /data/input.nii.gz /scratch/my-job/syncro \
  --threads "$SLURM_CPUS_PER_TASK" --offline
```

The CLI uses native ONNX Runtime CPU for synthesis and extraction. Registration uses the same single-threaded ANTs WebAssembly kernel as the webapp. `--threads` controls neural-network inference, not registration. The kernel has a 4 GiB linear-memory ceiling; the validated registration grew to 3.16 GB. Process memory also includes model sessions, image buffers and outputs. Start with 32 GB per job; this is a conservative request, not a measured peak-RSS guarantee. Use a separate process/output directory for each subject.

An output directory must be new. After interruption, `--resume` verifies input, software, models and stored checkpoint hashes, reuses completed SynthSR/SynthStrip stages, and reruns registration. It is not a resume within the optimizer. Changed input/options/software require a new output directory. Accompanying-image choices can change on resume because they do not affect synthesis or extraction.

## Images and outputs

The Node fallback accepts one scalar primary NIfTI and one optional binary lesion map already in the same grid. Use the native command or browser for a separate pathological-modality scan. The shared browser pipeline permits a one-voxel mask border, matching native SYNcro's geometry tolerance.

Output names match native SYNcro: `w<input>` is each normalized input, `wb<primary>` is the normalized brain-extracted primary, and `wbt1<primary>` is the normalized brain-extracted synthetic T1. The browser's `--keep-synth` equivalent additionally retains `t1<primary>` in native space. `provenance.json` records selected engines and timing. Original intensities are resampled into MNI space as float32; lesion output is uint8.

Like native SYNcro, the shared pipeline refuses inputs whose basenames would
create duplicate output names. Non-CT scalar reslices use a zero background;
`--ct` uses the lower of zero and the primary image minimum.

## Development and validation

`pnpm --filter @neurodesk/syncro build` produces the self-contained package bundle. Building `apps/syncro` also packs it into `apps/syncro/dist/downloads/`. The shared `runSyncro` API injects inference, registration and progress adapters; Node's `normalize` API accepts filesystem paths.

See [validation/README.md](validation/README.md) for the real OpenNeuro scan, pinned Neurodesk container, exact stage comparisons, end-to-end differences and reproduction commands. Current evidence covers one real T1 scan and synthetic annotation fixtures, not clinical validation or broad modality/pathology coverage. Review the acquired image, brain mask and MNI alignment before using results.

Code is Apache-2.0 with upstream attribution. The MNI template has separate FSL non-commercial terms in `data/FSL-LICENSE.txt`.
