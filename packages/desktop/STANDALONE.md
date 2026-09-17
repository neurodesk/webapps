# Neurodesk Webapps standalone

One archive per platform holds all 24 web applications, the Python wheels, the WebAssembly modules and the sample assets. Models are not in that archive. The application downloads a model the first time it is needed and caches it for later runs.

One separate model pack holds every model of the release. It is the same file for every platform. Install it when the machine has no internet access.

Download the archive for your platform. For multipart archives, download every part into one folder and follow the installation instructions to join and extract them. Open Neurodesk Webapps and choose an application. No Python installation is needed.

## Offline installation with the model pack

Download every part of `webapps-VERSION-models.tar.gz` into one folder. Join the parts, extract the archive into its own directory, and point the application at that directory:

```
cat webapps-VERSION-models.tar.gz.part* > webapps-VERSION-models.tar.gz
mkdir models
tar -xzf webapps-VERSION-models.tar.gz -C models
export NEURODESK_MODELS_DIR="$PWD/models"
```

On Windows, join the parts with `cmd /c copy /b`, extract with the same `tar` command, and set the variable with `$env:NEURODESK_MODELS_DIR = (Resolve-Path 'models').Path`. Set the variable in your shell profile, job script or scheduler module so every session sees it. A relative path is rejected at startup.

Every file in the pack is named after the SHA-256 of its contents. The application checks the size and checksum of a file before it uses that file. It reads the pack where it is and never writes into it, so the directory can be read-only and shared between users. On HPC, extract the pack once on a shared filesystem and bind-mount it read-only into every job.

A model that is absent from the pack still falls back to the local cache and then to a download. With the complete pack in place, no model download is attempted.

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

`--verify` checks every packaged site and runtime file against its SHA-256 manifest. Models live outside that bundle and are checked against the same manifest each time one is read from the pack, the cache or a download. An incomplete or modified bundle fails verification. Keep the complete extracted application together. Updates are explicit replacement releases; the application does not fetch updates or missing files.

## Apptainer on HPC

The Linux SIF release contains the compiled suite and its system libraries. After reassembling the SIF, use:

```
apptainer run webapps-VERSION-linux-x64.sif --verify
apptainer run --bind "$PWD:/data" webapps-VERSION-linux-x64.sif --job /data/job.json --output /data/results
```

To run without an internet connection, bind the extracted model pack read-only and name it in the environment:

```
apptainer run --bind /shared/webapps-models:/models:ro --env NEURODESK_MODELS_DIR=/models \
  --bind "$PWD:/data" webapps-VERSION-linux-x64.sif --job /data/job.json --output /data/results
```

One extracted pack on a shared filesystem serves every node and every user of the cluster.

The image starts Xvfb when no display is available. For a GPU job, request a GPU from the scheduler and use the site's graphics-driver binding configuration, such as `--nv` for NVIDIA. Successful GPU execution depends on the site's driver and graphics support. Use a graphical HPC session for interactive applications.

The container runs Chromium without its setuid sandbox because Apptainer manages process isolation. Run as your regular user and bind only the required input/output directories. The normal desktop application keeps its renderer sandbox enabled.
