# DWI2TRX device-loss investigation

Issue [#598](https://github.com/neurodesk/webapps/issues/598) reports Intel/Mesa
Vulkan device loss during tracking of real DWI. The smaller pinned 21-volume
example succeeds on the same host. A targeted Apple/Metal run also reproduces the failure.

The provisioned hardware regression in `apps/dwi2trx/e2e/real-data.spec.js` uses
Philips ds007522 sub-HML0001 ses-01 from the immutable URLs, byte sizes and SHA-256
pins in `validation/dwi-vendors/sources.json`. It takes the central 72×72×39 crop
(origin 28,28,15) of the 128×128×69 grid, retaining all 136 frames. This matches a
reported failing **shape**; the report does not specify its crop origin. There is
no resampling. Values use the same scaled float32 representation the app reads;
the translated oblique affine and original gradient table are retained.

The crop requires about 110 MB of signal storage, rather than the full source's
615 MB. Passing this test does not establish full-size input support. CI provisions
it through `DWI2TRX_REAL_DWI_DIR` on the hardware-GPU runner. The test requires all
selected seeds to complete, rejects capped or truncated results, validates finite
TRX coordinates and output counts, rejects unexpected device loss, and performs
fresh device buffer IO afterward. The app intentionally destroys its private
tracking device when processing ends; that explicit destruction is allowed.

## Reproduced command timeout

The [baseline Metal diagnostic](https://github.com/neurodesk/webapps/actions/runs/40118569486)
records the initial count dispatch (`getNumStreamlinesBoot_k`, 5,000 workgroups)
and its successful 40,004-byte offsets readback after about 1.23 seconds. The
subsequent generation dispatch (`genStreamlinesMergeBoot_k`, 5,000 workgroups)
fails while reading its 385,680-byte streamline metadata after about 92.08
seconds. These are diagnostic timestamps, not benchmark results. The adapter is
Apple hardware, not a fallback adapter. Its exact device-loss message begins:

```text
Metal command buffer failed: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout) (domain=MTLCommandBufferErrorDomain, code=2)
```

This establishes a generation-command watchdog failure, rather than an initial
count-pass failure or an Intel-only limitation. The diagnostic saves dispatch
entry points, workgroup counts, readback source labels, device-loss messages and a
Playwright trace.

## Bounded physical commands

The local source pin at `apps/dwi2trx/vendor/gpu-streamlines` limits both passes
to 16 workgroups per command, waits for completion before changing the parameter
buffer, and yields to UI/abort tasks between commands. A 10,000-seed logical batch
uses 5,000 logical workgroups, hence 313 submissions per pass. The additional
submissions/yields are a deliberate overhead tradeoff against long uninterruptible
commands; no timing or speedup claim is made. One physical command still cannot be
interrupted. The successful Metal crop below validates this setting for that
case, not as a universal driver guarantee.

The logical seed batch remains 10,000. Merely shrinking it would change the old
random-stream mapping: the shader ignores its existing `rng_offset` field and
uses batch-local workgroup/seed/lane indices. The new, appended workgroup-offset
field restores those original indices inside each physical command for both seed
lookups and Philox initialization. It does not reinterpret `rng_offset`, alter
tracking steps/attempts, reduce the number of selected seeds, or change the output
order. Source pin provenance and original file hashes are recorded in the vendor
README and manifest. The same source pin also fixes TRX ZIP timestamps so equal
scientific outputs have equal archives; uncompressed member data is unchanged.

Node tests verify complete ordered workgroup coverage, parameter-buffer lifetime,
partition-invariant lane IDs, failure propagation and queued cancellation,
including cancellation at the final window. A hardware probe loads the actual
Boot parameter struct, workgroup/index/Philox expressions, RNG implementation and
host dispatcher to compare random streams across window sizes 37, 16, 7 and 1.
The real-data regression additionally requires all tracking commands to respect
the 16-workgroup bound while retaining the logical 10,000-seed batch.

## Observed Metal result

The [patched run](https://github.com/neurodesk/webapps/actions/runs/40122075751),
checkout `fbd95d5b0cc35428044805452ad9fa4635e7a6b1`, passed both hardware tests on
an Apple adapter with `isFallbackAdapter=false`. The actual Philox probe produced
identical 4,736-element uint32 results for physical window sizes 37, 16, 7 and 1.
Their little-endian SHA256 is
`48a038b2b160687cd7600901bfdcf5427622fb62634b8fa644a631572d84d4e8`.
This validates partition-invariant RNG initialization for the exercised shader
indices; it is not an independent biological validation of the tractography.

The same Philips crop (`58b21311677e3d35a6260618054a4517ebebfbaf711598c5d4d885eb16981f86`)
completed with these observed results:

| Check | Result |
| --- | --- |
| Selected / processed seeds | 51,129 / 51,129 |
| Logical batches | 10,000 × 5, then 1,129 |
| Retained streamlines / points | 236,088 / 23,306,894 |
| Capped / truncated / partial | false / false / false |
| Logical chunk size / RNG seed | 10,000 / 0 |
| Physical count / generation commands | 1,601 / 1,601 |
| Workgroups per command | at most 16 |
| Failed readbacks / unexpected device losses | 0 / 0 |
| Fresh-device buffer read after tracking | `0x12345678` |

The dispatch histogram is 3,190 commands of 16 workgroups, ten of eight, and two
of five, across both passes. All six offsets readbacks and all six streamline
metadata readbacks completed. Their offsets-buffer lengths independently account
for all 51,129 seeds. The first batch allocated 48,210 candidate streamlines,
matching the baseline's aggregate count; the failed baseline supplies no complete
trajectories for comparison. The test also checked the downloaded TRX hash, header
counts, and every world-coordinate value for finiteness. The resulting archive
is 280,627,677 bytes, SHA256
`b7893c40e81e7060e6ec3d6e5bfe812354bff66a3835a7d9dea7b70bacb36904`.
The artifact `dwi2trx-tracking-diagnostic` preserves `gpu-dispatches.json` and both
Playwright traces. Diagnostic/test duration is not reported as a benchmark or
speedup. The baseline never completed generation, so it supplies no complete
tractogram against which to claim full-output equality.

This passes the reproduced **Metal crop** failure. It does not establish support
for the full 615 MB source or the original Intel/Mesa device. Source review also
identified a fixed 32-lane subgroup assumption and removed subgroup barriers.
WGSL does not guarantee that width or the mapping from local invocation IDs to
subgroup lane IDs ([WGSL §15.5](https://www.w3.org/TR/WGSL/#subgroups)); the bounded
commands do not establish resolution of those portability questions. Intel/Mesa
and full-size validation remain separate open limits.

## Status after the November fixes

On 11 November 2026 the full-size Philips series (67,354 seeds) tracked to
completion on the Intel Arc 140V host with Mesa 26.2.6 and the default xe
timeouts, after #757 bounded each generation command to 32 tracking steps per
seed. Two runs on different builds gave the same TRX (sha256
`b19e0cde406dee93258d03d0d7c10bf9a47d9d0e45c2d3ce79a3e81b4abede4e`). The remaining
limits are handled as follows.

- **Subgroup size.** Intel reports subgroups of 16 to 32 lanes, and nothing made
  the compiler choose 32. When the device offers WebGPU's `subgroup-size-control`
  feature, the tracker now requests it and compiles both Boot entry points with
  `@subgroup_size(32)`. On Vulkan that sets `requiredSubgroupSize` and full
  subgroups. Without the feature, the adapter check and the in-kernel layout check
  stay the only guards. The run's provenance records, for every device that
  tracked, the GPU vendor, its architecture and whether the size was pinned
  (`tracking.gpus`).
- **Device loss.** When the device is lost mid-run, the tracker requests a new
  device, uploads the inputs again and reruns the interrupted seed batch. It makes
  at most two attempts per run, including a replacement lost during the upload.
  If no replacement works, it keeps the batches already read back, as before.
  Random streams follow a seed's position in the run (#653), so on the same GPU
  the rerun writes the bytes the lost device would have. A replacement on another
  adapter, possible on a computer with two GPUs, can round differently;
  `tracking.gpus` shows it. The hardware test destroys the tracking device during
  the first generation pass and requires the same TRX. The run reports the count
  as `measurements.deviceRecoveries`. This also covers a
  transient hang such as the 29 October Metal `kIOGPUCommandBufferCallbackErrorHang`,
  which has not recurred in the nightlies since #633; its cause is still unknown.
- **Removed subgroup barriers.** WGSL has no `subgroupBarrier()`, so the kernels
  run without the barriers the CUDA original places between a lane's write to
  workgroup memory and another lane's read. The
  [WGSL memory model](https://www.w3.org/TR/WGSL/#memory-model) gives those
  accesses no ordering on any GPU, so correctness rests on observation: complete,
  deterministic runs on Apple (Metal) and Intel Arc (Mesa Vulkan), whose subgroups
  execute in lockstep. NVIDIA GPUs since Volta schedule lanes independently, so
  they are the most likely to differ. A workgroup barrier cannot replace the
  removed ones, because the kernels call them in control flow that differs between
  the two rows of a workgroup. No NVIDIA or AMD run has been checked; the
  `tracking.gpus` provenance identifies one.
