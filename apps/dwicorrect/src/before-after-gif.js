// The Corrected series' preview: an animated GIF of one axial slice of every diffusion-weighted
// volume, before correction beside after, labelled in the image, one grey scale per volume.
import { encodeGif } from "./gif.js";
import { greyPixels, greyScale } from "./frames.js";
import { B0_MAX } from "./pipeline.js";

const PANEL_WIDTH = 240;
const BANNER = 24;
const GAP = 4;

/** The volumes the preview shows: the diffusion-weighted ones (b > B0_MAX). */
export function previewVolumes(bvals) {
  return bvals.flatMap((b, v) => (b > B0_MAX ? [v] : []));
}

/** GIF bytes; `before` and `after` hold one slice per volume of a dims[0] × dims[1] grid. */
export function beforeAfterGif({ before, after, dims, aspect, volumes }) {
  const [nx, ny] = dims;
  const scale = PANEL_WIDTH / nx;
  const panelHeight = Math.round(ny * aspect * scale);
  const width = 2 * PANEL_WIDTH + GAP;
  const height = BANNER + panelHeight;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const slice = new OffscreenCanvas(nx, ny);
  const sliceContext = slice.getContext("2d");
  const frames = volumes.map((v) => {
    context.fillStyle = "black";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "white";
    context.font = "600 14px Inter, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("Before correction", PANEL_WIDTH / 2, BANNER / 2);
    context.fillText("After correction", PANEL_WIDTH + GAP + PANEL_WIDTH / 2, BANNER / 2);
    const top = greyScale(before[v], after[v]);
    for (const [k, image] of [before[v], after[v]].entries()) {
      sliceContext.putImageData(new ImageData(greyPixels(image, dims, top), nx, ny), 0, 0);
      context.drawImage(slice, k * (PANEL_WIDTH + GAP), BANNER, PANEL_WIDTH, panelHeight);
    }
    const rgba = context.getImageData(0, 0, width, height).data;
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) indices[i] = rgba[4 * i];
    return indices;
  });
  return encodeGif({ width, height, frames, delay: 15 });
}
