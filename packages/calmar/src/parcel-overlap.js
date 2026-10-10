// Pure-JS parcel-overlap reducer for CALMaR.
//
// Inputs are typed arrays already on a common MNI grid:
//   lesion: Uint8Array | Uint8ClampedArray, nonzero -> "in lesion"
//   atlas:  Int16Array | Int32Array | Uint16Array, integer parcel labels
//           (0 = background, ignored)
//   dims:   [nx, ny, nz]
//
// Returns:
//   {
//     totalLesionVoxels,
//     parcels: [
//       { label, parcelSize, voxelsInLesion, fractionOfParcel, fractionOfLesion },
//       ...   // only nonzero overlaps are listed
//     ]
//   }

export function computeParcelOverlap({ lesion, atlas, dims }) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('computeParcelOverlap: dims must be [nx, ny, nz]');
  }
  const expected = dims[0] * dims[1] * dims[2];
  if (lesion.length !== expected) {
    throw new Error(`computeParcelOverlap: lesion length ${lesion.length} does not match dims (expected ${expected})`);
  }
  if (atlas.length !== expected) {
    throw new Error(`computeParcelOverlap: atlas length ${atlas.length} does not match dims (expected ${expected})`);
  }

  // Single pass over the grid: tally parcel size for every nonzero label, and
  // (independently) tally lesion voxels per label.
  const parcelSize = new Map();    // label -> parcel size (voxel count)
  const inLesion = new Map();      // label -> lesion voxels in parcel
  let totalLesionVoxels = 0;
  let voxelsOutsideAtlas = 0;      // lesion voxels where atlas label == 0

  for (let i = 0; i < expected; i++) {
    const label = atlas[i];
    if (label !== 0) {
      parcelSize.set(label, (parcelSize.get(label) || 0) + 1);
    }
    if (lesion[i]) {
      totalLesionVoxels += 1;
      if (label !== 0) {
        inLesion.set(label, (inLesion.get(label) || 0) + 1);
      } else {
        voxelsOutsideAtlas += 1;
      }
    }
  }

  const parcels = [];
  for (const [label, voxelsInLesion] of inLesion) {
    const size = parcelSize.get(label) || 0;
    parcels.push({
      label,
      parcelSize: size,
      voxelsInLesion,
      fractionOfParcel: size > 0 ? voxelsInLesion / size : 0,
      fractionOfLesion: totalLesionVoxels > 0 ? voxelsInLesion / totalLesionVoxels : 0
    });
  }
  // Stable order by descending lesion-voxel count, then ascending label.
  parcels.sort((a, b) =>
    b.voxelsInLesion - a.voxelsInLesion || a.label - b.label
  );

  return { totalLesionVoxels, voxelsOutsideAtlas, parcels };
}

// Aggregate per-parcel overlaps into per-network sums using a label->network
// mapping (e.g. Yeo 7 networks). Parcels missing from the map are bucketed
// under 'Unassigned' so their voxel counts are never silently dropped.
export function summarizeNetworkOverlap(parcelResult, parcelToNetwork) {
  const byNetwork = new Map();
  let totalLesionVoxels = parcelResult.totalLesionVoxels;
  for (const p of parcelResult.parcels) {
    const network = Object.prototype.hasOwnProperty.call(parcelToNetwork, p.label)
      ? parcelToNetwork[p.label]
      : 'Unassigned';
    const acc = byNetwork.get(network) || {
      network,
      voxelsInLesion: 0,
      parcels: []
    };
    acc.voxelsInLesion += p.voxelsInLesion;
    acc.parcels.push(p.label);
    byNetwork.set(network, acc);
  }

  const networks = Array.from(byNetwork.values()).map(n => ({
    network: n.network,
    voxelsInLesion: n.voxelsInLesion,
    fractionOfLesion: totalLesionVoxels > 0
      ? n.voxelsInLesion / totalLesionVoxels
      : 0,
    parcels: n.parcels.slice().sort((a, b) => a - b)
  }));
  networks.sort((a, b) =>
    b.voxelsInLesion - a.voxelsInLesion || a.network.localeCompare(b.network)
  );

  return { totalLesionVoxels, networks };
}
