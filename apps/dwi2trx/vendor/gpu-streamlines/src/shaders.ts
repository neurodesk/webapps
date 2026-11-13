/**
 * WGSL shader assembly for the Boot/OPDT tracker.
 *
 * WGSL has no `#include`, so GPUStreamlines concatenates its shader sources in
 * dependency order and compiles one module (see `compile_program` in
 * `cuslines/webgpu/wg_direction_getters.py`). This reproduces that for the Boot
 * direction getter, which is self-contained (its own bindings + entry points)
 * and needs: foundation (globals, types, philox_rng) + utilities (utils,
 * warp_sort, tracking_helpers) + boot. The Prob/PTT path was never wired, so its
 * WGSL (generate_streamlines/ptt/disc) was removed — re-vendor it from the
 * reference GPUStreamlines if/when a second direction getter is added.
 *
 * Browser-only: `?raw` imports resolve under Vite, not under the Node test
 * runner, so this module is never imported by the headless golden tests.
 */

import boot from './wgsl/boot.wgsl?raw'
import globals from './wgsl/globals.wgsl?raw'
import philoxRng from './wgsl/philox_rng.wgsl?raw'
import trackingHelpers from './wgsl/tracking_helpers.wgsl?raw'
import types from './wgsl/types.wgsl?raw'
import utils from './wgsl/utils.wgsl?raw'
import warpSort from './wgsl/warp_sort.wgsl?raw'

// Dependency order, matching compile_program (foundation → utility → dg → kernel).
const BOOT_PARTS: ReadonlyArray<readonly [string, string]> = [
  ['globals.wgsl', globals],
  ['types.wgsl', types],
  ['philox_rng.wgsl', philoxRng],
  ['utils.wgsl', utils],
  ['warp_sort.wgsl', warpSort],
  ['tracking_helpers.wgsl', trackingHelpers],
  ['boot.wgsl', boot],
]

// Browser (Dawn/Tint) adaptations vs the wgpu-native (Naga) reference, all
// verified against the reference on the command line + a real-browser Dawn compile:
//   1. `enable subgroups;` — Tint REQUIRES the directive to use subgroup
//      builtins; Naga forbids it (enables them via the device feature alone).
//   2. `diagnostic(off, subgroup_uniformity)` — Tint's uniformity analysis
//      can't prove the (genuinely subgroup-uniform) reduction results feeding
//      subgroupBroadcastFirst/Shuffle are uniform; Naga doesn't analyse this.
//   3. one 32-lane row per workgroup instead of two, with workgroupBarrier()
//      where the reference has subgroupBarrier(), which WGSL lacks (#598). The
//      barrier then orders the row's workgroup memory on every GPU, including
//      ones whose lanes are not in lockstep (NVIDIA Volta and later). Values the
//      barriers branch on pass through workgroup_uniform_i32 (utils.wgsl) so
//      Tint's uniformity analysis accepts them.
// (globals.wgsl's REAL_MAX literal was also nudged to a representable f32.)
//   4. with the `subgroup-size-control` feature, `@subgroup_size(32)` on both
//      entry points: Vulkan then compiles them with requiredSubgroupSize 32 and
//      full subgroups, so a GPU offering 8-32 lanes (Intel) cannot pick 16 (#598).
const BROWSER_PREAMBLE =
  'enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n'

const ENTRY_ATTRIBUTE = '@compute @workgroup_size(32, 1, 1)'

/** Concatenated WGSL source for the Boot/OPDT shader module (browser-adapted).
 *  `subgroupSize` pins the entry points' subgroup size; it needs a device with
 *  the `subgroup-size-control` feature. */
export function bootShaderSource(subgroupSize?: number): string {
  let body = BOOT_PARTS.map(([name, src]) => `// ── ${name} ──\n${src}`).join('\n')
  if (subgroupSize === undefined) return BROWSER_PREAMBLE + body
  const entries = body.split(ENTRY_ATTRIBUTE).length - 1
  if (entries !== 2) throw new Error(`Expected 2 Boot entry points, found ${entries}.`)
  body = body.replaceAll(ENTRY_ATTRIBUTE, `@subgroup_size(${subgroupSize})\n${ENTRY_ATTRIBUTE}`)
  return `${BROWSER_PREAMBLE}enable subgroup_size_control;\n${body}`
}

/** Boot kernel entry points (pass 1 counts streamlines, pass 2 generates them). */
export const BOOT_ENTRY_GETNUM = 'getNumStreamlinesBoot_k'
export const BOOT_ENTRY_GEN = 'genStreamlinesMergeBoot_k'
