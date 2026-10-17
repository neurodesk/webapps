# @neurodesk/qsmbly

## 0.31.20261017

## 0.31.20261016

## 0.31.20261015

### Minor Changes

- c63094f: QSMbly has a portable command line for Linux, Windows and macOS: QSMxT 9.22.0,
  the native build of the qsm-core v0.38.0 pipeline the app runs. The command the
  app exports runs with `qsmbly` in place of `qsmxt`. Deep-learning weights
  download on first use from pinned URLs, or ahead of time with
  `qsmbly download-models`.

### Patch Changes

- 70fcd50: Require the complete verified native weight registry before every processing command, including QSMART, so native downloads from mutable URLs are unreachable. Both offline environment switches now reject incomplete model packs. Preserve explicit model-directory and offline settings in portable launchers, and permit first-use downloads for releases that do not bundle models.

  Mirror all native examples to a commit-pinned dataset and use it for CLI downloads. Offline mode rejects example downloads; help and example listing remain available. Reject native SLURM generation and the TUI because their scheduler jobs bypass verified model preflight.

  Always verify and re-extract native release archives before packaging, including source npm packs. Explain the browser's image +z B0 assumption and the phase-sidecar adjustment used by browser replay validation.
