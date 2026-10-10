import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// ORT 1.29 telemetry otherwise creates a device ID/database outside result directories.
process.env.ORT_DISABLE_TELEMETRY = '1';
const ort = await import('onnxruntime-node');
import { getOrientationTransform } from '@neurodesk/webapp-components/volume';
import manifest from '../model.manifest.json' with { type: 'json' };
import assets from '../assets.lock.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import { prepare, map, filterSummaryByMinCluster } from './pipeline.js';
import { decodeVolume, assertAtlasGrid } from './nifti.js';
import { segmentCandidate } from './segmentation.js';
import { runSynthStrip } from './brain-extraction.js';
import { prealignVolumes, registerVolumes, warpReviewedMask } from './alignment.js';
import { resampleAffine } from './resample.js';
import { orientFloat32, inverseOrient } from './volume-utils.js';
import { decodeFcPack } from './fc-weighted-sum.js';
import { writeNifti1 } from './nifti-writer.js';
import { serializeOverlapCsv } from './overlap-export.js';

export const MODEL_ASSETS = assets;
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
export const defaultCacheDir = () =>
  process.env.NEURODESK_CALMAR_MODEL_DIR ||
  join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'neurodesk',
    'calmar',
    hash(JSON.stringify(assets)).slice(0, 16)
  );
const offlineDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function validateOptions({
  atlas = 'schaefer400',
  threads = 4,
  threshold = 0.95,
  minCluster = 30,
} = {}) {
  if (!['schaefer400', 'yeo7'].includes(atlas))
    throw new Error('Atlas must be schaefer400 or yeo7.');
  if (!Number.isInteger(Number(threads)) || Number(threads) < 1)
    throw new Error('Threads must be a positive integer.');
  if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0 || Number(threshold) > 1)
    throw new Error('Threshold must be a quantile between 0 and 1.');
  if (!Number.isInteger(Number(minCluster)) || Number(minCluster) < 0)
    throw new Error('Minimum cluster size must be a nonnegative integer.');
  return {
    atlas,
    threads: Number(threads),
    threshold: Number(threshold),
    minCluster: Number(minCluster),
  };
}

export async function loadAsset(
  asset,
  { cacheDir = defaultCacheDir(), offline = offlineDefault() } = {}
) {
  const path = join(cacheDir, asset.filename);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    if (offline)
      throw new Error(
        `Offline asset missing: ${asset.filename}. Run calmar download-models while online.`
      );
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`Asset ${asset.filename}: HTTP ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
      throw new Error(`Asset checksum failed: ${asset.filename}.`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
    throw new Error(`Asset checksum failed: ${asset.filename}.`);
  return bytes;
}

export async function downloadModels(options = {}) {
  for (const asset of assets) await loadAsset(asset, options);
  return { directory: resolve(options.cacheDir || defaultCacheDir()), count: assets.length };
}

export async function assertNewOutput(output) {
  if (!output) throw new Error('An output directory is required.');
  try {
    if ((await readdir(output)).length)
      throw new Error('Output directory is not empty. Choose a new or empty directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const getAsset = (id, options) => {
  const asset = assets.find((entry) => entry.id === id);
  if (!asset) throw new Error(`Unknown asset ${id}.`);
  return loadAsset(asset, options);
};

const writeVolume = (volume, description) =>
  Buffer.from(
    writeNifti1(volume.data, {
      dims: volume.dims,
      spacing: volume.spacing,
      affine: volume.affine.flat(),
      description,
    })
  );

export async function prepareLesion({ input, output, ...options }) {
  const settings = validateOptions(options);
  await assertNewOutput(output);
  if (!input) throw new Error('A structural T1 image is required.');
  const volume = decodeVolume(await readFile(input));
  const reference = await loadAtlas('lnm-mni160', options);
  let aligned;
  const entry = manifest.modelAssets.find((asset) => asset.id === 'lnm-stroke-lesion');
  const model = await getAsset(entry.id, options);
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: settings.threads,
    interOpNumThreads: 1,
  });
  let result;
  try {
    result = await prepare(volume, {
      extractBrain: (image) => extractBrain(image, settings, options),
      prealign: async (image, brain) => {
        aligned = prealignVolumes(image, brain, reference);
        return { ...aligned, spacing: [1, 1, 1] };
      },
      segment: (image) =>
        segmentCandidate(image, entry, async (patch, dims) => {
          const tensor = new ort.Tensor('float32', patch, [1, 1, ...dims]);
          try {
            return (await session.run({ [session.inputNames[0]]: tensor }))[session.outputNames[0]]
              .data;
          } finally {
            tensor.dispose();
          }
        }),
      projectCandidate: (candidate) => ({
        ...volume,
        data: Uint8Array.from(
          resampleAffine(
            candidate.data,
            candidate.dims,
            aligned.samplingAffine,
            volume.dims,
            volume.affine,
            'nearest'
          ),
          (value) => (value > 0.5 ? 1 : 0)
        ),
      }),
    });
  } finally {
    await session.release();
  }
  const candidate = result.candidate;
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'candidate-lesion.nii'),
    writeVolume(candidate, 'CALMAR candidate; human review required')
  );
  const provenance = {
    tool: 'calmar',
    version: packageJson.version,
    requiresReview: true,
    inputSha256: hash(await readFile(input)),
    models: ['lnm-synthstrip', entry.id].map((id) => {
      const model = manifest.modelAssets.find((asset) => asset.id === id);
      return { id, checksum: model.checksum };
    }),
    segmentation: {
      overlap: entry.overlap,
      testTimeAugmentation: entry.testTimeAugmentation,
      threshold: entry.probabilityThreshold,
      minComponentSize: entry.minComponentSize,
    },
    grid: { dims: volume.dims, affine: volume.affine },
    nextStep:
      'Review and edit the native-space candidate. Run calmar map --reviewed with --structural for a native-space mask, or provide a reviewed mask on the selected atlas grid.',
  };
  await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

const atlasOptions = {
  yeo7: {
    id: 'yeo7',
    overlapAtlasAssetId: 'yeo7-2mm',
    connectomeAssetId: 'yeo7-fc-pack',
    weightSource: 'network',
  },
  schaefer400: {
    id: 'schaefer400',
    overlapAtlasAssetId: 'schaefer400-7n-2mm',
    connectomeAssetId: 'schaefer400-fc-pack-development-n155-4mm',
    weightSource: 'parcel',
  },
};

async function loadAtlas(id, options) {
  const entry = manifest.atlasAssets.find((asset) => asset.id === id);
  return {
    ...decodeVolume(await getAsset(id, options)),
    manifestEntry: entry,
    parcelLabels: entry.parcelLabels,
    networkLabels: entry.networkLabels,
  };
}

async function extractBrain(volume, settings, options) {
  const { perm, flip } = getOrientationTransform(volume.affine);
  const ras = orientFloat32(volume.data, volume.dims, perm, flip);
  const brain = await runSynthStrip({
    rasData: ras.data,
    rasDims: ras.dims,
    rasSpacing: perm.map((axis) => volume.spacing[axis]),
    modelArrayBuffer: buffer(await getAsset('lnm-synthstrip', options)),
    ort: {
      ...ort,
      InferenceSession: {
        create: (model, sessionOptions) =>
          ort.InferenceSession.create(model, {
            ...sessionOptions,
            intraOpNumThreads: settings.threads,
            interOpNumThreads: 1,
          }),
      },
    },
    executionProviders: ['cpu'],
    fast: true,
    dilate: false,
  });
  return inverseOrient(brain.mask, ras.dims, perm, flip, volume.dims);
}

async function reviewedMaskToAtlas(lesion, structural, atlas, settings, options) {
  const nativeBrain = await extractBrain(structural, settings, options);
  const reference = await loadAtlas('lnm-mni160', options);
  const aligned = prealignVolumes(structural, nativeBrain, reference);
  const alignedMask = Uint8Array.from(
    resampleAffine(
      lesion.data,
      lesion.dims,
      lesion.affine,
      aligned.dims,
      aligned.samplingAffine,
      'nearest'
    ),
    (value) => (value > 0.5 ? 1 : 0)
  );
  const entry = manifest.modelAssets.find((asset) => asset.id === 'lnm-synthmorph-mni');
  const session = await ort.InferenceSession.create(await getAsset(entry.id, options), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: settings.threads,
    interOpNumThreads: 1,
  });
  let displacement;
  try {
    displacement = await registerVolumes(
      aligned.data,
      aligned.brainMask,
      reference,
      entry.browserRuntime.inputDims,
      async (source, target, dims) => {
        const first = new ort.Tensor('float32', source, [1, ...dims, 1]);
        const second = new ort.Tensor('float32', target, [1, ...dims, 1]);
        try {
          const output = (
            await session.run({ [session.inputNames[0]]: first, [session.inputNames[1]]: second })
          )[session.outputNames[0]];
          return { data: output.data, dims: output.dims.slice(1, 4) };
        } finally {
          first.dispose();
          second.dispose();
        }
      }
    );
  } finally {
    await session.release();
  }
  const warped = warpReviewedMask(alignedMask, aligned.dims, displacement);
  return {
    ...atlas,
    data: Uint8Array.from(
      resampleAffine(warped, reference.dims, reference.affine, atlas.dims, atlas.affine, 'nearest'),
      (value) => (value > 0.5 ? 1 : 0)
    ),
  };
}

export async function mapLesion({ input, output, structural, reviewed = false, ...options }) {
  const settings = validateOptions(options);
  if (!reviewed) throw new Error('Review the lesion mask first and pass --reviewed explicitly.');
  await assertNewOutput(output);
  if (!input) throw new Error('An atlas-space lesion mask is required.');
  let lesion = decodeVolume(await readFile(input));
  if (lesion.data.some((value) => value !== 0 && value !== 1))
    throw new Error('The reviewed lesion must be a binary mask.');
  const structuralVolume = structural ? decodeVolume(await readFile(structural)) : null;
  if (structuralVolume) {
    assertAtlasGrid(
      lesion,
      structuralVolume,
      'Reviewed native lesion mask must match the --structural T1 dimensions and affine.'
    );
  }
  const atlasOption = atlasOptions[settings.atlas];
  const atlas = await loadAtlas(atlasOption.overlapAtlasAssetId, options);
  if (structural)
    lesion = await reviewedMaskToAtlas(
      lesion,
      structuralVolume,
      atlas,
      settings,
      options
    );
  const entry = manifest.connectomeAssets.find(
    (asset) => asset.id === atlasOption.connectomeAssetId
  );
  const result = await map(
    {
      lesion,
      atlas,
      atlasOption,
      reviewed,
      threshold: {
        mode: 'percentile',
        value: settings.threshold,
        symmetric: true,
        minClusterVoxels: settings.minCluster,
      },
    },
    {
      assertAtlasGrid,
      connectome: async (requestedLabels) => {
        const index = JSON.parse(await getAsset(entry.id + '-index', options));
        let pack;
        if (!entry.sharded)
          pack = decodeFcPack(buffer(await getAsset(entry.id, options)), {
            voxelOrder: entry.voxelOrder,
            ...index,
          });
        else {
          const tMaps = [];
          const channelLabels = {};
          for (const shard of index.shards) {
            const wanted = shard.channelLabels
              .map(String)
              .filter((label) => requestedLabels.includes(label));
            if (!wanted.length) continue;
            const asset = assets.find((asset) =>
              asset.filename.endsWith('/' + shard.filename.split('/').at(-1))
            );
            const decoded = decodeFcPack(buffer(await loadAsset(asset, options)), {
              ...index,
              ...shard,
              shape: [shard.channelLabels.length, ...index.shape.slice(1)],
              channelLabels: Object.fromEntries(
                shard.channelLabels.map((label) => [label, index.channelLabels[label]])
              ),
            });
            for (const label of wanted) {
              tMaps.push(decoded.tMaps[shard.channelLabels.map(String).indexOf(label)]);
              channelLabels[label] = index.channelLabels[label];
            }
          }
          pack = { tMaps, channelLabels };
        }
        return { pack, index, reference: await loadAtlas(entry.atlasAssetId, options) };
      },
    }
  );
  await mkdir(output, { recursive: true });
  const geometry = {
    dims: result.dims,
    affine: result.reference.affine,
    spacing: result.reference.spacing,
  };
  await writeFile(
    join(output, 'reviewed-lesion-atlas.nii'),
    writeVolume(
      { ...lesion, data: Uint8Array.from(lesion.data) },
      'CALMAR reviewed lesion on selected atlas grid'
    )
  );
  await writeFile(
    join(output, 'lnm-network-map.nii'),
    writeVolume({ ...geometry, data: result.data }, 'CALMAR FC weighted sum')
  );
  await writeFile(
    join(output, 'lnm-network-map-thresh.nii'),
    writeVolume(
      { ...geometry, data: result.threshold.mask },
      'CALMAR reviewed lesion network threshold'
    )
  );
  await writeFile(
    join(output, 'lnm-overlap.csv'),
    serializeOverlapCsv(filterSummaryByMinCluster(result.summary, settings.minCluster), {
      networkSizes: result.networkSizes,
    })
  );
  const provenance = {
    tool: 'calmar',
    version: packageJson.version,
    reviewed: true,
    inputSha256: hash(await readFile(input)),
    atlas: atlasOption.id,
    threshold: settings.threshold,
    minCluster: settings.minCluster,
    weights: Array.from(result.weights),
    assets: assets.map(({ filename, sha256 }) => ({ filename, sha256 })),
  };
  await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

export async function checkInstallation() {
  const model = Buffer.from(
    'CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN',
    'base64'
  );
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
  });
  try {
    const output = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
    if (output.y.data[0] !== 42) throw new Error('CPU runtime check failed.');
  } finally {
    await session.release();
  }
  return {
    tool: 'calmar',
    version: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    models: await downloadModels({ offline: true }),
  };
}
