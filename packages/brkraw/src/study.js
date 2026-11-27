// Bruker ParaVision study loader supporting both .zip archives (lazy central-directory +
// Blob.slice extraction so multi-GB archives never load raw fid/2dseq into RAM until needed)
// and dropped folders/files.
import { parseJcampBytes, stripJcampString } from './jcamp.js';
import { resolveAffines } from './affine.js';
import {
  MAX_CONVERT_BYTES,
  decode2dseq,
  estimateDecodedBytes,
  resolveDatatype,
  resolveShape,
} from './image.js';
import { affineToQform, encodeNifti1, sliceCodeFromScheme } from './nifti.js';
import { buildScrubbedSidecar } from './sidecar.js';
import { openLazyZip } from './zip.js';

const JCAMP_FILENAMES = new Set(['subject', 'acqp', 'method', 'visu_pars', 'reco']);
const MAX_JCAMP_BYTES = 16 * 1024 * 1024; // 16 MiB per JCAMP parameter file

function normalizeRelPath(raw) {
  return String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function isZipSource(source) {
  return (
    source instanceof Uint8Array
    || source instanceof ArrayBuffer
    || (source && typeof source.slice === 'function' && typeof source.size === 'number')
  );
}

/**
 * Discover the study prefix inside a list of relative file paths (handles studies at root,
 * wrapped in one or more parent directories, and ignores macOS `__MACOSX` artifacts).
 */
function findStudyEntries(paths) {
  const clean = [];
  for (const raw of paths) {
    const p = normalizeRelPath(raw);
    if (!p || p.endsWith('/') || p.includes('__MACOSX/')) continue;
    clean.push({ raw, norm: p });
  }

  // Match `<prefix?><scanId>/pdata/<recoId>/2dseq` or `<prefix?><scanId>/pdata/<recoId>/visu_pars`
  const prefixCounts = new Map();
  const scanRe = /^(.*?)(\d+)\/pdata\/(\d+)\/(2dseq|visu_pars)$/;
  for (const entry of clean) {
    const m = scanRe.exec(entry.norm);
    if (m) {
      const prefix = m[1];
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }
  if (prefixCounts.size === 0) {
    throw new Error('No Bruker ParaVision scans found (expected <scan>/pdata/<reco>/visu_pars and 2dseq).');
  }
  // Pick the prefix with the most scan entries (shortest on tie)
  const [studyPrefix] = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];

  const byRelPath = new Map();
  for (const entry of clean) {
    if (!entry.norm.startsWith(studyPrefix)) continue;
    const rel = entry.norm.slice(studyPrefix.length);
    if (rel) byRelPath.set(rel, entry.raw);
  }
  return { studyPrefix, byRelPath, studyCount: prefixCounts.size };
}

function parseSoftwareVersion(subject, firstVisuPars) {
  const parseTitle = (text) => {
    if (!text) return null;
    const pv360 = /ParaVision\s+360\s+V(\d+)\.(\d+)/i.exec(text);
    if (pv360) return `360.${pv360[1]}.${pv360[2]}`;
    const pv = /ParaVision\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text);
    if (pv) return pv[1];
    if (text === 'Parameter List') return '5.1';
    return null;
  };
  if (subject) {
    const parsed = parseTitle(stripJcampString(subject.header?.TITLE));
    if (parsed) return parsed;
  }
  if (firstVisuPars) {
    const val = stripJcampString(
      firstVisuPars.get('VisuCreatorVersion') ?? firstVisuPars.get('VisuCoreVersion'),
    );
    const pv360 = /360[\s._V]*(\d+\.\d+(?:\.\d+)?)/i.exec(val);
    if (pv360) return `360.${pv360[1]}`;
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(val);
    if (m) return m[1];
    const fromTitle = parseTitle(stripJcampString(firstVisuPars.header?.TITLE));
    if (fromTitle) return fromTitle;
  }
  return null;
}

function isUnverifiedParaVision(version) {
  if (!version) return false;
  if (/^360\b/.test(version)) return true;
  const major = Number.parseInt(version.split('.')[0], 10);
  return Number.isFinite(major) && major >= 7;
}

function isJcampPath(relPath) {
  const base = relPath.split('/').pop();
  return JCAMP_FILENAMES.has(base);
}

/**
 * Create a lazy Bruker study handle from a `.zip` (`File`, `Blob`, `Uint8Array`, `ArrayBuffer`)
 * or an array of `{ path, getBytes: () => Promise<Uint8Array> | Uint8Array }` entries.
 */
export async function loadBrukerStudy(source, { maxBytes = MAX_CONVERT_BYTES } = {}) {
  const entryReaders = new Map(); // rawPath -> (limitBytes) => Promise<Uint8Array>
  let rawPaths = [];

  if (isZipSource(source)) {
    const zip = await openLazyZip(source);
    rawPaths = [...zip.entries.keys()];
    for (const name of rawPaths) {
      entryReaders.set(name, (limitBytes) => zip.readEntry(name, { maxBytes: limitBytes }));
    }
  } else if (Array.isArray(source)) {
    for (const item of source) {
      const p = normalizeRelPath(item.path ?? item.webkitRelativePath ?? item.name);
      if (!p) continue;
      rawPaths.push(p);
      entryReaders.set(p, async (limitBytes) => {
        if (typeof item.size === 'number' && item.size > limitBytes) {
          throw new Error(
            `File "${p}" (${(item.size / (1024 * 1024)).toFixed(1)} MiB) exceeds the ${(limitBytes / (1024 * 1024)).toFixed(0)} MiB browser limit.`,
          );
        }
        let bytes;
        if (item.bytes) bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
        else if (typeof item.arrayBuffer === 'function') bytes = new Uint8Array(await item.arrayBuffer());
        else if (typeof item.getBytes === 'function') {
          const b = await item.getBytes();
          bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
        } else {
          throw new Error(`Cannot read bytes for ${p}`);
        }
        if (bytes.byteLength > limitBytes) {
          throw new Error(
            `File "${p}" (${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB) exceeds the ${(limitBytes / (1024 * 1024)).toFixed(0)} MiB browser limit.`,
          );
        }
        return bytes;
      });
    }
  } else {
    throw new Error('Unsupported Bruker study input.');
  }

  const { studyPrefix, byRelPath, studyCount } = findStudyEntries(rawPaths);

  const readRelBytes = async (rel, limitBytes) => {
    const raw = byRelPath.get(rel);
    if (!raw) return null;
    return entryReaders.get(raw)(limitBytes);
  };

  const readJcamp = async (rel) => {
    if (!isJcampPath(rel)) return null;
    const bytes = await readRelBytes(rel, MAX_JCAMP_BYTES);
    return bytes ? parseJcampBytes(bytes) : null;
  };

  const subject = await readJcamp('subject');

  // Discover all scans and recos
  const scanMap = new Map();
  const recoRe = /^(\d+)\/pdata\/(\d+)\/(2dseq|visu_pars)$/;
  for (const rel of byRelPath.keys()) {
    const m = recoRe.exec(rel);
    if (!m) continue;
    const scanId = Number.parseInt(m[1], 10);
    const recoId = Number.parseInt(m[2], 10);
    if (!scanMap.has(scanId)) scanMap.set(scanId, new Set());
    scanMap.get(scanId).add(recoId);
  }

  const scans = [];
  let firstVisuPars = null;
  const sortedScanIds = [...scanMap.keys()].sort((a, b) => a - b);

  for (const scanId of sortedScanIds) {
    const acqp = await readJcamp(`${scanId}/acqp`);
    const method = await readJcamp(`${scanId}/method`);
    if (!acqp || !method) continue;

    const recoIds = [...scanMap.get(scanId)].sort((a, b) => a - b);
    const recos = [];
    for (const recoId of recoIds) {
      const visuPars = await readJcamp(`${scanId}/pdata/${recoId}/visu_pars`);
      const has2dseq = byRelPath.has(`${scanId}/pdata/${recoId}/2dseq`);
      if (!visuPars || !has2dseq) continue;
      if (!firstVisuPars) firstVisuPars = visuPars;

      let shapeInfo = null;
      let dtypeInfo = null;
      let affineInfo = null;
      let error = null;
      let exceedsLimit = false;
      let estimatedBytes = 0;
      try {
        dtypeInfo = resolveDatatype(visuPars);
        shapeInfo = resolveShape(method, visuPars);
        affineInfo = resolveAffines({ acqp, method, visuPars, space: 'subject_ras' });
        estimatedBytes = estimateDecodedBytes(shapeInfo, dtypeInfo);
        if (estimatedBytes > maxBytes) {
          exceedsLimit = true;
          error = `Volume [${shapeInfo.shape.join(' × ')}] requires ${(estimatedBytes / (1024 * 1024)).toFixed(0)} MiB, exceeding the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB browser limit. Use the Standalone BrkRaw container.`;
        }
      } catch (err) {
        error = err.message;
      }

      const rawShape = shapeInfo?.shape ?? [];
      const totalVoxels = rawShape.reduce((a, b) => a * b, 1);
      const zooms = affineInfo?.affines?.[0] ? affineToQform(affineInfo.affines[0]).zooms : shapeInfo?.resol ?? [];
      const protocol = stripJcampString(acqp.get('ACQ_protocol_name') ?? acqp.get('ACQ_scan_name')) || `Scan ${scanId}`;
      const methodName = stripJcampString(method.get('Method')) || 'Unknown';
      const te = visuPars.get('VisuAcqEchoTime') ?? method.get('PVM_EchoTime');
      const tr = visuPars.get('VisuAcqRepetitionTime') ?? method.get('PVM_RepetitionTime');

      recos.push({
        scanId,
        recoId,
        protocol,
        methodName,
        dim: shapeInfo?.dim ?? null,
        shape: rawShape,
        shapeDesc: shapeInfo?.shapeDesc ?? [],
        totalVoxels,
        estimatedBytes,
        exceedsLimit,
        zooms: zooms.map((z) => Number(z.toFixed(4))),
        numSlicePacks: affineInfo?.numSlicePacks ?? 1,
        numSlices: affineInfo?.numSlices ?? [],
        sliceOrientations: affineInfo?.sliceOrientations ?? [],
        numCycles: shapeInfo?.numCycles ?? 1,
        wordType: dtypeInfo?.wordType ?? null,
        byteOrder: dtypeInfo?.byteOrder ?? null,
        subjectType: affineInfo?.subjectType ?? null,
        subjectPosition: affineInfo?.subjectPosition ?? null,
        teMs: Array.isArray(te) ? te[0] : te ?? null,
        trMs: Array.isArray(tr) ? tr[0] : tr ?? null,
        convertible: Boolean(dtypeInfo && shapeInfo && affineInfo && !error),
        error,
        // Internal parsed parameter handles kept for fast conversion
        _acqp: acqp,
        _method: method,
        _visuPars: visuPars,
        _dtypeInfo: dtypeInfo,
        _shapeInfo: shapeInfo,
      });
    }

    if (recos.length) {
      scans.push({
        scanId,
        protocol: recos[0].protocol,
        methodName: recos[0].methodName,
        recos,
      });
    }
  }

  const softwareVersion = parseSoftwareVersion(subject, firstVisuPars);
  const firstReco = scans[0]?.recos[0] ?? null;
  const warnings = [];
  if (studyCount > 1) {
    warnings.push(`Input contains ${studyCount} Bruker studies; loaded the study with the most scans.`);
  }
  if (isUnverifiedParaVision(softwareVersion)) {
    warnings.push(`ParaVision ${softwareVersion} detected — orientation parity has been verified against ParaVision 5.1 and 6.0.1; verify output orientation carefully.`);
  }

  return {
    studyName: studyPrefix.replace(/\/+$/, '').split('/').pop() || 'bruker_study',
    softwareVersion,
    subjectType: firstReco?.subjectType ?? null,
    subjectPosition: firstReco?.subjectPosition ?? null,
    studyCount,
    warnings,
    scans,

    /** List lightweight serializable summaries (safe for Web Worker postMessage). */
    summary() {
      return {
        studyName: this.studyName,
        softwareVersion: this.softwareVersion,
        subjectType: this.subjectType,
        subjectPosition: this.subjectPosition,
        studyCount: this.studyCount,
        warnings: [...this.warnings],
        scans: this.scans.map((s) => ({
          scanId: s.scanId,
          protocol: s.protocol,
          methodName: s.methodName,
          recos: s.recos.map((r) => ({
            scanId: r.scanId,
            recoId: r.recoId,
            protocol: r.protocol,
            methodName: r.methodName,
            dim: r.dim,
            shape: r.shape,
            shapeDesc: r.shapeDesc,
            totalVoxels: r.totalVoxels,
            estimatedBytes: r.estimatedBytes,
            exceedsLimit: r.exceedsLimit,
            zooms: r.zooms,
            numSlicePacks: r.numSlicePacks,
            numSlices: r.numSlices,
            sliceOrientations: r.sliceOrientations,
            numCycles: r.numCycles,
            wordType: r.wordType,
            byteOrder: r.byteOrder,
            subjectType: r.subjectType,
            subjectPosition: r.subjectPosition,
            teMs: r.teMs,
            trMs: r.trMs,
            convertible: r.convertible,
            error: r.error,
          })),
        })),
      };
    },

    /**
     * Convert one scan/reco (and optional slice pack index) into NIfTI-1 bytes + scrubbed JSON sidecar.
     */
    async convert({
      scanId,
      recoId,
      slicePackIndex = 0,
      space = 'subject_ras',
      overrideSubjectType = null,
      overrideSubjectPose = null,
      converterVersion = '0.1.0',
      maxBytes: convertMaxBytes = maxBytes,
    }) {
      const scan = this.scans.find((s) => s.scanId === Number(scanId));
      if (!scan) throw new Error(`Scan ${scanId} not found in Bruker study.`);
      const reco = recoId === undefined || recoId === null
        ? scan.recos[0]
        : scan.recos.find((r) => r.recoId === Number(recoId));
      if (!reco) throw new Error(`Reconstruction ${recoId} not found for scan ${scanId}.`);
      if (!reco.convertible) {
        throw new Error(reco.error || `Scan ${scanId} reco ${reco.recoId} cannot be converted.`);
      }

      // Enforce memory cap from scan shape BEFORE decompressing 2dseq.
      const neededBytes = estimateDecodedBytes(reco._shapeInfo, reco._dtypeInfo);
      if (neededBytes > convertMaxBytes) {
        throw new Error(
          `Volume [${reco._shapeInfo.shape.join(' × ')}] requires ${(neededBytes / (1024 * 1024)).toFixed(0)} MiB, exceeding the ${(convertMaxBytes / (1024 * 1024)).toFixed(0)} MiB browser limit. Use the Standalone BrkRaw container.`,
        );
      }

      const affineInfo = resolveAffines({
        acqp: reco._acqp,
        method: reco._method,
        visuPars: reco._visuPars,
        space,
        overrideSubjectType: overrideSubjectType || null,
        overrideSubjectPose: overrideSubjectPose || null,
      });
      if (!affineInfo) {
        throw new Error(`Could not resolve spatial affine for scan ${scanId} reco ${reco.recoId}.`);
      }

      const packIdx = Number(slicePackIndex);
      if (!Number.isInteger(packIdx) || packIdx < 0 || packIdx >= affineInfo.numSlicePacks) {
        throw new RangeError(`Slice pack ${slicePackIndex} out of range (available: 0..${affineInfo.numSlicePacks - 1}).`);
      }

      const raw2dseq = await readRelBytes(`${scan.scanId}/pdata/${reco.recoId}/2dseq`, convertMaxBytes);
      if (!raw2dseq) {
        throw new Error(`Missing 2dseq binary for scan ${scan.scanId} reco ${reco.recoId}.`);
      }

      const decoded = decode2dseq(raw2dseq, {
        dtypeInfo: reco._dtypeInfo,
        shapeInfo: reco._shapeInfo,
        numSlices: affineInfo.numSlices,
        maxBytes: convertMaxBytes,
      });
      const pack = decoded.packs[packIdx];
      const affine = affineInfo.affines[packIdx];
      const sliceCode = sliceCodeFromScheme(reco._shapeInfo.sliceorderScheme);
      const timeStep = reco._shapeInfo.numCycles > 1 && reco._shapeInfo.timePerCycle
        ? reco._shapeInfo.timePerCycle / 1000
        : null;

      const niftiBytes = encodeNifti1({
        data: pack.data,
        shape: pack.shape,
        kind: pack.kind,
        affine,
        sclSlope: pack.sclSlope,
        sclInter: pack.sclInter,
        sliceCode,
        timeStep,
      });

      const qf = affineToQform(affine);
      const sidecar = buildScrubbedSidecar({
        softwareVersion: this.softwareVersion,
        scanId: scan.scanId,
        recoId: reco.recoId,
        slicePackIndex: packIdx,
        slicePackCount: affineInfo.numSlicePacks,
        dim: reco._shapeInfo.dim,
        acqp: reco._acqp,
        method: reco._method,
        visuPars: reco._visuPars,
        shape: pack.shape,
        zooms: qf.zooms,
        affineInfo,
        sclSlope: pack.sclSlope,
        sclInter: pack.sclInter,
        perFrameScalingApplied: pack.perFrameScalingApplied,
        converterVersion,
      });

      return {
        scanId: scan.scanId,
        recoId: reco.recoId,
        protocol: reco.protocol,
        methodName: reco.methodName,
        slicePackIndex: packIdx,
        slicePackCount: affineInfo.numSlicePacks,
        shape: pack.shape,
        kind: pack.kind,
        zooms: qf.zooms,
        affine,
        sclSlope: pack.sclSlope,
        sclInter: pack.sclInter,
        perFrameScalingApplied: pack.perFrameScalingApplied,
        niftiBytes,
        sidecar,
        sidecarJson: `${JSON.stringify(sidecar, null, 2)}\n`,
      };
    },
  };
}
