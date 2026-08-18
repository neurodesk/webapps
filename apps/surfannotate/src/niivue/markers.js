// The clicked border points and the landmarks, drawn in screen space.
//
// They used to be mesh label values: the clicked vertex and its whole 1-ring
// painted into the ROI layer. Three things were wrong with that, and all of
// them are properties of vertex colours rather than bugs to be fixed in place.
// A layer value is interpolated across the triangle, so a marker can only ever
// be a soft blob with no edge; its size is set by the mesh, so the same marker
// is a speck on a 160k-vertex pial and a splash on a decimated one; and a
// 1-ring is genuinely wider than the vertex it marks, which is why the markers
// had to be *hidden* once a region was filled — they overstated its extent.
//
// Projecting to the canvas instead fixes all three at once: a marker becomes a
// fixed number of pixels wide, with whatever outline we like, and it can no
// longer misrepresent anything because it is no longer painted on the surface.
//
// Pure, in the same sense as colorLegend.js: this module rasterises into a
// plain pixel buffer and never touches the DOM or NiiVue, so it unit-tests
// under `node --test` with the rest. The caller passes the matrices in and
// blits the sprite out.

/** Marker shapes. `dot` is filled; the other two are stroked. */
export const MARKER_DOT = 'dot';
export const MARKER_CIRCLE = 'circle';
export const MARKER_CROSS = 'cross';

/**
 * Core and rim, as [r, g, b].
 *
 * There is no "auto" here and no sampling of what lies underneath, because the
 * rim already answers that question: every marker is drawn as a light core
 * inside a dark halo (or the reverse), so it reads against dark curvature, a
 * bright overlay and a saved ROI's fill without being told which it is on. A
 * colour that had to be measured would also have to be re-measured on every
 * rotation, and would change under the user mid-drag. This cannot.
 *
 * The choice is therefore taste, not legibility, which is why the rim is not
 * configurable separately — it is whichever of black/white the core is not.
 */
export const MARKER_COLORS = {
  white: { core: [255, 255, 255], rim: [16, 16, 16] },
  black: { core: [16, 16, 16], rim: [255, 255, 255] },
  magenta: { core: [255, 43, 214], rim: [16, 16, 16] },
  yellow: { core: [255, 230, 0], rim: [16, 16, 16] }
};

/**
 * Project one point through a gl-matrix mat4.
 *
 * mat4 is column-major, so element m[4] is row 0 of column 1 — writing this
 * out row-wise silently transposes the rotation and sends every marker to the
 * wrong side of the surface.
 *
 * @param {ArrayLike<number>} mvp 16 elements, column-major
 * @returns {{x: number, y: number, z: number, w: number}} clip coordinates
 */
export function projectVertex(mvp, x, y, z) {
  return {
    x: mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12],
    y: mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13],
    z: mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14],
    w: mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
  };
}

/**
 * Which way a vertex faces, in eye space.
 *
 * NiiVue's model matrix mirrors x (`modelMatrix[0] = -1`), so it has a negative
 * determinant; the normal matrix is transpose(inverse(model)), which is exactly
 * the transform that keeps a normal on the same side of a mirrored surface as
 * the geometry.
 *
 * **An outward normal facing the viewer has a NEGATIVE eye-space z here**, which
 * is the opposite of the usual convention and is worth the paragraph. NiiVue
 * builds its projection with `mat4.ortho(..., near = scale * 8, far = scale *
 * 0.01)` — near *greater* than far. gl-matrix writes `out[10] = 2 / (near -
 * far)`, so that term comes out positive where a conventional ortho makes it
 * negative, which inverts the depth mapping and puts the viewer on the -z side.
 * Measured on a real click: the depth picker returns the front-most vertex by
 * construction, and its outward normal transforms to z = -0.52.
 *
 * Getting this backwards does not look like a bug. Every marker on the near
 * surface is dropped and every marker on the far side is drawn, and over the
 * silhouette of a hemisphere those land on plausible-looking cortex — it only
 * shows up as markers never appearing where you actually clicked.
 *
 * `orientation` flips the test when the normals point into the surface rather
 * than out of it — see surfaceOrientation.
 *
 * @param {ArrayLike<number>} normalMatrix 16 elements, column-major
 * @returns {boolean}
 */
export function isFacingViewer(normalMatrix, nx, ny, nz, orientation = 1) {
  const z = normalMatrix[2] * nx + normalMatrix[6] * ny + normalMatrix[10] * nz;
  return z * orientation < 0;
}

/**
 * +1 when the normals point out of the surface, -1 when they point into it.
 *
 * Measured from the normals themselves, never inferred from the triangle
 * winding. An earlier version did infer it — signed volume, which is a clean
 * fact about the winding — and it was wrong in a way that looked right:
 * `NVMeshUtilities.generateNormals` builds its normals as `(p3-p1) × (p2-p1)`,
 * the negation of the usual convention, so the sign was derived under one
 * convention and applied to an array built under another. Every marker on the
 * near surface was culled and every marker on the far side was drawn, which
 * over a hemisphere's silhouette is entirely plausible to look at.
 *
 * So: take the six axis-extreme vertices. The outward direction at the
 * furthest vertex along +x is +x, and so on round the six, whatever the mesh
 * is; summing `dot(normal, outward)` over them says which way the array points
 * without assuming any cross-product order, here or in a future NiiVue.
 *
 * Sound only for a closed surface, which is the only case it is asked about:
 * an open patch has no far side to hide a marker on, so the caller skips
 * culling entirely when `openEdge` is set.
 *
 * @param {Float32Array} positions 3 per vertex
 * @param {Float32Array} normals 3 per vertex, as they will be used
 * @returns {1|-1}
 */
export function surfaceOrientation(positions, normals) {
  const count = Math.min(positions.length, normals.length) / 3;
  if (count < 1) return 1;

  // extreme[axis] = [furthest along -axis, furthest along +axis]
  const extreme = [[0, 0], [0, 0], [0, 0]];
  const bound = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let v = 0; v < count; v++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[v * 3 + axis];
      if (value < bound[axis][0]) { bound[axis][0] = value; extreme[axis][0] = v; }
      if (value > bound[axis][1]) { bound[axis][1] = value; extreme[axis][1] = v; }
    }
  }

  let agreement = 0;
  for (let axis = 0; axis < 3; axis++) {
    // The -axis end points the other way, hence the sign.
    agreement -= normals[extreme[axis][0] * 3 + axis];
    agreement += normals[extreme[axis][1] * 3 + axis];
  }
  return agreement >= 0 ? 1 : -1;
}

/**
 * Project a list of vertices to canvas pixels, dropping the ones that cannot be
 * seen.
 *
 * @param {object} params
 * @param {ArrayLike<number>} params.mvp
 * @param {Float32Array} params.positions 3 per vertex
 * @param {ArrayLike<number>} params.vertices which vertices to place
 * @param {number} params.width canvas width in device pixels
 * @param {number} params.height canvas height in device pixels
 * @param {Float32Array} [params.normals] 3 per vertex; omit to skip culling
 * @param {ArrayLike<number>} [params.normalMatrix] required with `normals`
 * @param {1|-1} [params.orientation]
 * @param {number} [params.margin] how far off-canvas a marker may sit and still
 *   be kept, so one straddling the edge is not dropped mid-draw
 * @returns {Array<{vertex: number, x: number, y: number}>} in device pixels
 */
export function projectMarkers({
  mvp, positions, vertices, width, height,
  normals = null, normalMatrix = null, orientation = 1, margin = 0
}) {
  const placed = [];
  for (const vertex of vertices) {
    const at = vertex * 3;
    if (normals && normalMatrix && !isFacingViewer(
      normalMatrix, normals[at], normals[at + 1], normals[at + 2], orientation
    )) continue;

    const clip = projectVertex(mvp, positions[at], positions[at + 1], positions[at + 2]);
    // Ortho projection leaves w at 1, so this never divides by zero in practice
    // — but the guard costs nothing and a perspective camera would need it.
    if (!(clip.w > 0)) continue;

    const x = (clip.x / clip.w * 0.5 + 0.5) * width;
    // Clip space has y up, a canvas has y down.
    const y = (0.5 - clip.y / clip.w * 0.5) * height;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue;

    placed.push({ vertex, x, y });
  }
  return placed;
}

/**
 * Rasterise one marker into an RGBA buffer, to be blitted wherever it is needed.
 *
 * A sprite rather than a stroked path because it is the same marker every time:
 * rasterising once and blitting N times is both cheaper than N stroke calls and
 * — the reason that matters here — testable without a canvas.
 *
 * Two coverages are computed from one signed distance: the rim's, and the
 * core's just inside it. Compositing the core over the rim and taking the rim's
 * coverage as the alpha is what produces a hard-edged mark with a halo, at any
 * size, with no seam between the two.
 *
 * @param {object} params
 * @param {'dot'|'circle'|'cross'} params.shape
 * @param {number} params.radius in device pixels
 * @param {[number, number, number]} params.core
 * @param {[number, number, number]} params.rim
 * @param {number} [params.stroke] ink width for the stroked shapes
 * @param {number} [params.halo] how far the rim extends past the core
 * @returns {{pixels: Uint8ClampedArray, size: number, centre: number}} `size`
 *   is the square sprite's side; `centre` is where the marked point sits in it.
 */
export function markerSprite({ shape, radius, core, rim, stroke = 2, halo = 2 }) {
  // Where the ink ends, as a distance from the shape's skeleton. A dot is
  // filled, so its core reaches the skeleton itself (distance 0) and its rim
  // hangs outside; a stroked shape is a band either side of the skeleton.
  const coreEdge = shape === MARKER_DOT ? 0 : stroke / 2;
  const rimEdge = coreEdge + halo;

  const reach = Math.ceil(radius + rimEdge + 1);
  // Odd, so the marked point lands on a pixel centre rather than a boundary and
  // the mark is symmetric about it.
  const size = reach * 2 + 1;
  const centre = reach;
  const pixels = new Uint8ClampedArray(size * size * 4);

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = column - centre;
      const y = row - centre;
      const distance = skeletonDistance(shape, x, y, radius);

      const rimCoverage = clamp(rimEdge - distance + 0.5, 0, 1);
      if (rimCoverage <= 0) continue;
      const coreCoverage = clamp(coreEdge - distance + 0.5, 0, 1);

      const at = (row * size + column) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[at + channel] =
          core[channel] * coreCoverage + rim[channel] * (1 - coreCoverage);
      }
      pixels[at + 3] = rimCoverage * 255;
    }
  }

  return { pixels, size, centre };
}

/** Distance from a point to the shape's ink skeleton, in pixels. */
function skeletonDistance(shape, x, y, radius) {
  if (shape === MARKER_CROSS) {
    // Two bars through the centre. Distance to their union is the smaller of
    // the two distances-to-segment; taking the arms as half-open lines instead
    // would leave the cross without ends.
    return Math.min(
      segmentDistance(x, y, radius),
      segmentDistance(y, x, radius)
    );
  }
  const fromCentre = Math.hypot(x, y);
  // A dot is a disc, so inside it the distance is negative and every coverage
  // saturates; a circle is the outline, so it is the distance either side.
  return shape === MARKER_DOT ? fromCentre - radius : Math.abs(fromCentre - radius);
}

/** Distance to a segment running along the first axis, half-length `arm`. */
function segmentDistance(along, across, arm) {
  const overshoot = Math.abs(along) - arm;
  return overshoot <= 0 ? Math.abs(across) : Math.hypot(overshoot, across);
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
