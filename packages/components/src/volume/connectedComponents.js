import { assertDims, index3D, voxelCount } from './geometry.js';

export function connectedComponents3D(binaryMask, dims) {
  assertDims(dims);
  const [nx, ny, nz] = dims;
  const labels = new Int32Array(voxelCount(dims));
  let nextLabel = 1;
  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
  }

  const neighbors = [];
  for (let dz = -1; dz <= 0; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighbors.push([dx, dy, dz]);
      }
    }
  }

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = index3D(x, y, z, dims);
        if (!binaryMask[idx]) continue;
        const neighborLabels = [];
        for (const [dx, dy, dz] of neighbors) {
          const xx = x + dx;
          const yy = y + dy;
          const zz = z + dz;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
          const label = labels[index3D(xx, yy, zz, dims)];
          if (label > 0) neighborLabels.push(label);
        }
        if (!neighborLabels.length) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel += 1;
        } else {
          let label = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const candidate = find(neighborLabels[i]);
            if (candidate < label) label = candidate;
          }
          labels[idx] = label;
          for (const neighborLabel of neighborLabels) union(label, neighborLabel);
        }
      }
    }
  }

  const canonical = new Map();
  let finalLabel = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonical.has(root)) canonical.set(root, ++finalLabel);
    labels[i] = canonical.get(root);
  }

  return { labels, numComponents: finalLabel };
}

export function keepLargestComponent(binaryMask, dims, OutputCtor = Uint8Array) {
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);
  const sizes = new Int32Array(numComponents + 1);
  for (const label of labels) if (label > 0) sizes[label] += 1;
  let largest = 0;
  for (let i = 1; i <= numComponents; i++) if (sizes[i] > sizes[largest]) largest = i;
  const result = new OutputCtor(labels.length);
  if (!largest) return result;
  for (let i = 0; i < labels.length; i++) if (labels[i] === largest) result[i] = 1;
  return result;
}

export function perLabelLargestComponent(labelVolume, dims, maxLabel, OutputCtor = Uint8Array) {
  const result = new OutputCtor(labelVolume.length);
  for (let label = 1; label <= maxLabel; label++) {
    const mask = new Uint8Array(labelVolume.length);
    let hasVoxels = false;
    for (let i = 0; i < labelVolume.length; i++) {
      if (labelVolume[i] === label) {
        mask[i] = 1;
        hasVoxels = true;
      }
    }
    if (!hasVoxels) continue;
    const largest = keepLargestComponent(mask, dims);
    for (let i = 0; i < largest.length; i++) if (largest[i]) result[i] = label;
  }
  return result;
}

export function countLabels(labelVolume, maxLabel) {
  const counts = new Int32Array(maxLabel + 1);
  for (const value of labelVolume) if (value > 0 && value <= maxLabel) counts[value] += 1;
  return counts;
}

export function getDetectedLabels(counts) {
  const labels = [];
  for (let i = 1; i < counts.length; i++) if (counts[i] > 0) labels.push(i);
  return labels;
}
