export function readCortexAtlas(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (buffer.byteLength !== 4 + count * 14 || !count) throw new Error('Invalid cortical atlas.');
  const points = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const xyz = [0, 1, 2].map((axis) => view.getFloat32(4 + (i * 3 + axis) * 4, true));
    const length = Math.hypot(...xyz);
    if (!Number.isFinite(length) || length < 1e-6) throw new Error('Invalid atlas sphere.');
    for (let axis = 0; axis < 3; axis += 1) points[i * 3 + axis] = xyz[axis] / length;
  }
  return {
    points,
    lh: new Uint8Array(buffer, 4 + count * 12, count),
    rh: new Uint8Array(buffer, 4 + count * 13, count),
  };
}

export function mapCortex(registration, atlas, hemisphere) {
  return Uint8Array.from(nearestAtlasVertices(registration, atlas.points), (vertex) => atlas[hemisphere][vertex]);
}

// fsaverage's lh and rh spheres are the same icosahedron, so one point set serves
// both hemispheres; each hemisphere's labels are then indexed by the nearest vertex.
export function nearestAtlasVertices(registration, points) {
  const count = points.length / 3;
  const order = Array.from({ length: count }, (_, i) => i);
  const left = new Int32Array(count).fill(-1);
  const right = new Int32Array(count).fill(-1);
  const axes = new Uint8Array(count);
  const build = (indices, depth) => {
    if (!indices.length) return -1;
    const axis = depth % 3;
    indices.sort((a, b) => points[a * 3 + axis] - points[b * 3 + axis] || a - b);
    const middle = indices.length >> 1;
    const node = indices[middle];
    axes[node] = axis;
    left[node] = build(indices.slice(0, middle), depth + 1);
    right[node] = build(indices.slice(middle + 1), depth + 1);
    return node;
  };
  const root = build(order, 0);
  const nearestVertices = new Int32Array(registration.length / 3);
  for (let i = 0; i < nearestVertices.length; i += 1) {
    const query = Array.from(registration.subarray(i * 3, i * 3 + 3));
    const length = Math.hypot(...query);
    if (!Number.isFinite(length) || length < 1e-6) throw new Error('Invalid cortical registration sphere.');
    for (let axis = 0; axis < 3; axis += 1) query[axis] /= length;
    let best = Infinity;
    let nearest = -1;
    const visit = (node) => {
      if (node < 0) return;
      let distance = 0;
      for (let axis = 0; axis < 3; axis += 1) distance += (query[axis] - points[node * 3 + axis]) ** 2;
      if (distance < best || distance === best && node < nearest) {
        best = distance;
        nearest = node;
      }
      const delta = query[axes[node]] - points[node * 3 + axes[node]];
      visit(delta < 0 ? left[node] : right[node]);
      if (delta * delta <= best) visit(delta < 0 ? right[node] : left[node]);
    };
    visit(root);
    nearestVertices[i] = nearest;
  }
  return nearestVertices;
}
