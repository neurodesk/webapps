# Neurodesk Webapps offline

This release includes all 24 web applications, their models, Python wheels, WebAssembly modules and sample assets. Internet access is denied by the application. No account, Python installation or model download is needed on the destination machine.

Download all archive parts and the installation instructions on a connected machine, verify their SHA-256 checksums, and transfer the complete set. Follow the included commands to reassemble and extract the archive. Open Neurodesk Webapps and choose an application. The Standalone button identifies the installed offline version.

## Hardware

The desktop GUI uses Electron's Chromium engine. WebGPU applications still require a supported GPU and driver. A packaged application does not turn a GPU method into a CPU method. Linux needs a graphical session or Xvfb. Software rendering supports basic viewing and some workflows, but is unsuitable for large neural networks. macOS builds target Apple silicon; Linux and Windows builds target x86-64.

## Command line and scheduler jobs

The executable accepts:

```
neurodesk-webapps --app niimath
neurodesk-webapps --verify
neurodesk-webapps --zarr /absolute/path/to/image.ome.zarr
neurodesk-webapps --job /absolute/path/to/job.json --output /absolute/path/to/new-results
```

On macOS the executable is inside `neurodesk-webapps.app/Contents/MacOS/`. On Windows it is `neurodesk-webapps.exe`.

A job drives the same scientific implementation as the GUI. Copy `jobs/niimath.json` from these resources, place `input.nii.gz` beside it, and run the command above. The example adds one to every voxel and exports NIfTI. Input paths are relative to the job file. Output must be a new or empty directory. A successful job exits zero and writes `job-result.json`; errors exit nonzero. Scheduler scripts should check the exit status.

The JSON contract is `schemaVersion: 1`, an app ID, `expectedDownloads`, and a sequence of steps. Actions are `upload`, `click`, `fill`, `select`, `check`, and `wait`. Every step identifies a CSS `selector`; uploads provide `paths`, value changes provide `value`. Wait conditions are `exists`, `enabled`, `visible`, `text`, and `value`. A `timeoutMs` can be set on the job or individual step. App controls can change between releases; keep job templates with the release they were tested against.

Interactive editors can be used locally through the same suite. Their workflows require user choices; a batch job must explicitly supply those choices.

## Local Zarr data

Use File > Open local OME-Zarr, or `--zarr DIRECTORY`. Only that directory is granted read access through a temporary loopback URL. Symlinks escaping the selected directory are rejected. The grant disappears when the application exits.

## Integrity and maintenance

`--verify` checks every packaged model and site file against its SHA-256 manifest. An incomplete or modified bundle fails verification. Keep the complete extracted application together. Updates are explicit replacement releases; the application does not fetch updates or missing files.

## Apptainer on HPC

The Linux SIF release contains the compiled suite and its system libraries. After reassembling the SIF, use:

```
apptainer run webapps-VERSION-linux-x64.sif --verify
apptainer run --bind "$PWD:/data" webapps-VERSION-linux-x64.sif --job /data/job.json --output /data/results
```

The image starts Xvfb when no display is available. For a GPU job, request a GPU from the scheduler and use the site's graphics-driver binding configuration, such as `--nv` for NVIDIA. Successful GPU execution depends on the site's driver and graphics support. Use a graphical HPC session for interactive applications.

The container runs Chromium without its setuid sandbox because Apptainer manages process isolation. Run as your regular user and bind only the required input/output directories. The normal desktop application keeps its renderer sandbox enabled.
