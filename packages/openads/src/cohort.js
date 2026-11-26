// StrokeView client-side UMAP projection and k-NN clinical phenotype matching
// against the 1,861-subject StrokeFAIR acute stroke reference cohort.

const CONTINUOUS_METRICS = [
  { key: 'Age', label: 'Age (years)' },
  { key: 'NIHSS', label: 'NIHSS' },
  { key: 'BMI', label: 'BMI' },
  { key: 'Hospital-days', label: 'Hospital stay (days)' },
  { key: '90days-mRS', label: '90-day mRS' },
  { key: 'Lesion-volume', label: 'Lesion volume (voxels)' },
];

const CATEGORICAL_METRICS = [
  { key: 'Sex', label: 'Sex' },
  { key: 'Race', label: 'Race' },
  { key: 'Side', label: 'Hemisphere' },
];

function euclideanDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function scaleCohortFeatures(values, mean, scale) {
  return values.map((v, i) => (scale[i] ? (v - mean[i]) / scale[i] : 0));
}

export function inferDominantRegion(featureValues, features) {
  let bestIdx = -1;
  let bestVal = 0;
  for (let i = 0; i < featureValues.length; i++) {
    if (featureValues[i] > bestVal) {
      bestVal = featureValues[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return 'Unknown';
  return features[bestIdx].replace(/^QFV_/i, '');
}

export function projectSubjectOntoCohort({ qfvByRegion, refData, kNeighbors = 50, kProject = 20 }) {
  const lowerMap = new Map();
  for (const [k, v] of Object.entries(qfvByRegion || {})) {
    lowerMap.set(k.toLowerCase(), Number(v) || 0);
  }
  const featureValues = refData.features.map((feat) => {
    const clean = feat.replace(/^QFV_/i, '').toLowerCase();
    return lowerMap.get(clean) ?? 0;
  });
  const scaled = scaleCohortFeatures(featureValues, refData.scaler_mean, refData.scaler_scale);

  // Step 1: kProject nearest neighbors in scaled QFV space -> IDW UMAP coordinate
  const featureDists = refData.points.map((point, idx) => ({
    idx,
    dist: euclideanDist(scaled, point.scaled_features),
  }));
  featureDists.sort((a, b) => a.dist - b.dist);
  const projNeighbors = featureDists.slice(0, Math.min(kProject, featureDists.length));

  let wx = 0;
  let wy = 0;
  let totalW = 0;
  for (const n of projNeighbors) {
    const w = 1 / (n.dist + 1e-10);
    wx += w * refData.points[n.idx].x;
    wy += w * refData.points[n.idx].y;
    totalW += w;
  }
  const position = { x: totalW > 0 ? wx / totalW : 0, y: totalW > 0 ? wy / totalW : 0 };

  // Step 2: k nearest neighbors in 2D UMAP space (matches StrokeView)
  const umapDists = refData.points.map((point, idx) => ({
    idx,
    dist: euclideanDist([position.x, position.y], [point.x, point.y]),
  }));
  umapDists.sort((a, b) => a.dist - b.dist);
  const clampedK = Math.max(1, Math.min(kNeighbors, umapDists.length));
  const neighbors = umapDists.slice(0, clampedK).map((n, rank) => {
    const pt = refData.points[n.idx];
    return {
      rank: rank + 1,
      distance: n.dist,
      x: pt.x,
      y: pt.y,
      colorLabel: pt.ColorLabel || 'Unknown',
      hoverText: pt.HoverText || '',
      phenotype: pt.phenotype || {},
    };
  });

  const dominantLabel = inferDominantRegion(featureValues, refData.features);
  const summary = summarizeNeighborPhenotypes(neighbors);
  return {
    title: refData.title,
    position,
    dominantLabel,
    featureValues,
    neighbors,
    summary,
  };
}

export function summarizeNeighborPhenotypes(neighbors) {
  const continuous = [];
  for (const { key, label } of CONTINUOUS_METRICS) {
    const vals = neighbors
      .map((n) => parseFloat(n.phenotype?.[key]))
      .filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length);
    continuous.push({ key, label, n: vals.length, mean, sd });
  }

  const categorical = [];
  for (const { key, label } of CATEGORICAL_METRICS) {
    const vals = neighbors
      .map((n) => n.phenotype?.[key])
      .filter((v) => v != null && String(v).trim() !== '');
    if (!vals.length) continue;
    const counts = new Map();
    for (const v of vals) {
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const entries = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count, percent: (count / vals.length) * 100 }));
    categorical.push({ key, label, n: vals.length, entries });
  }

  return { count: neighbors.length, continuous, categorical };
}

export function cohortSummaryCsv(summary) {
  const rows = [['Metric', 'Value', 'N']];
  for (const item of summary.continuous) {
    rows.push([item.label, `${item.mean.toFixed(1)} (${item.sd.toFixed(1)})`, String(item.n)]);
  }
  for (const group of summary.categorical) {
    rows.push([`-- ${group.label} --`, '', String(group.n)]);
    for (const entry of group.entries) {
      rows.push([`  ${entry.value}`, `${entry.count} (${entry.percent.toFixed(0)}%)`, String(group.n)]);
    }
  }
  return rows
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n') + '\n';
}
