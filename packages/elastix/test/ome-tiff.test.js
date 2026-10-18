import assert from "node:assert/strict";
import test from "node:test";
import { fromOmeZarr } from "@fideus-labs/ngff-zarr";
import { TiffStore } from "@fideus-labs/fiff";
import { ngffImageToItkImage } from "../src/node-ngff.js";
import { writeOmeTiff } from "../src/ome-tiff.js";

const units = { x: "micrometer", y: "micrometer", z: "nanometer" };

function image(dimension) {
  const size = dimension === 3 ? [259, 3, 2] : [7, 5];
  return {
    imageType: { dimension, componentType: "float32", pixelType: "Scalar", components: 1 },
    name: "registered calibrated",
    size,
    origin: Array(dimension).fill(0),
    spacing: [0.25, 0.75, 500].slice(0, dimension),
    direction: Float64Array.from({ length: dimension ** 2 }, (_, index) => index % (dimension + 1) === 0 ? 1 : 0),
    data: Float32Array.from({ length: size.reduce((a, b) => a * b, 1) }, (_, index) => (index - 21) / 7),
  };
}

for (const dimension of [2, 3]) {
  test(`${dimension}D OME-TIFF roundtrip preserves float pixels, shape, calibration and name`, async () => {
    const input = image(dimension);
    const shared = new Float32Array(new SharedArrayBuffer(input.data.byteLength));
    shared.set(input.data);
    input.data = shared;
    const bytes = await writeOmeTiff(input, units);
    const store = await TiffStore.fromArrayBuffer(bytes.buffer);
    const { images } = await fromOmeZarr(store, { version: "0.5" });
    assert.equal(images.length, 1);
    const [level] = images;
    assert.equal(level.name, input.name);
    for (const axis of level.dims) assert.equal(level.axesUnits[axis], units[axis]);
    const output = await ngffImageToItkImage(level);
    assert.deepEqual(output.size, input.size);
    assert.deepEqual(output.spacing, input.spacing);
    assert.deepEqual(output.origin, input.origin);
    assert.deepEqual(output.direction, input.direction);
    assert.deepEqual(output.data, input.data);
  });
}

test("OME-TIFF refuses physical geometry or units the writer would lose", async () => {
  const input = image(2);
  for (const [changed, spatialUnits, error] of [
    [{ ...input, origin: [0.001, 0] }, units, /origin/],
    [{ ...input, direction: new Float64Array([-1, 0, 0, 1]) }, units, /direction/],
    [{ ...input, direction: new Float64Array([0, -1, 1, 0]) }, units, /direction/],
    [{ ...input, direction: new Float64Array([1, 0.01, 0, 1]) }, units, /direction/],
    [input, undefined, /known spatial units/],
    [input, { x: "pixel", y: "micrometer" }, /known spatial units/],
  ]) await assert.rejects(writeOmeTiff(changed, spatialUnits), error);
});

test("a cancelled OME-TIFF export does not return a download and can be retried", async () => {
  const input = image(2);
  await assert.rejects(writeOmeTiff(input, units, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.ok((await writeOmeTiff(input, units)).byteLength > 0);
});

test("cancellation after TIFF compression starts rejects the download and retains pixels for retry", async (t) => {
  const input = image(3);
  const pixels = new Float32Array(input.data);
  const controller = new AbortController();
  const NativeCompressionStream = globalThis.CompressionStream;
  let started = false;
  t.mock.method(globalThis, "CompressionStream", function (format) {
    const stream = new NativeCompressionStream(format);
    const writer = stream.writable.getWriter();
    return {
      readable: stream.readable,
      writable: new WritableStream({
        write(chunk) {
          const pending = writer.write(chunk);
          started = true;
          controller.abort();
          return pending;
        },
        close: () => writer.close(),
      }),
    };
  });
  await assert.rejects(writeOmeTiff(input, units, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(started, true);
  assert.deepEqual(input.data, pixels);
  t.mock.restoreAll();
  const bytes = await writeOmeTiff(input, units);
  const { images: [level] } = await fromOmeZarr(await TiffStore.fromArrayBuffer(bytes.buffer), { version: "0.5" });
  assert.deepEqual((await ngffImageToItkImage(level)).data, pixels);
});
