// BrkRaw Web Worker: lazily inspects a Bruker ParaVision ZIP (via File.slice) or study folder
// and converts the selected scan/reconstruction to NIfTI-1 + scrubbed BIDS-style JSON sidecar.
import { loadBrukerStudy } from "@neurodesk/brkraw";

let activeStudy = null;

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "inspect") {
      self.postMessage({ type: "progress", id: msg.id, value: 0.1, message: "Inspecting Bruker study…" });
      let source;
      if (msg.zipFile) {
        source = msg.zipFile;
      } else if (Array.isArray(msg.entries)) {
        source = msg.entries.map((entry) => ({
          path: entry.path,
          size: entry.file.size,
          getBytes: async () => new Uint8Array(await entry.file.arrayBuffer()),
        }));
      } else {
        throw new Error("Drop a Bruker ParaVision .zip archive or study folder.");
      }
      activeStudy = await loadBrukerStudy(source);
      const summary = activeStudy.summary();
      self.postMessage({ type: "inspected", id: msg.id, summary });
      return;
    }

    if (msg.type === "convert") {
      if (!activeStudy) {
        throw new Error("Load a Bruker ParaVision study before converting.");
      }
      self.postMessage({ type: "progress", id: msg.id, value: 0.25, message: `Converting scan ${msg.scanId} (reco ${msg.recoId})…` });
      const result = await activeStudy.convert({
        scanId: msg.scanId,
        recoId: msg.recoId,
        slicePackIndex: msg.slicePackIndex,
        space: msg.space,
        overrideSubjectType: msg.overrideSubjectType || null,
        overrideSubjectPose: msg.overrideSubjectPose || null,
        converterVersion: msg.converterVersion,
      });
      const niftiBuffer = result.niftiBytes.buffer;
      self.postMessage(
        {
          type: "converted",
          id: msg.id,
          scanId: result.scanId,
          recoId: result.recoId,
          protocol: result.protocol,
          methodName: result.methodName,
          slicePackIndex: result.slicePackIndex,
          slicePackCount: result.slicePackCount,
          shape: result.shape,
          kind: result.kind,
          zooms: result.zooms,
          affine: result.affine,
          sclSlope: result.sclSlope,
          sclInter: result.sclInter,
          perFrameScalingApplied: result.perFrameScalingApplied,
          niftiBuffer,
          sidecar: result.sidecar,
          sidecarJson: result.sidecarJson,
        },
        [niftiBuffer],
      );
      return;
    }

    throw new Error(`Unknown BrkRaw worker request: ${msg.type}`);
  } catch (error) {
    self.postMessage({ type: "error", id: msg.id, message: error.message || String(error) });
  }
};
