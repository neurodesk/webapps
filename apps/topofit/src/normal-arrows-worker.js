import { surfaceNormals, normalArrows } from '@neurodesk/topofit/normal-arrows';

let surfaces;
const cache = new Map();
self.onmessage = ({ data }) => {
  try {
    if (data.surfaces) {
      surfaces = data.surfaces;
      cache.clear();
    }
    const arrows = data.hemispheres.map((hemisphere) => {
      if (!cache.has(hemisphere)) {
        cache.set(hemisphere, surfaceNormals(surfaces.vertices[`${hemisphere}.white`], surfaces.vertices[`${hemisphere}.pial`], surfaces.faces[hemisphere]));
      }
      const { bytes, count } = normalArrows(cache.get(hemisphere), data);
      return { hemisphere, bytes, count };
    });
    self.postMessage({ arrows }, arrows.map(({ bytes }) => bytes));
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
