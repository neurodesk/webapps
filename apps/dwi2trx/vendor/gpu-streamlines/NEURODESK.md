# GPUStreamlines runtime source pin

This is the source of `@dipy/gpu-streamlines@0.1.0` from npm, under BSD-3-Clause
(`LICENSE`). The original package integrity is
`sha512-3zPjDQYdW8sdKv+w6GR1k+UWAkpmcS0yCHJXp5ac0k/C7ZQ4aQabmjhcQXMAgt3EVijD0H5jyqLATx38n7G+Bg==`.
`upstream-files.sha256.json` records the original 28 files before these changes.
The small sphere lookup table is the package's original `src/sphere.bin`.

Local changes:

- `src/dispatch.ts`, `src/tracker.ts`, `src/wgsl/boot.wgsl`: submit at most 16
  workgroups per physical GPU command, completing each command before submitting
  another. An appended workgroup-offset field restores the original logical
  workgroup ID for seed indexing and Philox initialization. Logical seed batches,
  count/generation algorithms and output order are unchanged.
  Completion is awaited before the offset is changed, and the host yields to
  UI/abort tasks. Cancellation is checked between commands; a cancelled logical batch is not
  committed. GPU command failures still reject through the existing host logic.
- `src/tracker.ts`: `TrackingParams.maxWorkgroupsPerDispatch` (default 16) sets the
  physical command size, and `TrackResult.deviceLost` tells a lost device apart from
  out-of-memory salvage. The app's hardware test runs the example with one command
  per pass and with the default, and requires the same TRX bytes.
- `src/wgsl/boot.wgsl`, `src/tracker.ts`: both Boot kernels assume each tidy row is
  one 32-lane subgroup whose lane IDs equal `tid.x` (their shuffles, ballots and the
  removed `subgroupBarrier()` calls depend on it). WGSL allows other sizes (Intel
  8/16/32, AMD 64). `getTrackingDevice` refuses an adapter whose subgroup range
  excludes 32, and each kernel checks the layout it was compiled with: a mismatched
  workgroup writes -1 instead of tracking, and the host throws. On a matching GPU the
  check changes no output. `e2e/subgroups.spec.js` runs it on SwiftShader's 4-lane
  subgroups.
- `src/wgsl/boot.wgsl`, `src/tracker.ts`: Philox streams are indexed by a seed's
  position in the whole run, not in its batch. Upstream advances `rng_offset` on the
  host but neither kernel read it, so every 10,000-seed batch reused the first
  batch's streams, and the out-of-memory retry with smaller batches changed which
  stream each seed got. Both passes now receive the batch's first seed index as
  `rng_offset` and use `(rng_offset + seed in batch) * 32 + lane`. The first batch
  is unchanged, so runs of up to 10,000 seeds give the same bytes; larger runs
  change from the second batch on. The app's hardware test requires the same TRX
  with one batch and with four.
- `src/trx.ts`: fixed local DOS timestamp (1980-01-01) for deterministic ZIP bytes;
  geometry, member order and uncompressed payload are unchanged.
- `package.json`: include the new dispatcher and this provenance, and pin the
  existing fflate dependency exactly to 0.8.3.

The bounded commands address the generation watchdog observed in issue #598:
<https://github.com/neurodesk/webapps/actions/runs/40118569486>. The original
5,000-workgroup count pass completed; the generation command timed out on Metal.
The 16-workgroup setting still requires the hardware regression to complete; a
source change alone is not evidence of hardware success or Intel portability.

The full real-data hardware regression requires all selected seeds, no truncation
or cap, finite TRX coordinates, matching output counts, and no unexpected device
loss. A separate hardware probe uses the actual parameter struct, index expressions,
Philox source and host dispatcher to require identical random streams across physical
window sizes. Node tests cover dispatch completion/order/cancellation and TRX ZIP
identity across clocks/time zones. Keep this vendored source pin until an upstream
release carries the fixes and passes those tests.
