import { computeParcelOverlap, summarizeNetworkOverlap } from './parcel-overlap.js';
import {
  fcWeightedSum,
  parcelResultToChannelWeights,
  summaryToNetworkWeights,
} from './fc-weighted-sum.js';
import { applyThresholdDetailed } from './threshold.js';

// Preparation deliberately ends at a candidate. Approval belongs to the caller.
export async function prepare(input, runtime) {
  const brainMask = runtime.extractBrain ? await runtime.extractBrain(input) : null;
  const aligned = runtime.prealign ? await runtime.prealign(input, brainMask) : input;
  const segmented = await runtime.segment(aligned);
  const candidate = runtime.projectCandidate
    ? await runtime.projectCandidate(segmented, aligned, input)
    : segmented;
  return { candidate, aligned, brainMask, requiresReview: true };
}

export function atlasOverlap(lesion, atlas, atlasOption) {
  const parcelResult = computeParcelOverlap({ lesion, atlas: atlas.data, dims: atlas.dims });
  const labelMap =
    atlasOption.weightSource === 'parcel'
      ? atlas.parcelLabels || atlas.manifestEntry?.parcelLabels || {}
      : atlas.networkLabels || atlas.manifestEntry?.networkLabels || {};
  const summary =
    atlasOption.weightSource === 'parcel'
      ? {
          totalLesionVoxels: parcelResult.totalLesionVoxels,
          networks: parcelResult.parcels.map((parcel) => ({
            network: labelMap[parcel.label] || `Parcel ${parcel.label}`,
            voxelsInLesion: parcel.voxelsInLesion,
            fractionOfLesion: parcel.fractionOfLesion,
            parcels: [parcel.label],
          })),
        }
      : summarizeNetworkOverlap(parcelResult, labelMap);
  const networkSizes = {};
  for (const label of atlas.data) {
    if (!label || !Object.prototype.hasOwnProperty.call(labelMap, label)) continue;
    const name = labelMap[label] || `Parcel ${label}`;
    networkSizes[name] = (networkSizes[name] || 0) + 1;
  }
  return { parcelResult, summary, networkSizes };
}

export function networkMap(overlap, pack, index, atlasOption) {
  const labels =
    pack.channelLabels || index.channelLabels || index.parcelLabels || index.networkLabels || {};
  const weights =
    atlasOption.weightSource === 'parcel'
      ? parcelResultToChannelWeights(overlap.parcelResult, labels).weights
      : summaryToNetworkWeights(
          overlap.summary,
          Object.keys(labels)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => labels[key])
        );
  const dims = index.shape.slice(1);
  return { data: fcWeightedSum(weights, pack.tMaps, dims), dims, weights };
}

export async function map(
  { lesion, atlas, overlap: preparedOverlap, atlasOption, reviewed, threshold },
  runtime
) {
  if (reviewed !== true)
    throw new Error('Review the lesion mask before mapping; explicit approval is required.');
  if (!preparedOverlap) runtime.assertAtlasGrid(lesion, atlas);
  const overlap = preparedOverlap || atlasOverlap(lesion.data, atlas, atlasOption);
  if (!overlap.parcelResult.parcels.length)
    throw new Error('No labelled atlas parcels overlap the lesion.');
  const { pack, index, reference } = await runtime.connectome(
    overlap.parcelResult.parcels.map((parcel) => String(parcel.label))
  );
  const result = networkMap(overlap, pack, index, atlasOption);
  if (result.dims.some((value, axis) => value !== reference.dims[axis]))
    throw new Error('FC pack dimensions do not match its reference atlas.');
  return {
    ...result,
    ...overlap,
    reference,
    threshold: applyThresholdDetailed(result.data, result.dims, threshold),
  };
}

export function filterSummaryByMinCluster(summary, minClusterVoxels = 0) {
  if (!summary || !Array.isArray(summary.networks)) return summary || null;
  const minVoxels = Math.max(0, Math.floor(Number(minClusterVoxels)) || 0);
  if (minVoxels <= 1) return summary;
  return {
    ...summary,
    networks: summary.networks.filter((row) => (Number(row?.voxelsInLesion) || 0) >= minVoxels),
  };
}
