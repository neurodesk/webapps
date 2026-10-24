// Small NIfTI-1 images for the UI tests, and a stand-in for the BISON worker that answers a run
// with such images. The stand-in replaces only the module worker of src/worker.js; the page,
// its inputs, Output rows, legend, viewer and downloads are the production ones.
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

/** A 1 mm NIfTI-1 image of dims, uint8 (datatype 2) or float32 (16), gzipped. */
export function nifti(dims, { datatype = 16, fill = (k) => k } = {}) {
  const [nx, ny, nz] = dims;
  const count = nx * ny * nz;
  const bytesPerVoxel = datatype === 2 ? 1 : 4;
  const buffer = Buffer.alloc(352 + count * bytesPerVoxel);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  for (const [k, size] of [nx, ny, nz, 1, 1, 1, 1].entries()) buffer.writeInt16LE(size, 42 + 2 * k);
  buffer.writeInt16LE(datatype, 70);
  buffer.writeInt16LE(bytesPerVoxel * 8, 72);
  for (const [k, size] of [1, 1, 1, 1, 1, 1, 1, 1].entries()) buffer.writeFloatLE(size, 76 + 4 * k);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.writeUInt8(10, 123);
  buffer.writeInt16LE(1, 254);
  for (const [row, values] of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]].entries()) {
    for (const [k, value] of values.entries()) buffer.writeFloatLE(value, 280 + 16 * row + 4 * k);
  }
  buffer.write("n+1\0", 344, "latin1");
  for (let k = 0; k < count; k++) {
    if (datatype === 2) buffer.writeUInt8(fill(k) & 255, 352 + k);
    else buffer.writeFloatLE(fill(k), 352 + 4 * k);
  }
  return gzipSync(buffer);
}

export const T1 = { name: "sub-01_T1w.nii.gz", mimeType: "application/gzip", buffer: nifti([8, 8, 8], { fill: (k) => 100 + (k % 37) }) };
export const FLAIR = { name: "sub-01_FLAIR.nii.gz", mimeType: "application/gzip", buffer: nifti([8, 8, 8], { fill: (k) => 50 + (k % 23) }) };

const SLUGS = ["ventricles", "csf", "cerebellar-gm", "cerebellar-wm", "brainstem", "deep-gm", "cortical-gm", "wm", "wmh"];

/** The files a run of the stand-in returns for a T1 named t1Name, as base64. */
export function fakeResult(t1Name, mode) {
  const stem = t1Name.replace(/\.nii(\.gz)?$/, "");
  const classes = mode === "t1-flair" ? 9 : 8;
  const files = [
    { name: `${stem}_bison-labels.nii.gz`, bytes: nifti([8, 8, 8], { datatype: 2, fill: (k) => k % (classes + 1) }) },
    ...SLUGS.slice(0, classes).map((slug, c) => ({ name: `${stem}_bison-prob-${slug}.nii.gz`, bytes: nifti([8, 8, 8], { fill: (k) => ((k + c) % 10) / 10 }) })),
    { name: `${stem}_bison-mask.nii.gz`, bytes: nifti([8, 8, 8], { datatype: 2, fill: () => 1 }) },
  ];
  return {
    mode,
    files: files.map(({ name, bytes }) => ({ name, base64: bytes.toString("base64") })),
    volumes: SLUGS.slice(0, classes).map((slug, k) => ({ label: k + 1, slug, voxels: 10 * (k + 1), ml: 0.01 * (k + 1) })),
    timings: { classify: 0.1 },
    memory: {},
  };
}

/**
 * Replaces the BISON module worker with a stand-in before the page loads. `result` is what a run
 * returns (fakeResult); without it the run never ends, for cancellation. window.bisonWorkers
 * records each stand-in's messages and whether it was terminated.
 */
export async function useFakeWorker(page, result = null) {
  await page.addInitScript((answer) => {
    const Native = window.Worker;
    window.bisonWorkers = [];
    window.Worker = class extends EventTarget {
      constructor(url, options) {
        if (!/\/assets\/worker-[^/]+\.js$/.test(new URL(url, location.href).pathname)) return new Native(url, options);
        super();
        this.record = { messages: [], terminated: false };
        window.bisonWorkers.push(this.record);
      }
      postMessage(message) {
        this.record.messages.push({ type: message.type, t1Name: message.t1Name, flair: Boolean(message.flair), heldBaseUrl: message.heldBaseUrl });
        const reply = (data) => setTimeout(() => !this.record.terminated && this.onmessage?.({ data }), 50);
        reply({ type: "progress", message: "Registering T1 to the template (affine)", fraction: 0.04 });
        reply({ type: "log", line: "stand-in worker" });
        if (!answer) return;
        const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        reply({ type: "result", ...answer, files: answer.files.map(({ name, base64 }) => ({ name, bytes: decode(base64) })) });
      }
      terminate() {
        this.record.terminated = true;
      }
    };
  }, result);
}

/** The declared bytes of a file from the downloads Playwright saved. */
export async function downloaded(download) {
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}
