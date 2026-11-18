// The cortical surface in NiiVue: one mesh, curvature shading as its first layer
// and the displayed map as its second.
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { readFreeSurferCurv, writeMz3, writeMz3Scalars } from "@neurodesk/webapp-components/file-io/mesh";
import { POLAR_COLORMAP, POLAR_COLORMAP_POINTS, cameraFor } from "./display.js";
import { readSurfaceMesh } from "./engine.js";

// Gyri (negative curvature) light and sulci (positive) dark, as FreeSurfer shades them,
// encoded into [1, 2] like the maps because NiiVue's layer lookup starts at zero.
const CURVATURE_RANGE = 0.15;
const CURVATURE = { colormap: "gray", calMin: 1, calMax: 2, colormapType: 0, isTransparentBelowCalMin: false, opacity: 0.6, isColorbarVisible: false };

async function curvatureLayer(file) {
  const curvature = readFreeSurferCurv(new Uint8Array(await file.arrayBuffer()));
  const shade = curvature.map((value) => 1.5 - Math.max(-CURVATURE_RANGE, Math.min(CURVATURE_RANGE, value)) / (2 * CURVATURE_RANGE));
  return new File([writeMz3Scalars(shade)], `${file.name}.mz3`);
}

// NiiVue's FreeSurfer reader needs the optional tags after the faces, which MATLAB's
// write_surf leaves out, so every surface is read by the engine and drawn from mz3.
async function meshFile(file) {
  const { vertices, faces } = await readSurfaceMesh({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return new File([writeMz3(vertices, faces)], `${file.name}.mz3`);
}

export function createSurfaceViewer(canvasId, nv = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })) {
  const ready = nv.attachTo(canvasId).then(() => {
    nv.sliceType = SLICE_TYPE.RENDER;
    nv.isColorbarVisible = false;
    nv.isOrientCubeVisible = false;
    nv.is3DCrosshairVisible = false;
    nv.addColormap(POLAR_COLORMAP, POLAR_COLORMAP_POINTS);
  });
  let surface = null;
  let mapLayer = -1;
  // NiiVue's mesh calls await file reads and GPU uploads, and calls that overlap act on each
  // other's meshes, so each change of the scene starts when the one before it has finished.
  let scene = Promise.resolve();
  function change(step) {
    const next = scene.then(async () => {
      await ready;
      return step();
    });
    scene = next.catch(() => {});
    return next;
  }
  let surfaceCalls = 0;

  return {
    nv,
    ready,
    get hasSurface() {
      return Boolean(surface);
    },
    /**
     * Show a surface, shaded by curvature when a curv file is given, or none for null. Drops any
     * map. Resolves false, without a change or an error, when a later call replaced the surface.
     */
    async showSurface(mesh, curvature) {
      const call = ++surfaceCalls;
      const replaced = () => call !== surfaceCalls;
      // Files are read outside the queue, so a slow read cannot hold up the surface that replaces it.
      const files = await Promise.all([mesh && meshFile(mesh), mesh && curvature && curvatureLayer(curvature)]).then(
        (urls) => ({ urls }),
        (error) => ({ error }),
      );
      if (replaced()) return false;
      return change(async () => {
        if (replaced()) return false;
        await nv.removeAllMeshes();
        surface = null;
        mapLayer = -1;
        if (files.error) throw files.error;
        if (!mesh) return true;
        const [meshUrl, curvatureUrl] = files.urls;
        await nv.addMesh({ url: meshUrl, name: mesh.name, color: [0.7, 0.7, 0.7, 1] });
        // NiiVue logs a mesh it cannot load and resolves without adding it.
        if (!nv.meshes[0]?.positions?.length) {
          await nv.removeAllMeshes();
          throw new Error(`${mesh.name}: the viewer could not draw this surface.`);
        }
        if (curvatureUrl) await nv.addMeshLayer(0, { url: curvatureUrl, name: curvature.name, ...CURVATURE });
        if (replaced()) return false;
        surface = mesh;
        mapLayer = curvatureUrl ? 1 : 0;
        return true;
      }).catch((error) => {
        if (replaced()) return false;
        throw error;
      });
    },
    /** Draw an encoded map (display.js encodeOverlay) on the surface, or remove it with null. */
    showMap(encoded, colormap, opacity = 1) {
      return change(async () => {
        if (!surface) return;
        if (nv.meshes[0].layers.length > mapLayer) await nv.removeMeshLayer(0, mapLayer);
        if (!encoded) return;
        if (encoded.length !== nv.meshes[0].positions.length / 3) {
          throw new Error(`The maps have ${encoded.length} vertices but ${surface.name} has ${nv.meshes[0].positions.length / 3}.`);
        }
        const url = new File([writeMz3Scalars(encoded)], "map.mz3");
        await nv.addMeshLayer(0, { url, name: "map", colormap, calMin: 1, calMax: 2, colormapType: 0, isTransparentBelowCalMin: true, opacity, isColorbarVisible: false });
      });
    },
    setOpacity(opacity) {
      return change(async () => {
        if (surface && nv.meshes[0].layers.length > mapLayer) await nv.setMeshLayerProperty(0, mapLayer, { opacity });
      });
    },
    setView(view, hemisphere) {
      const { azimuth, elevation } = cameraFor(view, hemisphere);
      nv.azimuth = azimuth;
      nv.elevation = elevation;
    },
  };
}
