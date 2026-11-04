# QSMbly parity measurement — 2026-11-04

Measured source HEAD: `4276acff38d6abd171c0731a00e3a4e8e8cd3a62`.
Browser engine: `999445010a067d9597299f217a9a1165d4b7d62d`; core: `046e2e3bd21b1f35ce2760c115145c52956645a2`.
Published native: QSMxT 10.0.0 / core v0.39.0, staged by the unchanged checksum-verifying stage-qsmxt.mjs against packages/qsmbly/qsmxt.json.

Commands (repository root):
```sh
pnpm --filter qsmbly build
node packages/qsmbly/validation/browser-reference.mjs --output parity-4276acff-20261104/browser
node packages/qsmbly/scripts/stage-qsmxt.mjs
node packages/qsmbly/validation/cli-check.mjs --output parity-4276acff-20261104/native-retry
```
Build passed. Browser recording passed in 116 seconds. Initial native attempt failed ENOENT before staging; retry reconstructed successfully but FAILED the unchanged numerical gate:
```json
{
  "seconds": 106,
  "metrics": {
    "identical": false,
    "maskVoxelRatio": 1.001523,
    "supportRatio": 1.087443,
    "blocksCompared": 1,
    "blockCorrelation": 0.983685,
    "blockRmsPpm": 0.001756,
    "blockMaxAbsPpm": 0.01,
    "meanDifferencePpm": 0,
    "sdRatio": 1.146517,
    "percentileMaxAbsPpm": 0.010132
  }
}
```
Six violations: support ratio, block correlation, block RMS, block maximum difference, SD ratio, percentile difference. See [native-parity.log](native-parity.log) for exact bounds and assertion. No tolerance, contract, or native-version changes.

The mask voxel ratio is near unity but support and susceptibility differ materially. Native pipeline_config.toml records legacy phase_offset_sigma and pad_mm=16. The browser uses core v0.40 defaults. Default drift is a plausible explanation, not an isolated causal finding. Exact-source validation requires the user's policy decision; this failed run does not justify changing acceptance.

The genuine browser record is retained locally at parity-4276acff-20261104/browser-reference.failed-parity.json, with NIfTI outputs in browser/. Its inherited observed field is OLD evidence retained by the recording script, NOT evidence for this run. The tracked accepted reference was restored unchanged to avoid publishing misleading compatibility. Native actual outputs, pipeline configuration and qsmxt.log remain under native-retry/out/derivatives/qsmxt/. Large scientific data remain off git per AGENTS.md.

Metadata F1: upstream-citations.json and registry/apps.yml both record dab1846f41d69af9111ffa91d21457a1cf40f4d7; upstream.json now agrees and its previousCommit is the prior 0b6e3d3. F2: Cargo.toml pins 999445010a067d9597299f217a9a1165d4b7d62d; changeset now identifies that actual pin.

Artifact investigation: downloaded job 126381323761 logs confirm 26,582,755-byte DL WASM exceeds 26,214,400-byte cap. Local production baseline is 26,535,267 bytes. Separate wasm-opt -Oz experiment retains --enable-threads --enable-bulk-memory --enable-mutable-globals --enable-simd. Result: 24,816,687 bytes, below the unchanged cap. Node WebAssembly.compile succeeds and imports/exports match the baseline exactly. bash -n passes. The build now applies this measured pass only to the DL bundle after wasm-pack; no feature removed. Subsequent fixed-input xQSM inference checks using CI Binaryen 117 produced finite, byte-identical 32³ outputs for whole-volume and tiled execution before and after optimization. The optimized artifact was 24,817,740 bytes and passed the package audit. These synthetic single-thread checks do not cover other models or clinical geometries; multi-pool browser threading validation remains outstanding.

## Evidence locations

The commands above create local scratch output directories; these datasets and model files are deliberately not committed. The relative scratch paths in this report describe reproduction outputs, not repository links. The committed [browser log](browser.log) records the temporary measurement; its reference was restored after the native comparison failed. Log paths below are normalized to `<repository>` for portability; numerical results are unchanged. The accepted reference remains unchanged.
