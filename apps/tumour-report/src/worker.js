// Dedicated module worker for Brain Tumour Report:
//   1. Reads native T1c (and optional binary tumour mask).
//   2. Runs Raidionics v1.3 MRI_Brain + MRI_TumorCore/t1c via ONNX Runtime Web
//      (WebGPU when a non-fallback adapter has >= 512 MiB storage buffer binding, else WASM CPU),
//      releasing MRI_Brain before allocating MRI_TumorCore to keep memory bounded.
//   3. Computes Layer 1 native-space morphometry (<1 s).
//   4. Optionally runs Layer 2 MNI ICBM152 2009a Greedy registration + RADS characterization.
//   5. Serializes NIfTI masks, JSON report, and TSV tables.
import * as ort from "onnxruntime-web/webgpu";
import wasmURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleURL from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import initGreedy, * as greedyApi from "@neurodesk/greedy/wasm-single";
import { gunzip } from "@neurodesk/greedy";
import { readVolume } from "@neurodesk/synthsr";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import {
  extractBrainMask,
  segmentTumour,
} from "@neurodesk/tumour-report";
import {
  gridsMatch,
  validateVolume,
} from "@neurodesk/tumour-report/preprocess";
import { computeNativeMorphometry } from "@neurodesk/tumour-report/morphometry";
import { computeMniRads, normalizeToMniWithGreedy, parseBcbTractsPack } from "@neurodesk/tumour-report/rads";
import { assetById } from "@neurodesk/tumour-report/models";
import { buildReport } from "@neurodesk/tumour-report/results";

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

// Peak FP32 Concat tensor inside MRI_TumorCore (160^3 x 32 channels) is 500 MiB.
const MIN_WEBGPU_STORAGE_BYTES = 536870912;

let greedyReady = null;

const progress = (value, message) => self.postMessage({ type: "progress", value, message });
const log = (message) => self.postMessage({ type: "log", message });

async function selectBackend(requested) {
  if (requested === "wasm") return "wasm";
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) {
    log("No WebGPU adapter; running on WebAssembly CPU");
    return "wasm";
  }
  if (adapter.info?.isFallbackAdapter) {
    log(`WebGPU offers only a software adapter (${adapter.info.description || adapter.info.vendor || "fallback"}); running on WebAssembly CPU`);
    return "wasm";
  }
  const maxStorage = adapter.limits?.maxStorageBufferBindingSize ?? 0;
  if (maxStorage < MIN_WEBGPU_STORAGE_BYTES) {
    log(`WebGPU maxStorageBufferBindingSize (${Math.round(maxStorage / (1024 * 1024))} MiB) is below 512 MiB; running on WebAssembly CPU`);
    return "wasm";
  }
  return "webgpu";
}

async function fetchAssetBytes(id, progressRange, label) {
  const asset = assetById(id);
  const [lo, hi] = progressRange;
  progress(lo, label);
  const buf = await fetchModel(
    { url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } },
    {
      onProgress: ({ fraction }) => {
        progress(lo + (hi - lo) * (fraction || 0), label);
      },
    },
  );
  return { asset, bytes: new Uint8Array(buf) };
}

async function runSingleSession(modelBytes, backend, fn) {
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  try {
    const runTensor = async (inputData, shape) => {
      const input = new ort.Tensor("float32", inputData, shape);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: input });
        const raw = await outputs[session.outputNames[0]].getData();
        return Float32Array.from(raw);
      } finally {
        input.dispose();
        for (const output of Object.values(outputs || {})) output.dispose();
      }
    };
    return await fn(runTensor);
  } finally {
    await session.release();
  }
}

async function runBrainMaskOnly(volume, brainBytes, backend) {
  return extractBrainMask({
    volume,
    runBrain: (tile, shape) => runSingleSession(brainBytes, backend, (run) => run(tile, shape)),
  });
}

function nonZeroMask(data) {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) mask[i] = 1;
  }
  return mask;
}

async function runSegmentationWithFallback({ volume, skullStripped, backend, onProgress }) {
  const downloadedModels = [];
  let brainBytes = null;
  if (!skullStripped) {
    const fetched = await fetchAssetBytes("mri-brain", [0.02, 0.12], "Downloading brain model…");
    brainBytes = fetched.bytes;
    downloadedModels.push({ id: fetched.asset.id, file: fetched.asset.filename, sha256: fetched.asset.sha256 });
  }
  const tumourFetched = await fetchAssetBytes("mri-tumorcore-t1c", [0.12, 0.24], "Downloading tumour model…");
  const tumourBytes = tumourFetched.bytes;
  downloadedModels.push({ id: tumourFetched.asset.id, file: tumourFetched.asset.filename, sha256: tumourFetched.asset.sha256 });

  const execute = async (provider) => {
    log(`Running Raidionics v1.3 on ${provider === "webgpu" ? "WebGPU" : `WebAssembly (${ort.env.wasm.numThreads} threads)`}`);
    let tumourSession = null;
    try {
      return await segmentTumour({
        volume,
        skullStripped,
        runBrain: skullStripped
          ? undefined
          : async (tile, shape) => runSingleSession(brainBytes, provider, (run) => run(tile, shape)),
        runTumorCore: async (tile, shape) => {
          if (!tumourSession) {
            tumourSession = await ort.InferenceSession.create(tumourBytes, {
              executionProviders: [provider],
              graphOptimizationLevel: "all",
            });
          }
          const input = new ort.Tensor("float32", tile, shape);
          let outputs;
          try {
            outputs = await tumourSession.run({ [tumourSession.inputNames[0]]: input });
            const raw = await outputs[tumourSession.outputNames[0]].getData();
            return Float32Array.from(raw);
          } finally {
            input.dispose();
            for (const output of Object.values(outputs || {})) output.dispose();
          }
        },
        onProgress,
      });
    } finally {
      if (tumourSession) await tumourSession.release();
    }
  };

  let usedBackend = backend;
  let seg;
  try {
    seg = await execute(usedBackend);
  } catch (error) {
    if (usedBackend !== "webgpu") throw error;
    log(`WebGPU failed (${error.message}); retrying on WebAssembly CPU`);
    usedBackend = "wasm";
    seg = await execute("wasm");
  }
  return { seg, backend: usedBackend, models: downloadedModels };
}

async function fetchRadsAtlases(tumourType) {
  const ids = [
    "mni-icbm152-t1-brain",
    "mni-lateralisation",
    "mni-lobes",
    "schaefer7",
    "schaefer17",
    "bcb-tracts",
  ];
  if (tumourType === "glioblastoma") {
    ids.push("resect-left", "resect-right");
  }
  const fetched = {};
  const atlasMeta = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const lo = 0.68 + (0.10 * i) / ids.length;
    const hi = 0.68 + (0.10 * (i + 1)) / ids.length;
    const { asset, bytes } = await fetchAssetBytes(id, [lo, hi], `Downloading MNI atlases (${i + 1}/${ids.length})…`);
    fetched[id] = bytes;
    atlasMeta.push({ id: asset.id, file: asset.filename, sha256: asset.sha256 });
  }
  const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const lateralisation = readVolume(toArrayBuffer(fetched["mni-lateralisation"])).data;
  const lobes = readVolume(toArrayBuffer(fetched["mni-lobes"])).data;
  const schaefer7 = readVolume(toArrayBuffer(fetched["schaefer7"])).data;
  const schaefer17 = readVolume(toArrayBuffer(fetched["schaefer17"])).data;
  const bcbTracts = parseBcbTractsPack(await gunzip(fetched["bcb-tracts"]));
  const resectLeft = fetched["resect-left"] ? readVolume(toArrayBuffer(fetched["resect-left"])).data : null;
  const resectRight = fetched["resect-right"] ? readVolume(toArrayBuffer(fetched["resect-right"])).data : null;
  return {
    mniTemplateBytes: fetched["mni-icbm152-t1-brain"],
    atlases: { lateralisation, lobes, schaefer7, schaefer17, bcbTracts, resectLeft, resectRight },
    atlasMeta,
  };
}

self.onmessage = async ({ data: job }) => {
  try {
    const started = performance.now();
    progress(0, "Reading T1c scan…");
    const volume = readVolume(await job.t1cFile.arrayBuffer());
    validateVolume(volume, "T1c");
    log(`Loaded T1c ${job.t1cFile.name} (${volume.dims.join(" × ")})`);

    const requestedBackend = await selectBackend(job.backend || "auto");
    let usedBackend = requestedBackend;
    let brainMask = null;
    let tumourMask = null;
    let warnings = [];
    let models = [];
    let patches = 0;

    if (job.maskFile) {
      progress(0.05, "Reading supplied tumour mask…");
      const maskVol = readVolume(await job.maskFile.arrayBuffer());
      validateVolume(maskVol, "Tumour mask");
      if (!gridsMatch(volume, maskVol)) {
        throw new Error(`Supplied tumour mask (${maskVol.dims.join(" × ")}) is not aligned to the T1c voxel-to-RAS grid (${volume.dims.join(" × ")}).`);
      }
      tumourMask = nonZeroMask(maskVol.data);
      log(`Using supplied tumour mask ${job.maskFile.name}`);
      if (job.skullStripped) {
        brainMask = nonZeroMask(volume.data);
      } else if (job.computeMniReport) {
        const fetched = await fetchAssetBytes("mri-brain", [0.08, 0.24], "Downloading brain model…");
        models.push({ id: fetched.asset.id, file: fetched.asset.filename, sha256: fetched.asset.sha256 });
        progress(0.28, "Segmenting brain mask for MNI registration…");
        try {
          const out = await runBrainMaskOnly(volume, fetched.bytes, usedBackend);
          brainMask = out.brainMask;
          warnings.push(...out.warnings);
        } catch (error) {
          if (usedBackend !== "webgpu") throw error;
          log(`WebGPU failed (${error.message}); retrying brain extraction on WebAssembly CPU`);
          usedBackend = "wasm";
          const out = await runBrainMaskOnly(volume, fetched.bytes, "wasm");
          brainMask = out.brainMask;
          warnings.push(...out.warnings);
        }
      }
    } else {
      const segResult = await runSegmentationWithFallback({
        volume,
        skullStripped: Boolean(job.skullStripped),
        backend: usedBackend,
        onProgress: (ev) => {
          if (ev.stage === "preprocess") progress(0.25, ev.message);
          else if (ev.stage === "brain") progress(0.30, "Segmenting brain mask…");
          else if (ev.stage === "tumour") {
            const frac = ev.totalPatches ? (ev.patch - 1) / ev.totalPatches : 0;
            progress(0.40 + 0.22 * frac, `${ev.message}…`);
          } else if (ev.stage === "reconstruct") progress(0.63, `${ev.message}…`);
        },
      });
      usedBackend = segResult.backend;
      models = segResult.models;
      brainMask = segResult.seg.brainMask;
      tumourMask = segResult.seg.tumourMask;
      patches = segResult.seg.patches;
      warnings.push(...segResult.seg.warnings);
    }

    progress(0.65, "Computing native-space morphometry…");
    const morphometry = computeNativeMorphometry({
      tumourMask,
      brainMask,
      dims: volume.dims,
      affine: volume.affine,
    });
    log(`Native morphometry: ${morphometry.lesionCount} lesions, ${morphometry.totalVolumeMl.toFixed(2)} mL`);

    let rads = null;
    let mniMask = null;
    let mniDims = null;
    let mniAffine = null;
    let registrationMode = null;
    let atlasMeta = [];

    if (job.computeMniReport && morphometry.lesionCount > 0) {
      const atlasBundle = await fetchRadsAtlases(job.tumourType);
      atlasMeta = atlasBundle.atlasMeta;
      progress(0.79, "Initializing Greedy registration…");
      let mniNorm = null;
      try {
        greedyReady ??= initGreedy();
        await greedyReady;
        mniNorm = await normalizeToMniWithGreedy({
          volume,
          brainMask: brainMask ?? nonZeroMask(volume.data),
          tumourMask,
          mniTemplateBytes: atlasBundle.mniTemplateBytes,
          greedyApi,
          deformable: Boolean(job.deformableMni),
          onProgress: (ev) => progress(0.84, `${ev.message}…`),
        });
      } catch (regErr) {
        greedyReady = null;
        const detail = regErr instanceof Error ? regErr.message : String(regErr);
        warnings.push(`MNI registration failed (${detail}); emitting native-space report only.`);
        log(`MNI registration failed (${detail}); omitting MNI RADS report.`);
      }
      if (mniNorm) {
        registrationMode = mniNorm.mode;
        if (mniNorm.mniVoxels === 0) {
          warnings.push("Warped tumour mask is empty in MNI space; MNI anatomical characterization unavailable.");
          log("Warped tumour mask is empty in MNI space; omitting MNI RADS report.");
        } else {
          mniMask = mniNorm.mniMask;
          mniDims = mniNorm.dims;
          mniAffine = mniNorm.affine;
          progress(0.92, "Computing MNI RADS anatomical report…");
          rads = computeMniRads({
            mniMask,
            dims: mniDims,
            tumourType: job.tumourType,
            atlases: atlasBundle.atlases,
          });
          log(`MNI RADS (${registrationMode}): ${rads.mniVolumeMl.toFixed(2)} mL, Left ${rads.laterality.leftPct}% / Right ${rads.laterality.rightPct}%`);
        }
      }
    } else if (job.computeMniReport && morphometry.lesionCount === 0) {
      log("No tumour voxels segmented; skipping MNI anatomical registration.");
    }

    progress(0.96, "Writing output masks and tables…");
    const built = buildReport({
      caseLabel: job.caseLabel,
      tumourType: job.tumourType,
      dims: volume.dims,
      affine: volume.affine,
      brainMask,
      tumourMask,
      mniMask,
      mniDims,
      mniAffine,
      morphometry,
      rads,
      warnings,
      provenance: {
        mode: job.maskFile ? "supplied-mask" : "raidionics-v1.3",
        skullStripped: Boolean(job.skullStripped),
        backend: job.maskFile && !models.length ? "cpu-morphometry" : usedBackend,
        models,
        atlases: atlasMeta,
        registrationMode,
        patches,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      },
    });

    const transfers = [built.tumourMask.bytes];
    if (built.brainMask) transfers.push(built.brainMask.bytes);
    if (built.tumourMaskMni) transfers.push(built.tumourMaskMni.bytes);

    self.postMessage(
      {
        type: "result",
        report: built.report,
        reportJson: built.reportJson,
        lesionsTsv: built.lesionsTsv,
        summaryTsv: built.summaryTsv,
        tumourMask: built.tumourMask,
        brainMask: built.brainMask ?? null,
        tumourMaskMni: built.tumourMaskMni ?? null,
      },
      transfers,
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
