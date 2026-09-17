// A parcellation: an ordered list of ROIs that together partition the surface.
//
// Independent masks are the wrong model for delineating adjacent ROIs. V1 and
// V2 share a boundary, so moving it changes both — but with independent masks
// only the one being edited changes, and the other is left claiming vertices
// that are no longer its own, or leaving a strip that belongs to nobody.
//
// So an ROI is not a mask. An ROI is a *definition* — its border points, how
// they were closed, and which side was filled — and the masks are derived by
// resolving the whole list in order, each ROI cut out of the surface before the
// next one is resolved. Disjointness then holds by construction rather than by
// checking, and editing an ROI's border re-derives everything after it: shrink
// V1 and V2 grows into the space, because V2's border was always defined as
// "my line, and whatever lies between it and the ROI below me".
//
// This is the same rule the rest of the app already follows — the clicked
// vertices are the only authoritative state — applied one level up.

import { excludeVertices } from './exclude.js';
import { SurfacePathfinder } from './pathfinder.js';
import { RoiSession, CLOSURE_EDGE } from './roiSession.js';

/**
 * @typedef {object} RoiDefinition
 * @property {number} id
 * @property {string} name
 * @property {number[]} clicks         border points, in the order placed
 * @property {number[]} [border]       the border as traced when saved — a vertex
 *   path, so it means the same on every surface sharing the indexing
 * @property {string} closure          'loop' or 'edge'
 * @property {number} [regionIndex]    which side of an edge closure was taken
 * @property {number} [anchor]         a vertex that was inside the region
 * @property {boolean} [includeBoundary]
 */

/**
 * @typedef {object} ResolvedRoi
 * @property {Uint8Array|null} mask  null when the ROI could not be resolved
 * @property {string|null} error
 */

/**
 * Resolve definitions into disjoint regions, in order.
 *
 * Each ROI is drawn on a surface with every ROI before it cut away, which is
 * exactly the situation it was drawn in. An ROI that cannot be resolved — its
 * border points swallowed by an ROI now in front of it, say — is reported with
 * an error and claims nothing, rather than being silently dropped.
 *
 * @param {object} base
 * @param {import('./adjacency.js').SurfaceGraph} base.graph
 * @param {Float32Array} base.positions
 * @param {Uint8Array|null} base.openEdge the mesh's own cut, if it has one
 * @param {RoiDefinition[]} ROIs
 * @returns {{ROIs: Array<RoiDefinition & ResolvedRoi>, owner: Int32Array,
 *   assigned: number}} `owner` holds the id of the ROI owning each vertex, or
 *   -1 where nothing does.
 */
export function resolveParcellation(base, rois) {
  const V = base.graph.V;
  const owner = new Int32Array(V).fill(-1);
  const claimed = new Uint8Array(V);
  const resolved = [];
  let assigned = 0;

  for (const roi of rois) {
    const result = resolveRoi(base, claimed, roi);
    resolved.push(result);
    if (!result.mask) continue;
    for (let v = 0; v < V; v++) {
      if (!result.mask[v]) continue;
      owner[v] = roi.id;
      claimed[v] = 1;
      assigned++;
    }
  }

  return { rois: resolved, owner, assigned };
}

/**
 * Resolve one ROI against a surface with `claimed` already taken.
 *
 * Exported because the app needs the same "surface as this ROI sees it" when
 * the ROI is being drawn interactively, not only when the list is re-derived.
 *
 * @param {object} base
 * @param {Uint8Array} claimed vertices already belonging to an earlier ROI
 * @param {RoiDefinition} ROI
 * @returns {RoiDefinition & ResolvedRoi}
 */
export function resolveRoi(base, claimed, roi) {
  const cut = excludeVertices(base.graph, claimed, base.openEdge);
  const finder = new SurfacePathfinder(cut.graph, base.positions);
  const session = new RoiSession(cut.graph, finder, base.positions, {
    openEdge: cut.openEdge
  });

  for (const vertex of roi.clicks) session.addClick(vertex);
  if (session.clicks.length !== roi.clicks.length) {
    return { ...roi, mask: null, error: 'LOST_POINTS' };
  }

  // The saved border first: it is a vertex path, so it encloses the same
  // vertices on lh.sphere.reg, lh.inflated and lh.white alike, where a path
  // re-traced between the clicks would run differently on each. Re-tracing is
  // the fallback for when the saved border is no longer walkable — an ROI
  // above this one has cut through it — which is exactly the case where the
  // border has to find a new route anyway.
  let closed = null;
  if (roi.border && roi.border.length) {
    const adopted = session.adoptChain(roi.border, roi.closure);
    if (adopted.ok) closed = { ok: true, error: null };
  }
  if (!closed) {
    closed = roi.closure === CLOSURE_EDGE ? session.closeOnEdge() : session.closePath();
  }
  if (!closed.ok) {
    return { ...roi, mask: null, error: closed.error || 'BROKEN_BOUNDARY' };
  }

  const anchor = usableAnchor(cut.graph, session, roi.anchor);
  const filled = roi.closure === CLOSURE_EDGE
    ? session.fill({
      region: roi.regionIndex ?? 0,
      preferVertex: anchor,
      includeBoundary: roi.includeBoundary
    })
    : session.fill({ seed: anchor, includeBoundary: roi.includeBoundary });

  if (!filled.ok) {
    return { ...roi, mask: null, error: filled.error };
  }
  return { ...roi, mask: session.filled, error: null };
}

/** The stored anchor, if it is still a vertex this ROI could be filled from. */
function usableAnchor(graph, session, anchor) {
  if (anchor === undefined || anchor === null || anchor < 0 || anchor >= graph.V) return -1;
  if (graph.adjOffset[anchor] === graph.adjOffset[anchor + 1]) return -1; // cut away
  const boundary = session.boundaryMask();
  return boundary[anchor] ? -1 : anchor;
}

/**
 * A vertex deep inside a region, to recognise it by after the borders move.
 *
 * The furthest vertex from the border, by hop count, is the one most likely to
 * still be inside after an edit — a vertex near the border is exactly what a
 * neighbouring ROI takes when it grows.
 *
 * @param {import('./adjacency.js').SurfaceGraph} graph
 * @param {Uint8Array} mask
 * @param {Int32Array|number[]} border
 * @returns {number} -1 when the mask is empty
 */
export function anchorVertex(graph, mask, border) {
  const { V, adjOffset, adjNeighbor } = graph;
  const seen = new Uint8Array(V);
  const queue = new Int32Array(V);
  let head = 0;
  let tail = 0;

  for (const v of border) {
    if (v < 0 || v >= V || seen[v]) continue;
    seen[v] = 1;
    queue[tail++] = v;
  }
  // No border to measure from: any vertex will do.
  if (tail === 0) {
    for (let v = 0; v < V; v++) if (mask[v]) return v;
    return -1;
  }

  let deepest = -1;
  while (head < tail) {
    const u = queue[head++];
    if (mask[u]) deepest = u;
    for (let e = adjOffset[u]; e < adjOffset[u + 1]; e++) {
      const w = adjNeighbor[e];
      if (seen[w] || !mask[w]) continue;
      seen[w] = 1;
      queue[tail++] = w;
    }
  }
  if (deepest >= 0) return deepest;
  for (let v = 0; v < V; v++) if (mask[v]) return v;
  return -1;
}

/** Human-readable text for the states an ROI can end up in. */
export const ROI_ERRORS = Object.freeze({
  LOST_POINTS: 'Some of its border points now belong to an ROI above it in the list.',
  BROKEN_BOUNDARY: 'Its border could not be traced on the surface left to it.',
  NO_SEPARATION: 'Its border no longer encloses a region.',
  EMPTY_REGION: 'Its border encloses nothing that is still free.',
  FILL_ESCAPED: 'Its fill spread across the surface — the border is not closed.',
  AMBIGUOUS_REGION: 'Both sides of its border are large; it needs redrawing.',
  SEED_ON_BOUNDARY: 'Its interior point now sits on its border.'
});
