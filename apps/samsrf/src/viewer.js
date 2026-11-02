// The cortical surface in NiiVue: one mesh, curvature shading as its first layer
// and the displayed map as its second.
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { readFreeSurferCurv, writeMz3Scalars } from "@neurodesk/webapp-components/file-io/mesh";
import { POLAR_COLORMAP, POLAR_COLORMAP_POINTS, cameraFor } from "./display.js";

// Gyri (negative curvature) light and sulci (positive) dark, as FreeSurfer shades them,
// encoded into [1, 2] like the maps because NiiVue's layer lookup starts at zero.
const CURVATURE_RANGE = 0.15;
const CURVATURE = { colormap: "gray", calMin: 1, calMax: 2, colormapType: 0, isTransparentBelowCalMin: false, opacity: 0.6, isColorbarVisible: false };

async function curvatureLayer(file) {
  const curvature = readFreeSurferCurv(new Uint8Array(await file.arrayBuffer()));
  const shade = curvature.map((value) => 1.5 - Math.max(-CURVATURE_RANGE, Math.min(CURVATURE_RANGE, value)) / (2 * CURVATURE_RANGE));
  return new File([writeMz3Scalars(shade)], `${file.name}.mz3`);
}

export function createSurfaceViewer(canvasId) {
  const nv = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
  const ready = nv.attachTo(canvasId).then(() => {
    nv.sliceType = SLICE_TYPE.RENDER;
    nv.isColorbarVisible = false;
    nv.isOrientCubeVisible = false;
    nv.is3DCrosshairVisible = false;
    nv.addColormap(POLAR_COLORMAP, POLAR_COLORMAP_POINTS);
  });
  let surface = null;
  let mapLayer = -1;

  return {
    nv,
    ready,
    get hasSurface() {
      return Boolean(surface);
    },
    /** Show a surface, shaded by curvature when a curv file is given. Drops any map. */
    async showSurface(mesh, curvature) {
      await ready;
      await nv.removeAllMeshes();
      surface = null;
      mapLayer = -1;
      if (!mesh) return;
      await nv.addMesh({
        url: mesh,
        name: mesh.name,
        color: [0.7, 0.7, 0.7, 1],
      });
      if (curvature) await nv.addMeshLayer(0, { url: await curvatureLayer(curvature), name: curvature.name, ...CURVATURE });
      surface = mesh;
      mapLayer = curvature ? 1 : 0;
    },
    /** Draw an encoded map (display.js encodeOverlay) on the surface, or remove it with null. */
    async showMap(encoded, colormap, opacity = 1) {
      await ready;
      if (!surface) return;
      if (nv.meshes[0].layers.length > mapLayer) await nv.removeMeshLayer(0, mapLayer);
      if (!encoded) return;
      if (encoded.length !== nv.meshes[0].positions.length / 3) {
        throw new Error(`The maps have ${encoded.length} vertices but ${surface.name} has ${nv.meshes[0].positions.length / 3}.`);
      }
      const url = new File([writeMz3Scalars(encoded)], "map.mz3");
      await nv.addMeshLayer(0, { url, name: "map", colormap, calMin: 1, calMax: 2, colormapType: 0, isTransparentBelowCalMin: true, opacity, isColorbarVisible: false });
    },
    async setOpacity(opacity) {
      if (surface && nv.meshes[0].layers.length > mapLayer) await nv.setMeshLayerProperty(0, mapLayer, { opacity });
    },
    setView(view, hemisphere) {
      const { azimuth, elevation } = cameraFor(view, hemisphere);
      nv.azimuth = azimuth;
      nv.elevation = elevation;
    },
  };
}
