# SYNcro portable executables

This directory builds the launcher and the Windows x64 and Linux x64 release
archives. The launcher starts the private Node runtime in the extracted
directory. It does not contain scientific code.

From the repository root, install the frozen pnpm dependencies. Then run:

```bash
python3 exes/syncro/scripts/portable_release.py package linux-x64
python3 exes/syncro/scripts/portable_release.py verify linux-x64
```

Run the equivalent commands on Windows with `windows-x64`. A package can only
be built on its target operating system. GitHub Actions builds both targets and
can attach them to an existing `syncro-vVERSION` release.

The archives include the checksum-pinned SynthSR and SynthStrip models in
`models/`. Packaging downloads and verifies them on the build machine. The
launcher selects those bundled models and enables offline mode, so the first
analysis on an airgapped machine needs no downloads or cache preparation.
