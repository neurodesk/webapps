// 26-connected components of a binary marker mask, with centroids in voxel coordinates.
export function markerComponents(mask, dims) {
  const [nx, ny, nz] = dims;
  if (mask.length !== nx * ny * nz) throw new Error(`Mask holds ${mask.length} voxels, dims give ${nx * ny * nz}`);
  const seen = new Uint8Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const sum = [0, 0, 0];
    let voxels = 0;
    while (stack.length) {
      const index = stack.pop();
      const x = index % nx;
      const y = Math.floor(index / nx) % ny;
      const z = Math.floor(index / (nx * ny));
      sum[0] += x;
      sum[1] += y;
      sum[2] += z;
      voxels++;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx;
            const py = y + dy;
            const pz = z + dz;
            if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
            const neighbour = px + nx * (py + ny * pz);
            if (!mask[neighbour] || seen[neighbour]) continue;
            seen[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }
    components.push({ voxels, centroid: sum.map(value => value / voxels) });
  }
  return components;
}

// Pairs each planted seed with its nearest detected component and returns the distances in voxels.
// Throws unless the pairing is one to one, so two components near one seed cannot hide a missed seed.
export function matchComponentsToSeeds(components, seeds) {
  const taken = new Set();
  return seeds.map(seed => {
    let best = -1;
    let bestDistance = Infinity;
    components.forEach((component, index) => {
      const distance = Math.hypot(...component.centroid.map((value, axis) => value - seed[axis]));
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best < 0) throw new Error(`No marker component to match seed ${seed.join(',')}`);
    if (taken.has(best)) throw new Error(`Marker component ${best} is the nearest to more than one planted seed`);
    taken.add(best);
    return { seed, component: components[best], distance: bestDistance };
  });
}
