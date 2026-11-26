// Exact Lundberg TreeSHAP evaluator for OpenADS binary forest files (models/aa-shap/*.bin).

const ATLAS_FEATURE_ORDER = {
  vascular: ['volml', 'ACA', 'MCA', 'PCA', 'cerebellar', 'basilar', 'Lenticulostriate', 'Choroidal & Thalamoperfurating', 'watershed'],
  lobe: ['volml', 'basal ganglia', 'deep white matter', 'cerebellum', 'frontal', 'insula', 'internal capsule', 'brainstem', 'occipital', 'parietal', 'temporal', 'thalamus'],
  aspects: ['volml', 'Caudate', 'lentiform', 'IC', 'insula', 'M1', 'M2', 'M3', 'M6', 'M5', 'M4'],
  aspectpc: ['volml', 'PCA', 'Thalamus', 'Cerebellum', 'Pons', 'Midbrain'],
};

function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
}

const round4 = (x) => roundHalfEven(x * 1e4) / 1e4;

export function decodeForestBinary(buffer, entry) {
  const nTrees = entry.nTrees;
  const nNodes = entry.nNodes;
  let offset = 0;
  const offsets = new Int32Array(buffer.slice(offset, offset + 4 * (nTrees + 1)));
  offset += 4 * (nTrees + 1);
  offset += (8 - (offset % 8)) % 8;

  let value1;
  let value0;
  let cover;
  if (entry.valueEncoding === 'f64') {
    value1 = new Float64Array(buffer.slice(offset, offset + 8 * nNodes));
    offset += 8 * nNodes;
    cover = new Float64Array(buffer.slice(offset, offset + 8 * nNodes));
    offset += 8 * nNodes;
    value0 = new Float64Array(nNodes);
    for (let i = 0; i < nNodes; i++) value0[i] = 1 - value1[i];
  }

  const threshold = new Float32Array(buffer.slice(offset, offset + 4 * nNodes));
  offset += 4 * nNodes;

  if (entry.valueEncoding === 'u16') {
    const pos = new Uint16Array(buffer.slice(offset, offset + 2 * nNodes));
    offset += 2 * nNodes;
    const tot = new Uint16Array(buffer.slice(offset, offset + 2 * nNodes));
    offset += 2 * nNodes;
    value1 = new Float64Array(nNodes);
    value0 = new Float64Array(nNodes);
    cover = new Float64Array(nNodes);
    for (let i = 0; i < nNodes; i++) {
      cover[i] = tot[i];
      value1[i] = tot[i] > 0 ? pos[i] / tot[i] : 0;
      value0[i] = tot[i] > 0 ? (tot[i] - pos[i]) / tot[i] : 0;
    }
  }

  const right = new Int16Array(buffer.slice(offset, offset + 2 * nNodes));
  offset += 2 * nNodes;
  const feature = new Int8Array(buffer.slice(offset, offset + nNodes));
  offset += nNodes;
  if (offset !== buffer.byteLength) {
    throw new Error(`Forest ${entry.file}: byte length mismatch (${offset} != ${buffer.byteLength}).`);
  }

  let maxDepth = 0;
  const depthStack = new Int32Array(1024);
  for (let t = 0; t < nTrees; t++) {
    const base = offsets[t];
    const len = offsets[t + 1] - base;
    depthStack[0] = 0;
    for (let i = 0; i < len; i++) {
      const d = depthStack[i];
      if (right[base + i] === -1) {
        if (d > maxDepth) maxDepth = d;
      } else {
        depthStack[i + 1] = d + 1;
        depthStack[right[base + i]] = d + 1;
      }
    }
  }

  return { nTrees, offsets, threshold, right, feature, cover, value0, value1, maxDepth };
}

function predictForest(forest, x) {
  let p0 = 0;
  let p1 = 0;
  for (let t = 0; t < forest.nTrees; t++) {
    const base = forest.offsets[t];
    let node = 0;
    while (forest.right[base + node] !== -1) {
      node = x[forest.feature[base + node]] <= forest.threshold[base + node] ? node + 1 : forest.right[base + node];
    }
    p0 += forest.value0[base + node];
    p1 += forest.value1[base + node];
  }
  return [p0 / forest.nTrees, p1 / forest.nTrees];
}

class PathState {
  constructor(size) {
    this.feat = new Int32Array(size);
    this.zero = new Float64Array(size);
    this.one = new Float64Array(size);
    this.pw = new Float64Array(size);
  }
}

function extendPath(st, base, uniqueDepth, zeroFrac, oneFrac, featIdx) {
  st.feat[base + uniqueDepth] = featIdx;
  st.zero[base + uniqueDepth] = zeroFrac;
  st.one[base + uniqueDepth] = oneFrac;
  st.pw[base + uniqueDepth] = uniqueDepth === 0 ? 1 : 0;
  for (let i = uniqueDepth - 1; i >= 0; i--) {
    st.pw[base + i + 1] += (oneFrac * st.pw[base + i] * (i + 1)) / (uniqueDepth + 1);
    st.pw[base + i] = (zeroFrac * st.pw[base + i] * (uniqueDepth - i)) / (uniqueDepth + 1);
  }
}

function unwindPath(st, base, uniqueDepth, idx) {
  const one = st.one[base + idx];
  const zero = st.zero[base + idx];
  let nextOne = st.pw[base + uniqueDepth];
  for (let i = uniqueDepth - 1; i >= 0; i--) {
    if (one !== 0) {
      const tmp = st.pw[base + i];
      st.pw[base + i] = (nextOne * (uniqueDepth + 1)) / ((i + 1) * one);
      nextOne = tmp - (st.pw[base + i] * zero * (uniqueDepth - i)) / (uniqueDepth + 1);
    } else {
      st.pw[base + i] = (st.pw[base + i] * (uniqueDepth + 1)) / (zero * (uniqueDepth - i));
    }
  }
  for (let i = idx; i < uniqueDepth; i++) {
    st.feat[base + i] = st.feat[base + i + 1];
    st.zero[base + i] = st.zero[base + i + 1];
    st.one[base + i] = st.one[base + i + 1];
  }
}

function unwoundPathSum(st, base, uniqueDepth, idx) {
  const one = st.one[base + idx];
  const zero = st.zero[base + idx];
  let nextOne = st.pw[base + uniqueDepth];
  let total = 0;
  for (let i = uniqueDepth - 1; i >= 0; i--) {
    if (one !== 0) {
      const tmp = (nextOne * (uniqueDepth + 1)) / ((i + 1) * one);
      total += tmp;
      nextOne = st.pw[base + i] - tmp * zero * ((uniqueDepth - i) / (uniqueDepth + 1));
    } else if (zero !== 0) {
      total += st.pw[base + i] / zero / ((uniqueDepth - i) / (uniqueDepth + 1));
    }
  }
  return total;
}

function recurseTree(forest, treeBase, vals, weight, x, phi, nodeIdx, st, pathBase, depth, pZero, pOne, pFeat) {
  const nextBase = pathBase + depth + 1;
  if (depth > 0) {
    st.feat.copyWithin(nextBase, pathBase, pathBase + depth);
    st.zero.copyWithin(nextBase, pathBase, pathBase + depth);
    st.one.copyWithin(nextBase, pathBase, pathBase + depth);
    st.pw.copyWithin(nextBase, pathBase, pathBase + depth);
  }
  extendPath(st, nextBase, depth, pZero, pOne, pFeat);

  const absNode = treeBase + nodeIdx;
  const rightRel = forest.right[absNode];
  if (rightRel === -1) {
    const leafVal = vals[absNode] * weight;
    for (let i = 1; i <= depth; i++) {
      const w = unwoundPathSum(st, nextBase, depth, i);
      phi[st.feat[nextBase + i]] += w * (st.one[nextBase + i] - st.zero[nextBase + i]) * leafVal;
    }
    return;
  }

  const feat = forest.feature[absNode];
  const leftRel = nodeIdx + 1;
  const hot = x[feat] <= forest.threshold[absNode] ? leftRel : rightRel;
  const cold = hot === leftRel ? rightRel : leftRel;
  const nodeCover = forest.cover[absNode];
  const hotZero = forest.cover[treeBase + hot] / nodeCover;
  const coldZero = forest.cover[treeBase + cold] / nodeCover;

  let incomingZero = 1;
  let incomingOne = 1;
  let existing = 0;
  while (existing <= depth && st.feat[nextBase + existing] !== feat) existing++;
  let nextDepth = depth;
  if (existing !== depth + 1) {
    incomingZero = st.zero[nextBase + existing];
    incomingOne = st.one[nextBase + existing];
    unwindPath(st, nextBase, nextDepth, existing);
    nextDepth -= 1;
  }

  recurseTree(forest, treeBase, vals, weight, x, phi, hot, st, nextBase, nextDepth + 1, hotZero * incomingZero, incomingOne, feat);
  recurseTree(forest, treeBase, vals, weight, x, phi, cold, st, nextBase, nextDepth + 1, coldZero * incomingZero, 0, feat);
}

export function treeShapForest(forest, x, classIndex = 1) {
  const nFeat = x.length;
  const phi = new Float64Array(nFeat + 1);
  const vals = classIndex === 1 ? forest.value1 : forest.value0;
  const weight = 1 / forest.nTrees;
  const maxD = forest.maxDepth + 2;
  const state = new PathState(((maxD + 3) * (maxD + 4)) / 2);
  let base = 0;
  for (let t = 0; t < forest.nTrees; t++) {
    const treeBase = forest.offsets[t];
    base += vals[treeBase] * weight;
    recurseTree(forest, treeBase, vals, weight, x, phi, 0, state, 0, 0, 1, 1, nFeat);
  }
  return { values: Array.from(phi.subarray(0, nFeat)), base };
}

function standardize(vec, entry) {
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] - entry.scalerMean[i]) / entry.scalerScale[i];
  }
  return out;
}

export function evaluateAtlasShap({ atlasKey, manifest, forestsByRoi, qfvMap }) {
  const lower = new Map();
  for (const [k, v] of qfvMap.entries()) lower.set(k.toLowerCase(), v);
  const canonical = ATLAS_FEATURE_ORDER[atlasKey] || manifest.features;
  const baseVec = manifest.features.map((feat, i) => {
    const alias = canonical[i] || feat;
    const raw =
      qfvMap.get(alias) ??
      qfvMap.get(feat) ??
      lower.get(alias.toLowerCase()) ??
      lower.get(feat.toLowerCase()) ??
      (i === 0 ? qfvMap.get('logvol') : undefined);
    return round4(raw !== undefined && Number.isFinite(raw) ? raw : 0);
  });

  const outputs = [];
  for (const entry of manifest.models) {
    let rawVec = baseVec;
    let featureNames = manifest.features;
    if (atlasKey === 'aspectpc') {
      const m = new Map(manifest.features.map((f, i) => [f, baseVec[i]]));
      const vol = m.get('volml') ?? 0;
      const logv = Math.log10(Math.max(vol, 1e-6));
      m.set('logvol', logv);
      m.set('sqrtvol', Math.sqrt(Math.max(vol, 0)));
      for (const name of ['PCA', 'Thalamus', 'Cerebellum', 'Pons', 'Midbrain']) {
        m.set(`${name}_x_vol`, (m.get(name) ?? 0) * logv);
      }
      rawVec = entry.featureCols.map((c) => m.get(c) ?? 0);
      featureNames = entry.featureCols;
    }

    const rounded = rawVec.map(round4);
    const scaled = standardize(rounded, entry);
    if (entry.kind === 'linear') {
      let score = entry.intercept;
      for (let i = 0; i < scaled.length; i++) score += entry.coef[i] * scaled[i];
      outputs.push({
        roi: entry.roi,
        featureNames,
        values: rounded.map(() => 0),
        baseValue: score,
        outValue: score,
        predictedAffected: score > 0.5,
      });
      continue;
    }

    const forest = forestsByRoi.get(entry.roi);
    if (!forest) continue;
    const [p0, p1] = predictForest(forest, Float32Array.from(standardize(rawVec, entry)));
    const { values, base } = treeShapForest(forest, Float32Array.from(scaled), 1);
    const attributions = featureNames
      .map((feature, i) => ({ feature, value: rounded[i], attribution: values[i] }))
      .sort((a, b) => Math.abs(b.attribution) - Math.abs(a.attribution));
    outputs.push({
      roi: entry.roi,
      probability: p1,
      predictedAffected: p1 > p0,
      baseValue: base,
      attributions,
    });
  }
  return outputs;
}
