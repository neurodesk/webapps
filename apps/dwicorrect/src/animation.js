// The Before/after view: one axial slice of every volume in turn, before correction and,
// after a run, beside it after correction, on the shared comparison panels. Choosing a panel
// title pauses and resumes it.
import { greyPixels, greyScale } from "./frames.js";

const FRAMES_PER_SECOND = 6;

export function createBeforeAfter({ grid, before, after, afterPanel, titles, onFrame = () => {} }) {
  let slices = null;
  let corrected = null;
  let dims = null;
  let aspect = 1;
  let volume = 0;
  let playing = true;
  let timer = null;

  function draw(canvas, slice, scale) {
    const width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    if (!slice) return;
    const image = new ImageData(greyPixels(slice, dims, scale), dims[0], dims[1]);
    const source = new OffscreenCanvas(dims[0], dims[1]);
    source.getContext("2d").putImageData(image, 0, 0);
    // Fit the slice (voxel aspect `aspect` = y size / x size) inside the panel.
    const fit = Math.min(width / dims[0], height / (dims[1] * aspect));
    const w = dims[0] * fit;
    const h = dims[1] * aspect * fit;
    context.imageSmoothingEnabled = true;
    context.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
  }

  function render() {
    if (!slices || grid.hidden) return;
    const scale = greyScale(slices[volume], ...(corrected ? [corrected[volume]] : []));
    draw(before, slices[volume], scale);
    if (corrected) draw(after, corrected[volume], scale);
    onFrame(volume, slices.length);
  }

  function tick() {
    if (playing && slices) volume = (volume + 1) % slices.length;
    render();
  }

  function setPlaying(value) {
    playing = value;
    for (const title of titles) title.setAttribute("aria-pressed", String(!playing));
  }
  for (const title of titles) title.addEventListener("click", () => setPlaying(!playing));
  new ResizeObserver(() => render()).observe(grid);

  return {
    /** The input's slices (one per volume), the slice grid and the voxel aspect. */
    setBefore(next, nextDims, nextAspect = 1) {
      slices = next;
      dims = nextDims;
      aspect = nextAspect;
      corrected = null;
      volume = 0;
      afterPanel.hidden = true;
      grid.dataset.count = "1";
      render();
    },
    /** The corrected slices, or null. */
    setAfter(next) {
      corrected = next;
      afterPanel.hidden = !next;
      grid.dataset.count = next ? "2" : "1";
      render();
    },
    show() {
      grid.hidden = false;
      setPlaying(true);
      clearInterval(timer);
      timer = setInterval(tick, 1000 / FRAMES_PER_SECOND);
      render();
    },
    hide() {
      grid.hidden = true;
      clearInterval(timer);
      timer = null;
    },
    /** Stops at `v`; choosing a panel title plays again. */
    pauseAt(v) {
      if (!slices) return;
      volume = Math.max(0, Math.min(slices.length - 1, v));
      setPlaying(false);
      render();
    },
    get ready() {
      return Boolean(slices);
    },
  };
}
