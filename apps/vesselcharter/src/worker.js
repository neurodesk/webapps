// Module Web Worker executing @neurodesk/vesselcharter off the UI thread.
import { characterizeVesselNifti } from '@neurodesk/vesselcharter';

self.onmessage = async (event) => {
  const { runId, vesselBytes, brainMaskBytes, parameters, baseName } = event.data;
  try {
    const { result, artifacts } = await characterizeVesselNifti({
      vesselBytes: new Uint8Array(vesselBytes),
      brainMaskBytes: brainMaskBytes ? new Uint8Array(brainMaskBytes) : null,
      parameters,
      baseName,
      onProgress: (fraction, message) => {
        self.postMessage({ type: 'progress', runId, fraction, message });
      },
    });

    const transferList = [];
    const serializedArtifacts = {};
    for (const [key, artifact] of Object.entries(artifacts)) {
      const copy = new Uint8Array(artifact.bytes);
      transferList.push(copy.buffer);
      serializedArtifacts[key] = {
        role: artifact.role,
        name: artifact.name,
        mediaType: artifact.mediaType,
        buffer: copy.buffer,
      };
    }

    // Keep lightweight summary + table rows for the interactive Report tab.
    const reportData = {
      summary: result.summary,
      segments: result.segments.map((s) => ({
        id: s.id,
        componentId: s.componentId,
        kind: s.kind,
        lengthMm: s.lengthMm,
        rawLengthMm: s.rawLengthMm,
        dmTortuosity: s.dmTortuosity,
        soamRadPerMm: s.soamRadPerMm,
        medianDiameterMm: s.medianDiameterMm,
        equivDiameterMm: s.equivDiameterMm,
        volumeMm3: s.volumeMm3,
        resolutionLimited: s.resolutionLimited,
        touchesFovBoundary: s.touchesFovBoundary,
        cropCensored: s.cropCensored,
        midpointWorldMm: s.midpointWorldMm,
      })),
      junctions: result.junctions.map((j) => ({
        id: j.id,
        componentId: j.componentId,
        degree: j.degree,
        radiusMm: j.radiusMm,
        minAngleDeg: j.minAngleDeg,
        maxAngleDeg: j.maxAngleDeg,
        meanAngleDeg: j.meanAngleDeg,
        parentInferredFromCaliber: j.parentInferredFromCaliber,
        daughterAngleDeg: j.daughterAngleDeg,
        murrayRatioCubed: j.murrayRatioCubed,
        touchesFovBoundary: j.touchesFovBoundary,
        worldMm: j.worldMm,
      })),
    };

    self.postMessage(
      {
        type: 'result',
        runId,
        reportData,
        artifacts: serializedArtifacts,
      },
      transferList,
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      runId,
      message: error?.message || String(error),
    });
  }
};
