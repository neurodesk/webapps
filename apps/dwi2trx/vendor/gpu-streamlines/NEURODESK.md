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
  count/generation algorithms, output order and RNG policy are unchanged. In
  particular, the existing unused `rng_offset` field is not reinterpreted: making
  RNG independent of logical seed-batch size would be a separate scientific change.
  Completion is awaited before the offset is changed, and the host yields to
  UI/abort tasks. Cancellation is checked between commands; a cancelled logical batch is not
  committed. GPU command failures still reject through the existing host logic.
- `src/tracker.ts`: `TrackingParams.maxWorkgroupsPerDispatch` (default 16) sets the
  physical command size, and `TrackResult.deviceLost` tells a lost device apart from
  out-of-memory salvage. The app's hardware test runs the example with one command
  per pass and with the default, and requires the same TRX bytes.
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
