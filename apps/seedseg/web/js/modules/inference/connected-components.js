/**
 * 3D Connected Component Labeling with 26-connectivity.
 * Equivalent to scipy.ndimage.label(binary, structure=np.ones((3,3,3)))
 * Uses two-pass Union-Find algorithm with path compression and union by rank.
 */

/**
 * Label connected components in a 3D binary volume.
 * @param {Uint8Array|Float32Array} binaryMask - Thresholded volume (nonzero = foreground)
 * @param {number[]} dims - [nx, ny, nz]
 * @returns {{ labels: Int32Array, numComponents: number }}
 */
export function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;

  // Union-Find with path compression and union by rank
  const parent = [0]; // index 0 unused; labels start at 1
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  // 13 backward neighbors for 26-connectivity
  // (the "already visited" half of the 26 neighbors)
  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue; // skip self and forward neighbors
        neighborOffsets.push([dx, dy, dz]);
      }
    }
  }
  // neighborOffsets has 13 entries

  // Pass 1: Forward scan with provisional labeling
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = z * ny * nx + y * nx + x;
        if (!binaryMask[idx]) continue;

        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x + neighborOffsets[i][0];
          const ny2 = y + neighborOffsets[i][1];
          const nz2 = z + neighborOffsets[i][2];
          if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) continue;
          const nIdx = nz2 * ny * nx + ny2 * nx + nx2;
          if (labels[nIdx] > 0) {
            neighborLabels.push(labels[nIdx]);
          }
        }

        if (neighborLabels.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel++;
        } else {
          // Find minimum canonical label
          let minLabel = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const canonical = find(neighborLabels[i]);
            if (canonical < minLabel) minLabel = canonical;
          }
          labels[idx] = minLabel;
          // Union all neighbor labels
          for (let i = 0; i < neighborLabels.length; i++) {
            union(minLabel, neighborLabels[i]);
          }
        }
      }
    }
  }

  // Pass 2: Resolve labels to canonical form and renumber sequentially
  const canonicalMap = new Map();
  let finalLabel = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonicalMap.has(root)) {
      canonicalMap.set(root, ++finalLabel);
    }
    labels[i] = canonicalMap.get(root);
  }

  return { labels, numComponents: finalLabel };
}
