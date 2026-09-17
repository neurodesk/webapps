const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (vertices, i) => Array.from(vertices.subarray(i * 3, i * 3 + 3));
const distance = (a, b) => Math.hypot(...sub(a, b));
const unit = (v) => v.map((x) => x / Math.hypot(...v));

export function validatePatchOptions(options = {}) {
  const settings = { radius: 10, count: 3, hemisphere: 'both', maxRms: 0.5, minAreaFraction: 0.25, ...options };
  for (const [key, min, max] of [['radius', 2, 20], ['count', 1, 50], ['maxRms', 0.01, 2], ['minAreaFraction', 0.1, 1]]) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) {
      throw new Error(`Patch ${key} must be between ${min} and ${max}.`);
    }
  }
  if (!Number.isInteger(settings.count) || !['both', 'lh', 'rh'].includes(settings.hemisphere)) {
    throw new Error('Invalid patch count or hemisphere.');
  }
  return settings;
}

export function surfaceNormals(white, pial, faces) {
  if (white.length !== pial.length || white.length % 3 || faces.length % 3) throw new Error('Surfaces must have corresponding triangular topology.');
  const middle = Float64Array.from(white, (v, i) => (v + pial[i]) / 2);
  const normals = new Float64Array(middle.length);
  for (let f = 0; f < faces.length; f += 3) {
    const [a, b, c] = Array.from(faces.subarray(f, f + 3), (i) => point(middle, i));
    const normal = cross(sub(b, a), sub(c, a));
    for (let corner = 0; corner < 3; corner += 1) {
      for (let axis = 0; axis < 3; axis += 1) normals[faces[f + corner] * 3 + axis] += normal[axis];
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (!Number.isFinite(length) || length < 1e-12) throw new Error('Surface vertex has no valid normal.');
    const direction = normals[i] * (pial[i] - white[i]) + normals[i + 1] * (pial[i + 1] - white[i + 1]) + normals[i + 2] * (pial[i + 2] - white[i + 2]);
    for (let axis = 0; axis < 3; axis += 1) normals[i + axis] *= (direction < 0 ? -1 : 1) / length;
  }
  return { middle, normals };
}

function graphFor(vertices, faces) {
  const graph = Array.from({ length: vertices.length / 3 }, () => new Map());
  for (let f = 0; f < faces.length; f += 3) {
    for (let j = 0; j < 3; j += 1) {
      const a = faces[f + j];
      const b = faces[f + (j + 1) % 3];
      if (graph[a].has(b)) continue;
      const length = distance(point(vertices, a), point(vertices, b));
      graph[a].set(b, length);
      graph[b].set(a, length);
    }
  }
  return graph;
}

function geodesic(graph, seeds, limit) {
  const distances = new Float64Array(graph.length).fill(Infinity);
  const heap = [];
  const push = (vertex, distance) => {
    let i = heap.length;
    heap.push([vertex, distance]);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][1] <= distance) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = [vertex, distance];
  };
  for (const seed of seeds) {
    distances[seed] = 0;
    push(seed, 0);
  }
  while (heap.length) {
    const [vertex, distance] = heap[0];
    const tail = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1]) child += 1;
        if (heap[child][1] >= tail[1]) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = tail;
    }
    if (distance !== distances[vertex]) continue;
    for (const [neighbor, length] of graph[vertex]) {
      const next = distance + length;
      if (next <= limit && next < distances[neighbor]) {
        distances[neighbor] = next;
        push(neighbor, next);
      }
    }
  }
  return distances;
}

export function erodeCortex(vertices, faces, cortex) {
  const outside = [];
  for (let i = 0; i < cortex.length; i += 1) if (!cortex[i]) outside.push(i);
  if (!outside.length) return cortex.slice();
  const distances = geodesic(graphFor(vertices, faces), outside, 5);
  return Uint8Array.from(cortex, (value, i) => value && distances[i] > 5 ? 1 : 0);
}

function smallestEigenvector(matrix) {
  const a = matrix.map((row) => [...row]);
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let p = 0;
    let q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) [p, q] = [i, j];
    if (Math.abs(a[p][q]) < 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    for (let k = 0; k < 3; k += 1) {
      if (k !== p && k !== q) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = a[p][k] = c * akp - s * akq;
        a[k][q] = a[q][k] = s * akp + c * akq;
      }
      const vkp = vectors[k][p];
      vectors[k][p] = c * vkp - s * vectors[k][q];
      vectors[k][q] = s * vkp + c * vectors[k][q];
    }
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
  }
  const index = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j])[0];
  return unit(vectors.map((row) => row[index]));
}

function fit(vertices, triangles, support) {
  let area = 0;
  const center = [0, 0, 0];
  const meanNormal = [0, 0, 0];
  for (const i of support) {
    const face = triangles[i];
    area += face.area;
    for (let axis = 0; axis < 3; axis += 1) {
      center[axis] += face.center[axis] * face.area;
      meanNormal[axis] += face.normal[axis] * face.area;
    }
  }
  for (let axis = 0; axis < 3; axis += 1) center[axis] /= area;
  const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const i of support) {
    for (const vertex of triangles[i].indices) {
      const delta = sub(point(vertices, vertex), center);
      for (let a = 0; a < 3; a += 1) {
        for (let b = 0; b < 3; b += 1) covariance[a][b] += delta[a] * delta[b] * triangles[i].area / (3 * area);
      }
    }
  }
  let normal = smallestEigenvector(covariance);
  if (dot(normal, meanNormal) < 0) normal = normal.map((v) => -v);
  const variance = dot(normal, covariance.map((row) => dot(row, normal)));
  const coherence = support.reduce((sum, i) => sum + triangles[i].area * Math.max(0, Math.min(1, dot(triangles[i].normal, normal))), 0) / area;
  return { center, normal, rms: Math.sqrt(Math.max(0, variance)), area, coherence };
}

function connected(triangles, support, seed) {
  const edges = new Map();
  for (const i of support) {
    const face = triangles[i].indices;
    for (let j = 0; j < 3; j += 1) {
      const key = [face[j], face[(j + 1) % 3]].sort((a, b) => a - b).join(',');
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(i);
    }
  }
  const found = new Set([seed]);
  const pending = [seed];
  while (pending.length) {
    const face = triangles[pending.pop()].indices;
    for (let j = 0; j < 3; j += 1) {
      const key = [face[j], face[(j + 1) % 3]].sort((a, b) => a - b).join(',');
      for (const neighbor of edges.get(key)) {
        if (found.has(neighbor)) continue;
        found.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function findPatches(vertices, faces, eligible, options = {}) {
  const settings = validatePatchOptions(options);
  const triangles = [];
  const sums = new Float64Array(vertices.length);
  const meshCenter = [0, 0, 0];
  for (let i = 0; i < vertices.length; i += 1) meshCenter[i % 3] += vertices[i] / (vertices.length / 3);
  let orientation = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const indices = Array.from(faces.subarray(f, f + 3));
    if (!indices.every((i) => eligible[i])) continue;
    const [a, b, c] = indices.map((i) => point(vertices, i));
    const vector = cross(sub(b, a), sub(c, a));
    const length = Math.hypot(...vector);
    if (length <= 1e-8) continue;
    const normal = vector.map((v) => v / length);
    const center = a.map((v, i) => (v + b[i] + c[i]) / 3);
    const area = length / 2;
    orientation += area * dot(normal, sub(center, meshCenter));
    triangles.push({ indices, normal, center, area });
    for (const i of indices) for (let axis = 0; axis < 3; axis += 1) sums[i * 3 + axis] += vector[axis];
  }
  if (!triangles.length) return [];
  if (triangles.length < 3) throw new Error('Flat-patch analysis requires at least three non-degenerate faces.');
  for (const face of triangles) {
    face.bending = 1 - face.indices.reduce((sum, i) => sum + Math.max(-1, Math.min(1, dot(face.normal, unit(point(sums, i))))), 0) / 3;
    if (orientation < 0) face.normal = face.normal.map((v) => -v);
  }
  const ranked = triangles.map((_, i) => i).sort((a, b) => triangles[a].bending - triangles[b].bending || a - b);
  const limit = Math.max(64, settings.count * 32);
  const seeds = [];
  for (const i of ranked) {
    if (ranked.length <= limit || seeds.every((other) => distance(triangles[i].center, triangles[other].center) >= settings.radius / 2)) seeds.push(i);
    if (seeds.length === limit) break;
  }
  const validFaces = Int32Array.from(triangles.flatMap((face) => face.indices));
  const graph = graphFor(vertices, validFaces);
  const candidates = [];
  for (const seed of seeds) {
    const face = triangles[seed];
    const seedVertex = [...face.indices].sort((a, b) => distance(point(vertices, a), face.center) - distance(point(vertices, b), face.center))[0];
    const distances = geodesic(graph, [seedVertex], settings.radius);
    let support = triangles.flatMap((face, i) => face.indices.every((v) => distances[v] <= settings.radius) ? [i] : []);
    if (!support.includes(seed)) continue;
    let metrics = fit(vertices, triangles, support);
    const aligned = support.filter((i) => dot(triangles[i].normal, metrics.normal) >= Math.SQRT1_2);
    if (!aligned.includes(seed)) continue;
    if (aligned.length !== support.length) {
      support = connected(triangles, aligned, seed);
      metrics = fit(vertices, triangles, support);
    }
    if (metrics.rms > settings.maxRms || metrics.area < Math.PI * settings.radius ** 2 * settings.minAreaFraction || metrics.coherence < 0.9) continue;
    candidates.push({ ...metrics, seed, support, score: metrics.rms + settings.radius * (1 - metrics.coherence) });
  }
  const used = new Uint8Array(vertices.length / 3);
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => a.score - b.score || a.seed - b.seed)) {
    const selectedFaces = candidate.support.flatMap((i) => triangles[i].indices);
    const indices = [...new Set(selectedFaces)].sort((a, b) => a - b);
    if (indices.some((i) => used[i])) continue;
    for (const i of indices) used[i] = 1;
    const nearest = indices.reduce((a, b) => distance(point(vertices, a), candidate.center) <= distance(point(vertices, b), candidate.center) ? a : b);
    accepted.push({ ...candidate, center: point(vertices, nearest), indices, faces: selectedFaces });
    if (accepted.length === settings.count) break;
  }
  return accepted;
}
