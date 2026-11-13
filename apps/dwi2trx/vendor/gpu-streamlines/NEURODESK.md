# GPUStreamlines runtime source pin

This is the source of `@dipy/gpu-streamlines@0.1.0` from npm, under BSD-3-Clause
(`LICENSE`). The original package integrity is
`sha512-3zPjDQYdW8sdKv+w6GR1k+UWAkpmcS0yCHJXp5ac0k/C7ZQ4aQabmjhcQXMAgt3EVijD0H5jyqLATx38n7G+Bg==`.
`upstream-files.sha256.json` records the original 28 files before these changes.
The small sphere lookup table is the package's original `src/sphere.bin`.

Local changes:

- `src/dispatch.ts`, `src/tracker.ts`, `src/wgsl/boot.wgsl`: submit at most 32
  workgroups (32 seeds) per physical GPU command, completing each command before submitting
  another. An appended workgroup-offset field restores the original logical
  workgroup ID for seed indexing and Philox initialization. Logical seed batches,
  count/generation algorithms and output order are unchanged.
  Completion is awaited before the offset is changed, and the host yields to
  UI/abort tasks. Cancellation is checked between commands; a cancelled logical batch is not
  committed. GPU command failures still reject through the existing host logic.
- `src/tracker.ts`: `TrackingParams.maxWorkgroupsPerDispatch` (default 32) sets the
  physical command size, and `TrackResult.deviceLost` tells a lost device apart from
  out-of-memory salvage. The app's hardware test runs the example with one command
  per pass and with the default, and requires the same TRX bytes.
- `src/wgsl/boot.wgsl`, `src/tracker.ts`: both Boot kernels assume each tidy row is
  one 32-lane subgroup whose lane IDs equal `tid.x` (their shuffles and ballots
  depend on it). WGSL allows other sizes (Intel
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
- `src/wgsl/boot.wgsl`, `src/dispatch.ts`, `src/tracker.ts`: the generation kernel
  pauses after `TrackingParams.maxStepsPerDispatch` (default 32) tracking steps per
  seed and saves where each seed stopped: its direction, phase, step, point, heading
  and each lane's Philox state, after the per-seed offsets in `slineOutOff` (no new
  binding). The host repeats the generation pass over the windows that still have
  unfinished seeds. On Intel Arc 140V with Mesa 26.2, a 16-workgroup command took
  about 0.86 s and one workgroup alone ran past the GuC's 640 ms preemption timeout,
  which reset the GPU (#598). The steps, their order and the random draws are
  unchanged; upstream's `tracker_boot` loop became the kernel's step loop. The app's
  hardware test requires the same TRX with one unbounded command per pass and with
  the defaults, and a nightly test with 3 steps per command.
- `src/shaders.ts`, `src/tracker.ts`: on a device with `subgroup-size-control`,
  `getTrackingDevice` requests the feature and both entry points are compiled with
  `@subgroup_size(32)` (Vulkan `requiredSubgroupSize` with full subgroups), so a GPU
  that offers 16 to 32 lanes cannot run them at 16. Other devices keep the checks
  above. Output on a 32-lane GPU is unchanged.
- `src/wgsl/*.wgsl`, `src/shaders.ts`, `src/globals.ts`: each workgroup is one
  32-lane row (`@workgroup_size(32, 1, 1)`, `BLOCK_Y` 1) instead of two, and every
  `subgroupBarrier()` is a `workgroupBarrier()`. WGSL has no subgroup barrier, and
  the browser build used to strip them, which left each row's workgroup-memory
  traffic unordered on GPUs whose lanes are not in lockstep (NVIDIA Volta and
  later, #598). Values the barriers branch on (direction and peak counts, the
  interpolation and tissue results, the saved step state) pass through
  `workgroup_uniform_i32` (`utils.wgsl`), a `workgroupUniformLoad` of lane 0's value,
  so Tint's uniformity analysis accepts the barriers. Workgroup memory halves to
  about 10.4 KB. Seeds, Philox streams and the arithmetic are unchanged, so the TRX
  is the same bytes.
- `src/tracker.ts`: `trackStreamlines` takes an optional `replaceDevice`. When the
  device is lost it uploads the static inputs to the replacement and reruns the
  interrupted batch, within `MAX_DEVICE_RECOVERIES` (2) attempts per run, and
  reports successful replacements as `TrackResult.deviceRecoveries`. Without a
  working replacement it returns the batches already read back. Streams follow the
  run-wide seed index, so on the same GPU the output equals an uninterrupted run's;
  the app's hardware test destroys the device mid-generation and requires the same
  TRX.
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
