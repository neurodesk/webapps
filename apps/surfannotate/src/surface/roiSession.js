// Drawing state for one loaded surface.
//
// The clicked vertices are the only authoritative state. The densified boundary
// chain and the filled mask are always derived, never edited in place. freeview
// does the opposite — its "make path" step overwrites the click list with the
// densified path — which is exactly what makes undo impossible there.
//
// Recomputing from scratch is affordable because segments are memoised: undoing
// one click invalidates one segment, not the whole boundary.

import { buildChain, validateChain } from './pathfinder.js';
import { fillClosedRegion, maskToIndices, regionComponents, componentMask } from './fill.js';
import { buildEdgeAnchor, anchorChainToEdge } from './edgeAnchor.js';

export const MODE_ROI = 'roi';
export const MODE_POINTS = 'points';

/** How the border was closed. */
export const CLOSURE_LOOP = 'loop';
export const CLOSURE_EDGE = 'edge';

export class RoiSession {
  /**
   * @param {import('./adjacency.js').SurfaceGraph} graph
   * @param {import('./pathfinder.js').SurfacePathfinder} finder
   * @param {Float32Array} vertices geometry used for interior detection
   * @param {object} [options]
   * @param {Uint8Array} [options.openEdge] vertices on an open edge of the mesh,
   *   from `findBoundaryVertices`. Present only for cut surfaces such as flat
   *   patches, and what makes `closeOnEdge` available.
   */
  constructor(graph, finder, vertices, options = {}) {
    this.graph = graph;
    this.finder = finder;
    this.vertices = vertices;
    this.openEdge = options.openEdge || null;

    this.mode = MODE_ROI;
    this.clicks = [];
    this.closed = false;
    this.closure = null;
    this.chain = new Int32Array(0);
    this.gaps = [];
    this.filled = null;
    this.fillError = null;
    this.components = 0;
    this.points = [];

    // Candidate regions for an edge closure: component ids ordered smallest
    // first, and which of them is currently filled.
    this.regionOrder = [];
    this.regionIndex = -1;

    this._segmentCache = new Map();
    this._regions = null;
    this._anchor = null;
  }

  /** True when this surface is cut, so closing against the edge is possible. */
  get hasOpenEdge() {
    return Boolean(this.openEdge);
  }

  /**
   * Point this session at a different surface that shares the same vertex
   * indexing — `lh.white` and `lh.inflated` of one subject, say.
   *
   * The clicks survive, because a click is a vertex index and that index means
   * the same vertex on either surface. Everything derived from them does not:
   * the shortest path between two vertices runs differently over inflated
   * geometry than over folded geometry, so the traced border and the fill are
   * discarded and must be rebuilt. That is a real difference, not a limitation
   * — the border genuinely is a different set of vertices on the two surfaces.
   *
   * @param {import('./adjacency.js').SurfaceGraph} graph
   * @param {import('./pathfinder.js').SurfacePathfinder} finder
   * @param {Float32Array} vertices
   * @param {object} [options]
   * @param {Uint8Array} [options.openEdge]
   */
  rebind(graph, finder, vertices, options = {}) {
    if (graph.V !== this.graph.V) {
      throw new Error(
        `cannot rebind a session for ${this.graph.V} vertices onto ${graph.V}`
      );
    }
    this.graph = graph;
    this.finder = finder;
    this.vertices = vertices;
    this.openEdge = options.openEdge || null;
    this._segmentCache.clear();
    this._anchor = null;
    this._reopen();
  }

  setMode(mode) {
    if (mode !== MODE_ROI && mode !== MODE_POINTS) throw new Error(`unknown mode "${mode}"`);
    this.mode = mode;
  }

  // -- ROI boundary -------------------------------------------------------

  /**
   * Record a border point. Deliberately does NOT trace anything — the clicks
   * stand alone as markers until the user closes the ROI. Tracing as you go
   * means a path redrawn on every click, and a live preview that fights the
   * next click for the picker.
   *
   * @returns {boolean} true when the click changed anything
   */
  addClick(vertex) {
    if (vertex < 0 || vertex >= this.graph.V) return false;
    if (this.clicks.length && this.clicks[this.clicks.length - 1] === vertex) return false;
    this.clicks.push(vertex);
    this._reopen();
    return true;
  }

  undoClick() {
    if (!this.clicks.length) return false;
    this.clicks.pop();
    this._reopen();
    return true;
  }

  /**
   * Trace the shortest surface path through every click in order, join the last
   * back to the first, and validate the result. This is the only place a chain
   * is built.
   *
   * @returns {{ok: boolean, gaps: Array<[number, number]>, chainLength: number}}
   */
  closePath() {
    if (this.clicks.length < 3) {
      return { ok: false, gaps: [], chainLength: 0 };
    }
    this.closed = true;
    this.closure = CLOSURE_LOOP;
    this._recompute();
    const validation = validateChain(this.graph, this.chain);
    const ok = this.gaps.length === 0 && validation.ok;
    // Keep the partial chain and the gap list on failure — they are what the UI
    // reports back. Only the "this is closed" claim is retracted.
    if (!ok) {
      this.closed = false;
      this.closure = null;
    }
    return { ok, gaps: this.gaps, chainLength: this.chain.length };
  }

  /**
   * Close the border against the cut edge of the surface instead of looping it
   * back to the first click.
   *
   * The clicks are traced in order as an open line, then each end is run out to
   * the nearest edge vertex. Nothing is traced *along* the edge: the edge is
   * already impassable to flood fill, so the line plus the cut enclose a region
   * between them. That is the whole point of the mode — on a flat patch the ROI
   * border is often mostly the patch edge, and clicking along it by hand both
   * takes many clicks and lands the border off the true cut.
   *
   * Two clicks are enough here, where a loop needs three.
   *
   * @returns {{ok: boolean, error: string|null, gaps: Array<[number, number]>,
   *   chainLength: number, regions: number}}
   */
  closeOnEdge() {
    const fail = (error, gaps = []) => {
      this._reopen();
      this.gaps = gaps;
      return { ok: false, error, gaps, chainLength: 0, regions: 0 };
    };

    if (!this.openEdge) return fail('NO_OPEN_EDGE');
    if (this.clicks.length < 2) return fail('TOO_FEW_CLICKS');

    if (!this._anchor) this._anchor = buildEdgeAnchor(this.graph, this.openEdge);

    const traced = buildChain(this.finder, this.clicks, {
      closed: false,
      cache: this._segmentCache
    });
    if (traced.gaps.length) return fail('BROKEN_BOUNDARY', traced.gaps);

    const anchored = anchorChainToEdge(this._anchor, traced.chain);
    if (!anchored.ok) return fail('EDGE_UNREACHABLE');

    if (!validateChain(this.graph, anchored.chain).ok) return fail('BROKEN_BOUNDARY');

    // Unlike a loop, an edge-anchored line is not guaranteed to separate
    // anything: a line joining two *different* cuts — the outer edge and the rim
    // of a hole — turns an annulus into a disk without dividing it. Cheaper and
    // far more reliable to ask the graph than to reason about the topology.
    const barrier = new Uint8Array(this.graph.V);
    for (const v of anchored.chain) barrier[v] = 1;
    const regions = regionComponents(this.graph, barrier);
    if (regions.count < 2) return fail('NO_SEPARATION');

    this.chain = anchored.chain;
    this.gaps = [];
    this.closed = true;
    this.closure = CLOSURE_EDGE;
    this._regions = regions;
    return {
      ok: true,
      error: null,
      gaps: [],
      chainLength: this.chain.length,
      regions: regions.count
    };
  }

  /**
   * Take a border that was traced earlier — on this surface, or on another
   * one sharing its vertex indexing — instead of re-tracing it from the
   * clicks.
   *
   * This is what makes an ROI the same set of vertices on lh.sphere.reg,
   * lh.inflated and lh.white: the fill is purely topological, so given the
   * same barrier and the same anchor it gives the same region on all three,
   * whereas a shortest path between two clicks genuinely runs differently
   * over different geometry and would enclose a different region — or, on a
   * folded surface, none. The clicks stay the editable form; reopening
   * re-traces on the surface shown.
   *
   * Refused, and nothing changed, when the border is not walkable here:
   * a vertex out of range or cut out of the graph (a neighbouring ROI now
   * owns it), two consecutive vertices no longer adjacent, a loop that does
   * not close, or an edge border that no longer separates the surface.
   *
   * @param {ArrayLike<number>} chain
   * @param {string} closure CLOSURE_LOOP or CLOSURE_EDGE
   * @returns {{ok: boolean, error: string|null}}
   */
  adoptChain(chain, closure) {
    const adopted = Int32Array.from(chain);
    if (adopted.length < 2) return { ok: false, error: 'BROKEN_BOUNDARY' };
    const { adjOffset } = this.graph;
    for (const v of adopted) {
      if (v < 0 || v >= this.graph.V || adjOffset[v] === adjOffset[v + 1]) {
        return { ok: false, error: 'BROKEN_BOUNDARY' };
      }
    }
    if (!validateChain(this.graph, adopted).ok) return { ok: false, error: 'BROKEN_BOUNDARY' };

    let regions = null;
    if (closure === CLOSURE_EDGE) {
      if (!this.openEdge) return { ok: false, error: 'NO_OPEN_EDGE' };
      const barrier = new Uint8Array(this.graph.V);
      for (const v of adopted) barrier[v] = 1;
      regions = regionComponents(this.graph, barrier);
      if (regions.count < 2) return { ok: false, error: 'NO_SEPARATION' };
    } else {
      const first = adopted[0];
      const last = adopted[adopted.length - 1];
      if (first !== last && !validateChain(this.graph, [last, first]).ok) {
        return { ok: false, error: 'BROKEN_BOUNDARY' };
      }
    }

    this.chain = adopted;
    this.gaps = [];
    this.closed = true;
    this.closure = closure;
    this.filled = null;
    this.fillError = null;
    this.components = 0;
    this.regionOrder = [];
    this.regionIndex = -1;
    this._regions = regions;
    return { ok: true, error: null };
  }

  /** Editing the clicks invalidates any traced boundary and fill. */
  _reopen() {
    this.closed = false;
    this.closure = null;
    this.chain = new Int32Array(0);
    this.gaps = [];
    this.filled = null;
    this.fillError = null;
    this.components = 0;
    this.regionOrder = [];
    this.regionIndex = -1;
    this._regions = null;
  }

  clearRoi() {
    this.clicks = [];
    this._reopen();
    this._segmentCache.clear();
  }

  /** The boundary as a mask, for rendering and for the fill barrier. */
  boundaryMask() {
    const mask = new Uint8Array(this.graph.V);
    for (const v of this.chain) mask[v] = 1;
    return mask;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.seed] interior vertex; omit for automatic detection
   * @param {boolean} [options.includeBoundary]
   * @param {number} [options.region] for an edge closure, which candidate region
   *   to take: an index into `regionOrder`. Defaults to the smallest.
   * @returns {{ok: boolean, error: string|null, count: number, components: number}}
   */
  fill(options = {}) {
    if (!this.closed) {
      this.fillError = 'NOT_CLOSED';
      return { ok: false, error: 'NOT_CLOSED', count: 0, components: 0 };
    }
    const validation = validateChain(this.graph, this.chain);
    if (!validation.ok) {
      this.fillError = 'BROKEN_BOUNDARY';
      return { ok: false, error: 'BROKEN_BOUNDARY', count: 0, components: 0 };
    }

    const seed = options.seed ?? -1;
    if (this.closure === CLOSURE_EDGE && seed < 0) {
      return this._fillEdgeRegion(options);
    }

    const result = fillClosedRegion(this.graph, this.boundaryMask(), {
      seed,
      vertices: this.vertices,
      includeBoundary: options.includeBoundary ?? false
    });

    this.filled = result.inside;
    this.fillError = result.error;
    this.components = result.components;
    this.regionOrder = [];
    this.regionIndex = -1;
    return {
      ok: result.error === null,
      error: result.error,
      count: result.count,
      components: result.components
    };
  }

  /**
   * Fill one of the pieces the edge-anchored border cut the surface into.
   *
   * Smallest first. On a flat patch an ROI delineated against the cut — V1, MT
   * — is the strip between the drawn line and the nearby stretch of edge, and
   * the rest of the patch is the remainder; the ROI is the smaller piece
   * essentially every time. When it is not, `nextRegion()` steps to the next
   * one, which is one click rather than a re-draw.
   *
   * Note there is no 40%-of-the-surface refusal here, unlike the loop
   * strategies. That guard exists to catch a fill that leaked through a gap, and
   * a leak is not possible once the barrier has been shown to separate the graph
   * — `closeOnEdge` establishes exactly that. Refusing a large region here would
   * only block the legitimate case of a border that halves the patch.
   */
  _fillEdgeRegion(options = {}) {
    const regions = this._regions || regionComponents(this.graph, this.boundaryMask());
    this._regions = regions;

    if (regions.count === 0) {
      this.filled = null;
      this.fillError = 'EMPTY_REGION';
      return { ok: false, error: 'EMPTY_REGION', count: 0, components: 0 };
    }

    this.regionOrder = regions.sizes
      .map((size, id) => ({ size, id }))
      .sort((a, b) => a.size - b.size || a.id - b.id)
      .map((entry) => entry.id);

    const requested = options.region ?? 0;
    this.regionIndex = Math.min(Math.max(requested, 0), this.regionOrder.length - 1);

    // A vertex known to have been inside this region last time beats the
    // size ordering, which shifts as neighbouring ROIs grow and shrink.
    const prefer = options.preferVertex ?? -1;
    if (prefer >= 0 && prefer < regions.labels.length) {
      const component = regions.labels[prefer];
      const position = component >= 0 ? this.regionOrder.indexOf(component) : -1;
      if (position >= 0) this.regionIndex = position;
    }

    const { mask, count } = componentMask(regions.labels, this.regionOrder[this.regionIndex]);
    let total = count;
    if (options.includeBoundary) {
      for (const v of this.chain) {
        if (!mask[v]) { mask[v] = 1; total++; }
      }
    }

    this.filled = mask;
    this.fillError = null;
    this.components = 1;
    return {
      ok: true,
      error: null,
      count: total,
      components: 1,
      region: this.regionIndex,
      regions: this.regionOrder.length
    };
  }

  /**
   * Take the next candidate region of an edge closure — the "wrong side" undo.
   * @returns {object|null} the fill result, or null when there is nothing to
   *   switch to
   */
  nextRegion(options = {}) {
    if (this.closure !== CLOSURE_EDGE || this.regionOrder.length < 2) return null;
    const next = (this.regionIndex + 1) % this.regionOrder.length;
    return this._fillEdgeRegion({ ...options, region: next });
  }

  /** Vertices in the filled region, or the boundary when nothing is filled. */
  regionIndices() {
    if (this.filled) return maskToIndices(this.filled);
    return Int32Array.from(this.chain);
  }

  // -- Point selection ----------------------------------------------------

  /** Toggle: clicking an existing landmark removes it. */
  togglePoint(vertex, name = '') {
    const existing = this.points.findIndex((point) => point.vertex === vertex);
    if (existing >= 0) {
      this.points.splice(existing, 1);
      return { added: false, vertex };
    }
    this.points.push({ vertex, name: name || `p${this.points.length + 1}` });
    return { added: true, vertex };
  }

  undoPoint() {
    return this.points.pop() || null;
  }

  clearPoints() {
    this.points = [];
  }

  // -- internals ----------------------------------------------------------

  _recompute() {
    const result = buildChain(this.finder, this.clicks, {
      closed: this.closed,
      cache: this._segmentCache
    });
    this.chain = result.chain;
    this.gaps = result.gaps;
  }
}

/** Messages for the states the session can report. */
export const SESSION_ERRORS = Object.freeze({
  NOT_CLOSED: 'Close the ROI before filling.',
  BROKEN_BOUNDARY: 'The boundary has a gap — part of it could not be joined across the surface.',
  TOO_FEW_CLICKS: 'Place at least two border points before closing on the edge.'
});
