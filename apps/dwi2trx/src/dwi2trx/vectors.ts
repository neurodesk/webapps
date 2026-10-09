/**
 * Turn a diffusion sampling scheme into a NiiVue connectome (ball-only) so the
 * user can eyeball the distribution (whole- vs half-sphere, single- vs
 * multi-shell). Two entry points share one core: `buildGradientScheme` parses
 * FSL bval/bvec text (Show vectors); `buildSchemeFromSamples` takes structured
 * samples directly (the generator, no text round-trip).
 *
 * Pure + DOM/NiiVue-free so it unit-tests in plain node (see vectors.test.ts).
 * The geometry model (matching NiiVue's connectome `extrude`, radius =
 * |sizeValue| × nodeScale, colour = colormapLookup(colorValue, min, max)):
 *
 *   position   unit(dir) × √(b/bmax) — b0 at 0; strongest shell at radius 1
 *   radius     baseRadius × ∛N     — N identical samples ⇒ a node of N× the volume
 *   colour     bval on `actc` — b0 and shells span NiiVue's ACTC map
 *
 * baseRadius scales with the maximum plotted length so the balls stay visible
 * against the normalized field of view. Antipodal directions are kept DISTINCT on
 * purpose: seeing +v without −v is exactly how a half-sphere scheme reveals
 * itself. B-values are canonicalized first (below `B0_MAX_BVAL` ⇒ b0 at the
 * origin regardless of direction; otherwise snapped to `SHELL_TOL`) so acquisition
 * jitter (e.g. 1000 vs 1004) reads as one shell, not many.
 */

import { parseBvalBvec } from '@neurodesk/dwi2trx/gradients'

/** A raw diffusion sample: a direction (need not be unit) + its b-value. */
export interface Sample {
  x: number
  y: number
  z: number
  bval: number
}

/** One NiiVue connectome node (a ball). Matches NVConnectomeNode's shape. */
export interface GradientNode {
  name: string
  x: number
  y: number
  z: number
  colorValue: number
  sizeValue: number
}

/** A ball-only connectome plus a summary for the modal's caption. */
export interface GradientScheme {
  data: { nodes: GradientNode[]; edges: [] }
  options: {
    nodeColormap: string
    nodeColormapNegative: string
    nodeMinColor: number
    nodeMaxColor: number
    nodeScale: number
  }
  /** Total gradient directions (= sample count). */
  directions: number
  /** Distinct sample locations (nodes drawn). */
  nodes: number
  /** Largest canonical b-value (normalization reference and color maximum). */
  maxBval: number
  /** Per-shell counts, ascending by canonical b-value: `[bval, count]`. */
  shells: Array<[number, number]>
  /** Heuristic polarity coverage from the diffusion-vector mean. */
  coverage: 'whole sphere' | 'half sphere'
}

// Internal plotting policy: true reflects physical gradient amplitude
// |g|=√(b/bmax); false gives linear normalized b/bmax radii. This affects only
// preview geometry, never b-values, generated directions, or saved DVS files.
const SQRT_BVALUE_PLOT = true
// A single-sample ball spans ≈1/20 of the normalized maximum plotted radius:
// big enough to read at a glance without swamping neighbouring directions.
const RADIUS_DIVISOR = 20
// Below this bvec length a direction is treated as undefined (a b0): it collapses
// to the origin regardless of the selected normalized b-value transform.
const UNIT_EPS = 1e-6
// A sample at or below this b-value is a b0 (no diffusion direction).
const B0_MAX_BVAL = 50
// Canonical shell granularity: b-values are snapped to this so acquisition jitter
// (1000 vs 1004) collapses into one shell for keying, colour, and the summary.
const SHELL_TOL = 50

/** Snap a raw b-value to its canonical shell: 0 for a b0, else nearest SHELL_TOL. */
function canonBval(bval: number): number {
  if (bval <= B0_MAX_BVAL) return 0
  return Math.round(bval / SHELL_TOL) * SHELL_TOL
}

/**
 * Build the connectome from structured samples (directions need not be unit —
 * they are normalized here). The shared core behind both entry points.
 */
export function buildSchemeFromSamples(samples: Sample[]): GradientScheme {
  let maxBval = 0
  for (const s of samples) maxBval = Math.max(maxBval, canonBval(s.bval))
  // maxBval 0 (an all-b0 acquisition) would give a zero radius and a degenerate
  // colour range — fall back to 1 so a single origin node still draws.
  const baseRadius = maxBval > 0 ? 1 / RADIUS_DIVISOR : 1
  const plotLength = (bval: number): number => {
    if (bval <= 0 || maxBval <= 0) return 0
    const normalized = bval / maxBval
    return SQRT_BVALUE_PLOT ? Math.sqrt(normalized) : normalized
  }

  // Merge identical samples: key on canonical b-value + unit direction, so
  // repeated b0s (all at the origin, direction ignored) and repeated directions
  // collapse into one node whose count drives its radius. +v and −v get
  // different keys by design.
  interface Bucket {
    x: number
    y: number
    z: number
    bval: number
    count: number
  }
  const buckets = new Map<string, Bucket>()
  const shellCounts = new Map<number, number>()
  let directionSumX = 0
  let directionSumY = 0
  let directionSumZ = 0
  let diffusionDirections = 0
  for (const s of samples) {
    const cb = canonBval(s.bval)
    const norm = Math.hypot(s.x, s.y, s.z)
    if (cb > 0 && norm <= UNIT_EPS) {
      throw new Error(`b=${cb} sample has no diffusion direction.`)
    }
    const isB0 = cb <= 0
    const ux = isB0 ? 0 : s.x / norm
    const uy = isB0 ? 0 : s.y / norm
    const uz = isB0 ? 0 : s.z / norm
    const cbval = isB0 ? 0 : cb
    // A b0's key ignores direction, so every b0 (whatever its stored bvec) merges.
    const key = isB0
      ? 'b0'
      : `${cbval}|${ux.toFixed(3)}|${uy.toFixed(3)}|${uz.toFixed(3)}`
    const b = buckets.get(key)
    if (b) {
      b.count++
    } else {
      buckets.set(key, {
        x: ux * plotLength(cbval),
        y: uy * plotLength(cbval),
        z: uz * plotLength(cbval),
        bval: cbval,
        count: 1,
      })
    }
    shellCounts.set(cbval, (shellCounts.get(cbval) ?? 0) + 1)
    if (!isB0) {
      directionSumX += ux
      directionSumY += uy
      directionSumZ += uz
      diffusionDirections++
    }
  }

  const nodes: GradientNode[] = []
  for (const b of buckets.values()) {
    nodes.push({
      // Left empty on purpose: NiiVue builds a connectome legend from node
      // names (one row per node), which would be an unreadable 100+-row list.
      // The shell breakdown lives in the modal caption instead.
      name: '',
      x: b.x,
      y: b.y,
      z: b.z,
      colorValue: b.bval,
      // ∛N ⇒ node volume ∝ N (N identical samples read as N× the ball).
      sizeValue: baseRadius * Math.cbrt(b.count),
    })
  }

  return {
    data: { nodes, edges: [] },
    options: {
      nodeColormap: 'actc',
      nodeColormapNegative: '', // all b-values ≥ 0, no negative branch
      nodeMinColor: 0,
      nodeMaxColor: maxBval > 0 ? maxBval : 1,
      nodeScale: 1, // the modal's slider multiplies this
    },
    directions: samples.length,
    nodes: nodes.length,
    maxBval,
    shells: [...shellCounts.entries()].sort((a, b) => a[0] - b[0]),
    // A uniform hemisphere has mean-vector norm ≈0.5, while balanced
    // whole-sphere sampling approaches zero. Allow finite-sample variation.
    coverage:
      diffusionDirections > 0 &&
      Math.hypot(directionSumX, directionSumY, directionSumZ) /
        diffusionDirections >
        0.35
        ? 'half sphere'
        : 'whole sphere',
  }
}

/**
 * Build the sampling-scheme connectome from FSL-layout bval/bvec text. `bval` is
 * one row of N values; `bvec` is three rows (x/y/z) of N values. Throws a
 * caller-facing Error if the two are malformed, inconsistent, or contain a
 * negative b-value.
 */
export function buildGradientScheme(
  bvalText: string,
  bvecText: string,
): GradientScheme {
  const { bvals, bvecs } = parseBvalBvec(bvalText, bvecText)
  const [bx, by, bz] = bvecs
  const samples: Sample[] = bvals.map((bval, i) => ({
    x: bx[i],
    y: by[i],
    z: bz[i],
    bval,
  }))
  return buildSchemeFromSamples(samples)
}

/**
 * Return a copy of a preview scheme with every diffusion node mirrored to its
 * antipode (at half radius), so a viewer can show whole-sphere symmetry for a
 * half-sphere scheme. Non-mutating; b0 nodes (colorValue 0, at the origin) are
 * not mirrored. Preview-only — these mirrored nodes are for display and must not
 * be fed into any saved gradient scheme.
 */
export function withAntipodalNodes(scheme: GradientScheme): GradientScheme {
  const antipodes = scheme.data.nodes
    .filter((node) => node.colorValue > 0)
    .map((node) => ({
      ...node,
      x: -node.x,
      y: -node.y,
      z: -node.z,
      // NiiVue reads sizeValue as a radius; half it so mirrors read as secondary.
      sizeValue: node.sizeValue * 0.5,
    }))
  const nodes = [...scheme.data.nodes, ...antipodes]
  return {
    ...scheme,
    data: { nodes, edges: scheme.data.edges },
    nodes: nodes.length,
  }
}
