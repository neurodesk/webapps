/**
 * Generates thumbnail data URLs from NIfTI/DICOM volume URLs using a hidden NiiVue canvas.
 * Results are cached so each URL is only rendered once.
 */

import { Niivue, SLICE_TYPE, MULTIPLANAR_TYPE } from '@niivue/niivue';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

// Reusable hidden canvas — created lazily
let hiddenCanvas: HTMLCanvasElement | null = null;

function getHiddenCanvas(): HTMLCanvasElement {
  if (!hiddenCanvas) {
    hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = 576;
    hiddenCanvas.height = 256;
    hiddenCanvas.style.position = 'fixed';
    hiddenCanvas.style.left = '-9999px';
    hiddenCanvas.style.top = '-9999px';
    hiddenCanvas.style.pointerEvents = 'none';
    hiddenCanvas.style.opacity = '0';
    document.body.appendChild(hiddenCanvas);
  }
  return hiddenCanvas;
}

// Serialize thumbnail generation to avoid WebGL context conflicts
let queue: (() => void)[] = [];
let running = false;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
    processQueue();
  });
}

async function processQueue() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    await job();
  }
  running = false;
}

async function generateSingle(url: string, nameOverride?: string): Promise<string | null> {
  const canvas = getHiddenCanvas();

  let nv: Niivue | null = null;
  try {
    nv = new Niivue({
      loadingText: '',
      isColorbar: false,
      textHeight: 0,
      show3Dcrosshair: false,
      crosshairWidth: 0,
      dragAndDropEnabled: false,
      isResizeCanvas: false,
    });

    await nv.attachToCanvas(canvas);
    nv.setMultiplanarLayout(MULTIPLANAR_TYPE.ROW);
    nv.setSliceType(SLICE_TYPE.MULTIPLANAR);

    const name = nameOverride || url.split('/').pop() || 'volume.nii.gz';
    await nv.loadVolumes([{ url, name }]);

    if (nv.volumes.length === 0) return null;

    // Render and capture
    nv.drawScene();
    const dataUrl = canvas.toDataURL('image/png');

    // Cleanup volumes
    for (let i = nv.volumes.length - 1; i >= 0; i--) {
      nv.removeVolume(nv.volumes[i]);
    }

    return dataUrl;
  } catch (err) {
    console.warn('Failed to generate NIfTI thumbnail for', url, err);
    return null;
  }
}

/**
 * Get a thumbnail data URL for a NIfTI/DICOM volume.
 * Returns cached result if available, otherwise generates one.
 * Returns null if generation fails.
 */
/**
 * Get a thumbnail data URL for a NIfTI volume from a File object.
 * Uses blob URL internally. Cached by file name + size.
 */
export function getVolumeThumbnailFromFile(file: File): Promise<string | null> {
  const cacheKey = `file:${file.name}:${file.size}`;
  const cached = cache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const inflight = pending.get(cacheKey);
  if (inflight) return inflight;

  const promise = enqueue(async () => {
    const blobUrl = URL.createObjectURL(file);
    try {
      return await generateSingle(blobUrl, file.name);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }).then(dataUrl => {
    pending.delete(cacheKey);
    if (dataUrl) cache.set(cacheKey, dataUrl);
    return dataUrl;
  });

  pending.set(cacheKey, promise);
  return promise;
}

/**
 * Get a thumbnail data URL for a NIfTI/DICOM volume.
 * Returns cached result if available, otherwise generates one.
 * Returns null if generation fails.
 */
export function getVolumeThumbnail(url: string): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);

  const inflight = pending.get(url);
  if (inflight) return inflight;

  const promise = enqueue(() => generateSingle(url)).then(dataUrl => {
    pending.delete(url);
    if (dataUrl) cache.set(url, dataUrl);
    return dataUrl;
  });

  pending.set(url, promise);
  return promise;
}
