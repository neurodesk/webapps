# @neurodesk/qsmbly

## 0.31.20261031

## 0.31.20261027

### Patch Changes

- Preserve engine panic diagnostics during cleanup and replace a trapped worker before retry. Keep verified model downloads usable when cache writes exceed quota. Verify the updated production browser pipeline and its exported command against the pinned native release under the existing tolerances.
- Retry bounded transient CI download failures without weakening checksums, handle Windows lockfile line endings, and improve NODDI input mismatch diagnostics. Add early catalog integration checks and register generated app offline workflows and standalone exceptions.

## 0.31.20261024

## 0.31.20261022

## 0.31.20261020

## 0.31.20261019

## 0.31.20261018

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
