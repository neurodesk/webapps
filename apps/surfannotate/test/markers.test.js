import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectVertex, projectMarkers, isFacingViewer, surfaceOrientation, markerSprite,
  MARKER_DOT, MARKER_CIRCLE, MARKER_CROSS
} from '../src/niivue/markers.js';

/** Column-major identity, i.e. clip coordinates straight through. */
const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
]);

/** Column-major, so this is the *translation* column, not a bottom row. */
function translation(x, y, z) {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function pixel(sprite, column, row) {
  const at = (row * sprite.size + column) * 4;
  return {
    r: sprite.pixels[at],
    g: sprite.pixels[at + 1],
    b: sprite.pixels[at + 2],
    alpha: sprite.pixels[at + 3]
  };
}

const CORE = [255, 255, 255];
const RIM = [0, 0, 0];

test('a mat4 is read column-major', () => {
  // The one slip this module cannot survive: reading the matrix row-wise
  // transposes the rotation, which still projects to plausible-looking pixels
  // but puts every marker on the wrong part of the surface. Translation lives
  // in elements 12..14; if those were read as a bottom row nothing would move.
  const moved = projectVertex(translation(3, -4, 5), 0, 0, 0);
  assert.deepEqual([moved.x, moved.y, moved.z, moved.w], [3, -4, 5, 1]);
});

test('clip space maps to the canvas with y flipped', () => {
  const positions = new Float32Array([
    0, 0, 0, // centre
    -1, 1, 0, // top left in clip space
    1, -1, 0 // bottom right
  ]);
  const placed = projectMarkers({
    mvp: IDENTITY, positions, vertices: [0, 1, 2], width: 200, height: 100
  });

  assert.deepEqual(placed.map((m) => [m.x, m.y]), [
    [100, 50],
    [0, 0],
    [200, 100]
  ], 'clip y is up and canvas y is down, so the corners cross over');
});

test('markers outside the canvas are dropped, but not ones straddling the edge', () => {
  const positions = new Float32Array([-3, 0, 0, -1.1, 0, 0]);
  const far = projectMarkers({
    mvp: IDENTITY, positions, vertices: [0, 1], width: 100, height: 100, margin: 10
  });
  assert.deepEqual(far.map((m) => m.vertex), [1],
    'the one just past the edge is kept, the one far outside is not');
});

test('the facing test follows the normal, and the orientation flips it', () => {
  // The viewer is on the -z side, NOT the +z side: NiiVue's ortho is built with
  // near > far, which inverts the depth mapping. So an outward normal pointing
  // at -z is the one facing us. Measured against a real click, not assumed —
  // see the note on isFacingViewer.
  assert.equal(isFacingViewer(IDENTITY, 0, 0, -1), true);
  assert.equal(isFacingViewer(IDENTITY, 0, 0, 1), false);
  // Normals pointing into the surface must give the opposite answer.
  assert.equal(isFacingViewer(IDENTITY, 0, 0, -1, -1), false);
  assert.equal(isFacingViewer(IDENTITY, 0, 0, 1, -1), true);
  // Edge-on is not facing us; a marker there would sit on the silhouette.
  assert.equal(isFacingViewer(IDENTITY, 1, 0, 0), false);
});

/** An octahedron: six vertices, one at each axis extreme. */
const OCTAHEDRON = new Float32Array([
  -2, 0, 0, 2, 0, 0,
  0, -2, 0, 0, 2, 0,
  0, 0, -2, 0, 0, 2
]);
/** Its outward normals — at an axis extreme, outward *is* the axis. */
const OUTWARD = new Float32Array([
  -1, 0, 0, 1, 0, 0,
  0, -1, 0, 0, 1, 0,
  0, 0, -1, 0, 0, 1
]);
const INWARD = OUTWARD.map((value) => -value);

test('orientation is measured from the normals, not inferred from the winding', () => {
  // This is the whole point of the function. An earlier version derived the sign
  // from the triangle winding by signed volume, which is a correct fact about
  // the winding — and wrong here, because NVMeshUtilities.generateNormals builds
  // its normals as (p3-p1) x (p2-p1), the negation of the convention that
  // inference assumed. Every near-surface marker was culled and every far-side
  // one drawn, which over a hemisphere's silhouette looks entirely plausible.
  assert.equal(surfaceOrientation(OCTAHEDRON, OUTWARD), 1);
  assert.equal(surfaceOrientation(OCTAHEDRON, INWARD), -1);
});

test('orientation follows the normals even when the geometry is off-centre', () => {
  // The extremes are found per axis, so a mesh nowhere near the origin — which
  // every scanner-space surface is — must give the same answer.
  const moved = OCTAHEDRON.map((value, i) => value + [130, -98, 47][i % 3]);
  assert.equal(surfaceOrientation(moved, OUTWARD), 1);
  assert.equal(surfaceOrientation(moved, INWARD), -1);
});

test('the measured orientation and the facing test agree on which side is near', () => {
  // The end-to-end property the bug broke, in miniature. Whichever way the
  // normals of a mesh happen to point, the vertex on the -z extreme is the one
  // nearest this viewer, and it must survive the cull while the +z one does not.
  // Both halves matter: the shipped bug kept exactly the wrong set, and a test
  // that only asked "is anything visible" was satisfied by that.
  const NEAR = 4; // the vertex at -z
  const FAR = 5; // the vertex at +z
  for (const [label, normals] of [['outward', OUTWARD], ['inward', INWARD]]) {
    const orientation = surfaceOrientation(OCTAHEDRON, normals);
    const facing = (v) => isFacingViewer(
      IDENTITY, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], orientation
    );
    assert.equal(facing(NEAR), true, `${label}: the near vertex was culled`);
    assert.equal(facing(FAR), false, `${label}: the far vertex was drawn`);
  }
});

test('every shape is a core inside a rim, which is what makes it readable', () => {
  // The property the halo exists for: whatever the marker is drawn over, there
  // is a band of the opposite colour between its ink and the surface. A core
  // that reached the transparent edge would vanish against a matching overlay.
  for (const shape of [MARKER_DOT, MARKER_CIRCLE, MARKER_CROSS]) {
    const sprite = markerSprite({ shape, radius: 6, core: CORE, rim: RIM });
    const centre = sprite.centre;

    // Walk out along +x from the centre. A circle's middle is a hole, so the
    // walk cannot assume ink at the centre — what matters is the order of the
    // bands: the outermost painted pixel must be rim, with core somewhere
    // inside it.
    let core = -1;
    let outermost = -1;
    for (let x = centre; x < sprite.size; x++) {
      const { r, alpha } = pixel(sprite, x, centre);
      if (alpha === 0) continue;
      outermost = x;
      if (r > 200) core = x;
    }
    assert.ok(core >= 0, `${shape} painted no core`);
    assert.ok(outermost > core, `${shape} has no rim outside its core`);
    assert.ok(pixel(sprite, outermost, centre).r < 60,
      `${shape} ends on its core colour, so it has no halo on that side`);

    // And the sprite must not paint its own corner, or the halo becomes a box.
    assert.equal(pixel(sprite, 0, 0).alpha, 0, `${shape} painted its corner`);
  }
});

test('a dot is filled and a circle is not', () => {
  const radius = 6;
  const dot = markerSprite({ shape: MARKER_DOT, radius, core: CORE, rim: RIM });
  const circle = markerSprite({ shape: MARKER_CIRCLE, radius, core: CORE, rim: RIM });

  assert.ok(pixel(dot, dot.centre, dot.centre).r > 200, 'the dot has no hole');
  assert.equal(pixel(circle, circle.centre, circle.centre).alpha, 0,
    'the circle is an outline, so its middle shows the surface through it');
  // The outline itself is on the radius, in both.
  assert.ok(pixel(circle, circle.centre + radius, circle.centre).r > 200);
});

test('a cross has arms on both axes and nothing on the diagonal', () => {
  const radius = 7;
  const sprite = markerSprite({ shape: MARKER_CROSS, radius, core: CORE, rim: RIM });
  const c = sprite.centre;

  for (const [column, row] of [[c + radius, c], [c - radius, c], [c, c + radius], [c, c - radius]]) {
    assert.ok(pixel(sprite, column, row).r > 200, 'an arm is missing');
  }
  // Diagonally out at the same distance there is only background — this is what
  // separates a cross from a dot once it is a few pixels across.
  const diagonal = Math.round(radius * 0.75);
  assert.equal(pixel(sprite, c + diagonal, c + diagonal).alpha, 0);
});

test('the sprite is odd-sized so the marked point is a pixel, not a seam', () => {
  for (const radius of [3, 4.5, 8]) {
    const sprite = markerSprite({ shape: MARKER_CIRCLE, radius, core: CORE, rim: RIM });
    assert.equal(sprite.size % 2, 1, 'an even sprite has no centre pixel');
    assert.equal(sprite.centre * 2 + 1, sprite.size);
  }
});
