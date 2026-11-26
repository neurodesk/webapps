// 26-connected skeleton graph extraction with junction super-node clustering,
// loop preservation (Circle of Willis cycles), iterative spur pruning, and
// degree-2 node merging to fixpoint.

// 26-neighbor relative (dx, dy, dz) offsets in deterministic order.
export const OFFSETS_26 = [];
for (let dz = -1; dz <= 1; dz += 1) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        OFFSETS_26.push([dx, dy, dz]);
      }
    }
  }
}

function coordsFromIndex(idx, nx, slice) {
  const z = Math.floor(idx / slice);
  const rem = idx - z * slice;
  const y = Math.floor(rem / nx);
  const x = rem - y * nx;
  return [x, y, z];
}

function stepLengthMm(a, b, spacing) {
  const dx = (b[0] - a[0]) * spacing[0];
  const dy = (b[1] - a[1]) * spacing[1];
  const dz = (b[2] - a[2]) * spacing[2];
  return Math.hypot(dx, dy, dz);
}

function polylineLengthMm(pointsVox, spacing) {
  let len = 0;
  for (let i = 1; i < pointsVox.length; i += 1) {
    len += stepLengthMm(pointsVox[i - 1], pointsVox[i], spacing);
  }
  return len;
}

function isFovVoxel(x, y, z, originalDims, cropOffset) {
  if (!originalDims) {
    return false;
  }
  const gx = x + cropOffset[0];
  const gy = y + cropOffset[1];
  const gz = z + cropOffset[2];
  return (
    gx <= 0 ||
    gx >= originalDims[0] - 1 ||
    gy <= 0 ||
    gy >= originalDims[1] - 1 ||
    gz <= 0 ||
    gz >= originalDims[2] - 1
  );
}

/**
 * Extracts an undirected multigraph from a 3D binary skeleton volume.
 *
 * - Collapses 26-connected sets of degree >= 3 skeleton voxels into single
 *   logical junction super-nodes positioned at their EDT-weighted centroids.
 * - Preserves parallel edges (fenestrations), self-loops, and pure degree-2
 *   closed rings (Circle of Willis loops).
 * - Iteratively prunes short terminal spurs (protecting FOV-cropped endpoints)
 *   and merges resulting degree-2 junctions to fixpoint.
 */
export function extractVesselGraph(
  skeleton,
  dims,
  spacing,
  edtMm,
  {
    originalDims = null,
    cropOffset = [0, 0, 0],
    minSpurLengthMm = 1.0,
    pruneContainedSpurs = false,
    minIsolatedLengthMm = 0,
  } = {},
) {
  const [nx, ny, nz] = dims;
  const slice = nx * ny;
  const total = slice * nz;
  const maxSpacing = Math.max(spacing[0], spacing[1], spacing[2]);

  // Step 1: Collect skeleton voxels and compute 26-neighbor degree on the skeleton.
  const skelIndices = [];
  const degree = new Uint8Array(total);

  for (let z = 0; z < nz; z += 1) {
    const zBase = z * slice;
    for (let y = 0; y < ny; y += 1) {
      const yBase = zBase + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const idx = yBase + x;
        if (!skeleton[idx]) {
          continue;
        }
        skelIndices.push(idx);
        let deg = 0;
        for (let k = 0; k < 26; k += 1) {
          const [dx, dy, dz] = OFFSETS_26[k];
          const nx2 = x + dx;
          const ny2 = y + dy;
          const nz2 = z + dz;
          if (nx2 >= 0 && nx2 < nx && ny2 >= 0 && ny2 < ny && nz2 >= 0 && nz2 < nz) {
            if (skeleton[nz2 * slice + ny2 * nx + nx2]) {
              deg += 1;
            }
          }
        }
        degree[idx] = deg;
      }
    }
  }

  // Node ID map per voxel: -1 for non-node (slab/background), >= 0 for node id.
  const voxelNodeId = new Int32Array(total).fill(-1);
  const nodes = [];
  const isolatedVoxels = [];

  // Step 2: Assign endpoint nodes (deg === 1) and record isolated points (deg === 0).
  for (let i = 0; i < skelIndices.length; i += 1) {
    const idx = skelIndices[i];
    const deg = degree[idx];
    const [x, y, z] = coordsFromIndex(idx, nx, slice);
    const fov = isFovVoxel(x, y, z, originalDims, cropOffset);
    if (deg === 0) {
      isolatedVoxels.push({ idx, vox: [x, y, z], touchesFov: fov });
    } else if (deg === 1) {
      const id = nodes.length;
      voxelNodeId[idx] = id;
      nodes.push({
        id,
        kind: 'endpoint',
        vox: [x, y, z],
        voxelIndices: [idx],
        maxEdtMm: edtMm ? edtMm[idx] : 0,
        touchesFov: fov,
        removed: false,
      });
    }
  }

  // Step 3: Cluster 26-connected junction voxels (deg >= 3) into super-nodes.
  const bfsQueue = [];
  for (let i = 0; i < skelIndices.length; i += 1) {
    const start = skelIndices[i];
    if (degree[start] < 3 || voxelNodeId[start] >= 0) {
      continue;
    }
    const id = nodes.length;
    voxelNodeId[start] = id;
    bfsQueue.length = 0;
    bfsQueue.push(start);
    let head = 0;
    const cluster = [];
    let wxSum = 0;
    let wySum = 0;
    let wzSum = 0;
    let wSum = 0;
    let maxEdt = 0;
    let anyFov = false;

    while (head < bfsQueue.length) {
      const cur = bfsQueue[head];
      head += 1;
      cluster.push(cur);
      const [cx, cy, cz] = coordsFromIndex(cur, nx, slice);
      if (isFovVoxel(cx, cy, cz, originalDims, cropOffset)) {
        anyFov = true;
      }
      const r = edtMm ? edtMm[cur] : 1;
      if (r > maxEdt) {
        maxEdt = r;
      }
      const w = r * r + 1e-6;
      wxSum += cx * w;
      wySum += cy * w;
      wzSum += cz * w;
      wSum += w;

      for (let k = 0; k < 26; k += 1) {
        const [dx, dy, dz] = OFFSETS_26[k];
        const nx2 = cx + dx;
        const ny2 = cy + dy;
        const nz2 = cz + dz;
        if (nx2 >= 0 && nx2 < nx && ny2 >= 0 && ny2 < ny && nz2 >= 0 && nz2 < nz) {
          const nIdx = nz2 * slice + ny2 * nx + nx2;
          if (degree[nIdx] >= 3 && voxelNodeId[nIdx] < 0) {
            voxelNodeId[nIdx] = id;
            bfsQueue.push(nIdx);
          }
        }
      }
    }

    nodes.push({
      id,
      kind: 'junction',
      vox: [wxSum / wSum, wySum / wSum, wzSum / wSum],
      voxelIndices: cluster,
      maxEdtMm: maxEdt,
      touchesFov: anyFov,
      removed: false,
    });
  }

  // Helper: get 26-neighbors of a skeleton voxel that are also skeleton voxels.
  const getSkelNeighbors = (idx) => {
    const [x, y, z] = coordsFromIndex(idx, nx, slice);
    const list = [];
    for (let k = 0; k < 26; k += 1) {
      const [dx, dy, dz] = OFFSETS_26[k];
      const nx2 = x + dx;
      const ny2 = y + dy;
      const nz2 = z + dz;
      if (nx2 >= 0 && nx2 < nx && ny2 >= 0 && ny2 < ny && nz2 >= 0 && nz2 < nz) {
        const nIdx = nz2 * slice + ny2 * nx + nx2;
        if (skeleton[nIdx]) {
          list.push(nIdx);
        }
      }
    }
    return list;
  };

  // Step 4: Trace maximal edges (chains of slab voxels or direct node-to-node links).
  const visitedSlab = new Uint8Array(total);
  const directPairs = new Set();
  const segments = [];

  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  const pickNearestClusterVoxel = (node, targetVox) => {
    let bestIdx = node.voxelIndices[0];
    let bestDist = Infinity;
    for (let i = 0; i < node.voxelIndices.length; i += 1) {
      const vIdx = node.voxelIndices[i];
      const v = coordsFromIndex(vIdx, nx, slice);
      const d = stepLengthMm(v, targetVox, spacing);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = vIdx;
      }
    }
    return bestIdx;
  };

  // Trace a chain starting from node `startNodeId` exiting via `firstVoxel` (which may
  // be a slab voxel or another node voxel).
  const traceFromExit = (startNodeId, startPortIdx, firstVoxel) => {
    const startNode = nodes[startNodeId];
    const targetNodeId = voxelNodeId[firstVoxel];

    // Direct node-to-node link (0 interior slab voxels).
    if (targetNodeId >= 0) {
      if (targetNodeId === startNodeId) {
        return;
      }
      const key = pairKey(startNodeId, targetNodeId);
      if (directPairs.has(key)) {
        return;
      }
      directPairs.add(key);
      const endNode = nodes[targetNodeId];
      const pointsVox = [startNode.vox, endNode.vox];
      const voxelIndices = [startPortIdx, firstVoxel];
      segments.push({
        id: segments.length + 1,
        nodeA: startNodeId,
        nodeB: targetNodeId,
        pointsVox,
        voxelIndices,
        isClosedLoop: false,
        rawLengthMm: polylineLengthMm(pointsVox, spacing),
        removed: false,
      });
      return;
    }

    // Slab chain: only trace each slab voxel once.
    if (visitedSlab[firstVoxel]) {
      return;
    }

    const chainIndices = [startPortIdx];
    const chainPoints = [startNode.vox];
    let prev = startPortIdx;
    let cur = firstVoxel;
    let endNodeId = -1;

    while (true) {
      visitedSlab[cur] = 1;
      chainIndices.push(cur);
      const curVox = coordsFromIndex(cur, nx, slice);
      chainPoints.push(curVox);

      const neighbors = getSkelNeighbors(cur);
      // Prefer an unvisited slab neighbor first; if none, look for a terminal/junction node.
      let nextSlab = -1;
      let nextNode = -1;
      let nextNodePort = -1;

      for (let i = 0; i < neighbors.length; i += 1) {
        const nb = neighbors[i];
        if (nb === prev) {
          continue;
        }
        const nbNodeId = voxelNodeId[nb];
        if (nbNodeId >= 0) {
          // Avoid immediately re-entering the start junction from the very first slab voxel
          // when that slab touches multiple voxels of the same junction cluster.
          if (nbNodeId === startNodeId && chainIndices.length === 2) {
            continue;
          }
          if (nextNode < 0 || nbNodeId !== startNodeId) {
            nextNode = nbNodeId;
            nextNodePort = nb;
          }
        } else if (!visitedSlab[nb]) {
          nextSlab = nb;
        }
      }

      if (nextSlab >= 0) {
        prev = cur;
        cur = nextSlab;
        continue;
      }

      if (nextNode >= 0) {
        endNodeId = nextNode;
        const endNode = nodes[endNodeId];
        const portIdx = endNode.voxelIndices.length > 1
          ? pickNearestClusterVoxel(endNode, curVox)
          : nextNodePort;
        chainIndices.push(portIdx);
        chainPoints.push(endNode.vox);
        break;
      }

      // Self-loop that returned to a voxel adjacent to startNodeId on a 2-voxel ring.
      for (let i = 0; i < neighbors.length; i += 1) {
        const nb = neighbors[i];
        if (voxelNodeId[nb] === startNodeId) {
          endNodeId = startNodeId;
          chainIndices.push(nb);
          chainPoints.push(startNode.vox);
          break;
        }
      }
      if (endNodeId >= 0) {
        break;
      }

      // Fallback: treat dead end as an endpoint node (should not happen in valid skeletons).
      const epId = nodes.length;
      voxelNodeId[cur] = epId;
      nodes.push({
        id: epId,
        kind: 'endpoint',
        vox: curVox,
        voxelIndices: [cur],
        maxEdtMm: edtMm ? edtMm[cur] : 0,
        touchesFov: isFovVoxel(curVox[0], curVox[1], curVox[2], originalDims, cropOffset),
        removed: false,
      });
      endNodeId = epId;
      break;
    }

      // A 1- or 2-voxel detour that immediately re-enters the same junction cluster
      // is a 26-connected discretization triangle, not an anatomical vascular loop.
      if (startNodeId === endNodeId && chainIndices.length < 5) {
        return;
      }

      segments.push({
      id: segments.length + 1,
      nodeA: startNodeId,
      nodeB: endNodeId,
      pointsVox: chainPoints,
      voxelIndices: chainIndices,
      isClosedLoop: startNodeId === endNodeId,
      rawLengthMm: polylineLengthMm(chainPoints, spacing),
      removed: false,
    });
  };

  // Trace out from all endpoints first, then all junction super-nodes.
  for (let nodeId = 0; nodeId < nodes.length; nodeId += 1) {
    const node = nodes[nodeId];
    if (node.kind !== 'endpoint') {
      continue;
    }
    const idx = node.voxelIndices[0];
    const neighbors = getSkelNeighbors(idx);
    for (let j = 0; j < neighbors.length; j += 1) {
      traceFromExit(nodeId, idx, neighbors[j]);
    }
  }

  for (let nodeId = 0; nodeId < nodes.length; nodeId += 1) {
    const node = nodes[nodeId];
    if (node.kind !== 'junction') {
      continue;
    }
    // Collect unique external neighbor voxels of this junction super-node.
    const externalNeighbors = new Map();
    for (let i = 0; i < node.voxelIndices.length; i += 1) {
      const portIdx = node.voxelIndices[i];
      const neighbors = getSkelNeighbors(portIdx);
      for (let j = 0; j < neighbors.length; j += 1) {
        const nb = neighbors[j];
        if (voxelNodeId[nb] === nodeId) {
          continue;
        }
        if (!externalNeighbors.has(nb)) {
          externalNeighbors.set(nb, portIdx);
        }
      }
    }
    for (const [nb, portIdx] of externalNeighbors.entries()) {
      traceFromExit(nodeId, portIdx, nb);
    }
  }

  // Step 5: Detect pure closed loops (components where every voxel has deg === 2).
  for (let i = 0; i < skelIndices.length; i += 1) {
    const start = skelIndices[i];
    if (degree[start] !== 2 || visitedSlab[start] || voxelNodeId[start] >= 0) {
      continue;
    }
    const startVox = coordsFromIndex(start, nx, slice);
    const loopNodeId = nodes.length;
    voxelNodeId[start] = loopNodeId;
    nodes.push({
      id: loopNodeId,
      kind: 'loop-anchor',
      vox: startVox,
      voxelIndices: [start],
      maxEdtMm: edtMm ? edtMm[start] : 0,
      touchesFov: isFovVoxel(startVox[0], startVox[1], startVox[2], originalDims, cropOffset),
      removed: false,
    });

    const chainIndices = [start];
    const chainPoints = [startVox];
    visitedSlab[start] = 1;
    let prev = start;
    const firstNeighbors = getSkelNeighbors(start);
    let cur = firstNeighbors[0];

    while (cur !== undefined && cur !== start) {
      visitedSlab[cur] = 1;
      chainIndices.push(cur);
      chainPoints.push(coordsFromIndex(cur, nx, slice));
      const nbs = getSkelNeighbors(cur);
      const next = nbs.find((n) => n !== prev && (!visitedSlab[n] || (n === start && chainIndices.length >= 3)));
      prev = cur;
      cur = next;
    }
    chainIndices.push(start);
    chainPoints.push(startVox);

    segments.push({
      id: segments.length + 1,
      nodeA: loopNodeId,
      nodeB: loopNodeId,
      pointsVox: chainPoints,
      voxelIndices: chainIndices,
      isClosedLoop: true,
      rawLengthMm: polylineLengthMm(chainPoints, spacing),
      removed: false,
    });
  }

  // Helper: build adjacency map (nodeId -> array of active segment indices).
  const buildAdjacency = () => {
    const adj = new Map();
    for (let i = 0; i < nodes.length; i += 1) {
      if (!nodes[i].removed) {
        adj.set(i, []);
      }
    }
    for (let s = 0; s < segments.length; s += 1) {
      const seg = segments[s];
      if (seg.removed) {
        continue;
      }
      adj.get(seg.nodeA)?.push(s);
      if (seg.nodeB !== seg.nodeA) {
        adj.get(seg.nodeB)?.push(s);
      } else {
        // A self-loop contributes 2 to node valence.
        adj.get(seg.nodeA)?.push(s);
      }
    }
    return adj;
  };

  // Merge any junction node whose valence has dropped to 2 (from 2 distinct non-loop edges).
  const mergeDegreeTwoNodes = () => {
    let mergedAny = true;
    while (mergedAny) {
      mergedAny = false;
      const adj = buildAdjacency();
      for (const [nodeId, segList] of adj.entries()) {
        const node = nodes[nodeId];
        if (node.removed || node.kind !== 'junction') {
          continue;
        }
        if (segList.length === 0) {
          node.removed = true;
          continue;
        }
        if (segList.length === 1) {
          node.kind = 'endpoint';
          continue;
        }
        if (segList.length === 2 && segList[0] !== segList[1]) {
          const s1 = segments[segList[0]];
          const s2 = segments[segList[1]];
          if (s1.isClosedLoop || s2.isClosedLoop) {
            continue;
          }
          // Orient s1 so it ends at nodeId, and s2 so it starts at nodeId.
          const p1 = s1.nodeB === nodeId ? s1.pointsVox : [...s1.pointsVox].reverse();
          const v1 = s1.nodeB === nodeId ? s1.voxelIndices : [...s1.voxelIndices].reverse();
          const otherA = s1.nodeB === nodeId ? s1.nodeA : s1.nodeB;

          const p2 = s2.nodeA === nodeId ? s2.pointsVox : [...s2.pointsVox].reverse();
          const v2 = s2.nodeA === nodeId ? s2.voxelIndices : [...s2.voxelIndices].reverse();
          const otherB = s2.nodeA === nodeId ? s2.nodeB : s2.nodeA;

          const mergedPoints = [...p1, ...p2.slice(1)];
          const mergedVoxels = [...v1, ...v2.slice(1)];

          s1.nodeA = otherA;
          s1.nodeB = otherB;
          s1.pointsVox = mergedPoints;
          s1.voxelIndices = mergedVoxels;
          s1.isClosedLoop = otherA === otherB;
          s1.rawLengthMm = polylineLengthMm(mergedPoints, spacing);
          s2.removed = true;
          node.removed = true;
          mergedAny = true;
          break;
        }
      }
    }
  };

  // Initial cleanup in case a junction cluster had only 2 external exits.
  mergeDegreeTwoNodes();

  const rawSegmentCount = segments.filter((s) => !s.removed).length;
  const rawTotalLengthMm = segments
    .filter((s) => !s.removed)
    .reduce((acc, s) => acc + s.rawLengthMm, 0);

  // Step 6: Iterative radius-aware & length-based terminal spur pruning to fixpoint.
  let prunedSpurCount = 0;
  let prunedSpurLengthMm = 0;

  if (minSpurLengthMm > 0 || pruneContainedSpurs) {
    let changed = true;
    while (changed) {
      changed = false;
      const adj = buildAdjacency();

      // Collect candidate terminal spurs (one endpoint not touching FOV, one junction).
      const candidates = [];
      for (let s = 0; s < segments.length; s += 1) {
        const seg = segments[s];
        if (seg.removed || seg.isClosedLoop) {
          continue;
        }
        const nA = nodes[seg.nodeA];
        const nB = nodes[seg.nodeB];
        let ep = null;
        let junc = null;
        if (nA.kind === 'endpoint' && nB.kind === 'junction') {
          ep = nA;
          junc = nB;
        } else if (nB.kind === 'endpoint' && nA.kind === 'junction') {
          ep = nB;
          junc = nA;
        }
        if (!ep || !junc) {
          continue;
        }
        // Protect crop-truncated vessels exiting the FOV.
        if (ep.touchesFov) {
          continue;
        }
        const jDeg = adj.get(junc.id)?.length ?? 0;
        if (jDeg < 3) {
          continue;
        }
        const tipDistMm = stepLengthMm(ep.vox, junc.vox, spacing);
        const byLength = minSpurLengthMm > 0 && seg.rawLengthMm <= minSpurLengthMm + 1e-9;
        const byBulge =
          pruneContainedSpurs &&
          tipDistMm <= 1.25 * junc.maxEdtMm + 0.5 * maxSpacing;
        if (byLength || byBulge) {
          candidates.push({ segIdx: s, epId: ep.id, juncId: junc.id, len: seg.rawLengthMm });
        }
      }

      if (candidates.length === 0) {
        break;
      }

      // Prune shortest candidate first per pass so a multi-spur junction keeps its longest arm.
      candidates.sort((a, b) => a.len - b.len || a.segIdx - b.segIdx);
      const touchedJunctions = new Set();
      for (let i = 0; i < candidates.length; i += 1) {
        const cand = candidates[i];
        if (touchedJunctions.has(cand.juncId)) {
          continue;
        }
        const seg = segments[cand.segIdx];
        seg.removed = true;
        nodes[cand.epId].removed = true;
        touchedJunctions.add(cand.juncId);
        prunedSpurCount += 1;
        prunedSpurLengthMm += seg.rawLengthMm;
        changed = true;
      }

      if (changed) {
        mergeDegreeTwoNodes();
      }
    }
  }

  // Step 7: Optional standalone isolated segment length filter.
  let prunedIsolatedCount = 0;
  let prunedIsolatedLengthMm = 0;
  if (minIsolatedLengthMm > 0) {
    for (let s = 0; s < segments.length; s += 1) {
      const seg = segments[s];
      if (seg.removed || seg.isClosedLoop) {
        continue;
      }
      const nA = nodes[seg.nodeA];
      const nB = nodes[seg.nodeB];
      if (nA.kind === 'endpoint' && nB.kind === 'endpoint' && seg.rawLengthMm <= minIsolatedLengthMm + 1e-9) {
        seg.removed = true;
        nA.removed = true;
        nB.removed = true;
        prunedIsolatedCount += 1;
        prunedIsolatedLengthMm += seg.rawLengthMm;
      }
    }
  }

  // Step 8: Compact active nodes and segments with stable sequential IDs, and label connected components.
  const activeNodes = [];
  const oldToNewNode = new Map();
  const finalAdj = buildAdjacency();

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.removed) {
      continue;
    }
    const incident = finalAdj.get(i) ?? [];
    const deg = incident.length;
    if (deg === 0) {
      continue;
    }
    const newId = activeNodes.length + 1;
    oldToNewNode.set(i, newId);
    const pureSelfLoopAnchor =
      deg === 2 &&
      incident[0] === incident[1] &&
      segments[incident[0]].isClosedLoop;
    const kind =
      deg === 1
        ? 'endpoint'
        : (node.kind === 'loop-anchor' || pureSelfLoopAnchor) && deg === 2
          ? 'loop-anchor'
          : 'junction';
    activeNodes.push({
      id: newId,
      kind,
      degree: deg,
      vox: node.vox,
      voxelIndices: node.voxelIndices,
      maxEdtMm: node.maxEdtMm,
      touchesFov: node.touchesFov,
      componentId: 0,
      incidentSegmentIds: [],
    });
  }

  const activeSegments = [];
  for (let s = 0; s < segments.length; s += 1) {
    const seg = segments[s];
    if (seg.removed) {
      continue;
    }
    const nodeA = oldToNewNode.get(seg.nodeA);
    const nodeB = oldToNewNode.get(seg.nodeB);
    if (!nodeA || !nodeB) {
      continue;
    }
    const nA = activeNodes[nodeA - 1];
    const nB = activeNodes[nodeB - 1];
    let kind;
    if (seg.isClosedLoop) {
      kind = 'closed-loop';
    } else if (nA.kind === 'junction' && nB.kind === 'junction') {
      kind = 'junction-junction';
    } else if (nA.kind === 'endpoint' && nB.kind === 'endpoint') {
      kind = 'endpoint-endpoint';
    } else {
      kind = 'junction-endpoint';
    }
    const newSegId = activeSegments.length + 1;
    activeSegments.push({
      id: newSegId,
      componentId: 0,
      kind,
      nodeA,
      nodeB,
      isClosedLoop: seg.isClosedLoop,
      touchesFovBoundary: nA.touchesFov || nB.touchesFov,
      pointsVox: seg.pointsVox,
      voxelIndices: seg.voxelIndices,
      rawLengthMm: seg.rawLengthMm,
    });
    nA.incidentSegmentIds.push(newSegId);
    if (nodeB !== nodeA) {
      nB.incidentSegmentIds.push(newSegId);
    }
  }

  // Connected component IDs on the compacted graph.
  const nodeAdj = Array.from({ length: activeNodes.length + 1 }, () => []);
  for (let i = 0; i < activeSegments.length; i += 1) {
    const seg = activeSegments[i];
    nodeAdj[seg.nodeA].push(seg.nodeB);
    if (seg.nodeB !== seg.nodeA) {
      nodeAdj[seg.nodeB].push(seg.nodeA);
    }
  }
  let compCount = 0;
  for (let i = 0; i < activeNodes.length; i += 1) {
    if (activeNodes[i].componentId > 0) {
      continue;
    }
    compCount += 1;
    const queue = [activeNodes[i].id];
    activeNodes[i].componentId = compCount;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head];
      head += 1;
      const nbs = nodeAdj[cur];
      for (let j = 0; j < nbs.length; j += 1) {
        const nb = nbs[j];
        if (activeNodes[nb - 1].componentId === 0) {
          activeNodes[nb - 1].componentId = compCount;
          queue.push(nb);
        }
      }
    }
  }
  for (let i = 0; i < activeSegments.length; i += 1) {
    const seg = activeSegments[i];
    seg.componentId = activeNodes[seg.nodeA - 1].componentId;
  }

  // First Betti number (cycle rank) = E - V + C on active graph.
  const E = activeSegments.length;
  const V = activeNodes.length;
  const C = compCount;
  const cycleRankBetti1 = Math.max(0, E - V + C);

  return {
    nodes: activeNodes,
    segments: activeSegments,
    isolatedVoxels,
    stats: {
      skeletonVoxelCount: skelIndices.length,
      isolatedVoxelCount: isolatedVoxels.length,
      rawSegmentCount,
      rawTotalLengthMm,
      prunedSpurCount,
      prunedSpurLengthMm,
      prunedIsolatedCount,
      prunedIsolatedLengthMm,
      graphComponentCount: compCount,
      cycleRankBetti1,
    },
  };
}
