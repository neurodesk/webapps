// The encoder input against micro-sam and Pillow (validation/preprocess_reference.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  channelToUint8,
  encoderTensor,
  resizeChannel,
  resizedChannels,
  resizedShape,
  threeChannels,
  toModelCoordinates,
} from "../src/preprocess.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/preprocess-reference.json", import.meta.url), "utf8"));

function digest(array) {
  return createHash("sha256").update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest("hex");
}

// preprocess_reference.py's pattern, one typed array per channel, row-major.
function pattern({ height, width, channels, dtype }) {
  const Type = { uint8: Uint8Array, uint16: Uint16Array, float32: Float32Array }[dtype];
  return Array.from({ length: channels }, (_, c) => {
    const plane = new Type(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = (x * 31 + y * 17 + c * 7 + ((x * y) >> 3)) % 251;
        value *= 1 + ((Math.floor(x / 64) + Math.floor(y / 48)) % 3);
        if (dtype === "uint16") plane[y * width + x] = (value * 97) % 65521;
        else if (dtype === "float32") plane[y * width + x] = Math.fround(Math.fround(value * Math.fround(0.37)) - 12.5);
        else plane[y * width + x] = value % 256;
      }
    }
    return plane;
  });
}

// numpy's HWC byte order for the input digest.
function interleave(planes) {
  if (planes.length === 1) return planes[0];
  const out = new planes[0].constructor(planes[0].length * planes.length);
  planes.forEach((plane, c) => plane.forEach((value, i) => { out[i * planes.length + c] = value; }));
  return out;
}

for (const item of reference.cases) {
  const name = `${item.height} × ${item.width} × ${item.channels} ${item.dtype}`;
  test(`${name}: uint8 image, Pillow resize and encoder tensor equal micro-sam's`, () => {
    const planes = pattern(item);
    assert.equal(digest(interleave(planes)), item.input_sha256, "synthetic input");
    const uint8 = threeChannels(planes).map(channelToUint8);
    assert.deepEqual(uint8.map(digest), item.uint8_sha256);
    const resized = resizedChannels(planes, item.width, item.height);
    assert.deepEqual([resized.height, resized.width], item.resized);
    assert.deepEqual(resized.channels.map(digest), item.resized_sha256);
    assert.equal(digest(encoderTensor(resized)), item.tensor_sha256);
  });
}

test("the reference covers upsampling, both downsampling orders and no resize", () => {
  const shapes = reference.cases.map(({ height, width }) => resizedShape(height, width));
  assert.ok(reference.cases.some(({ height, width }) => Math.max(height, width) < 1024));
  assert.ok(reference.cases.some(({ height, width }, i) => height - shapes[i].height > 2 * (width - shapes[i].width)));
  assert.ok(reference.cases.some(({ height, width }, i) => height === shapes[i].height && width === shapes[i].width));
});

test("a constant image maps to zeros, as micro-sam's 1e-7 guard gives", () => {
  assert.deepEqual([...channelToUint8(new Float32Array(4).fill(7))], [0, 0, 0, 0]);
});

test("NaN and infinite pixels are refused", () => {
  assert.throws(() => channelToUint8(Float32Array.of(1, NaN)), /NaN or infinite/);
  assert.throws(() => channelToUint8(Float32Array.of(1, Infinity)), /NaN or infinite/);
});

test("three or more planes keep the first three; two planes gain a zero channel", () => {
  const planes = [1, 2, 3, 4].map((v) => Float32Array.of(v));
  assert.deepEqual(threeChannels(planes).map((p) => p[0]), [1, 2, 3]);
  assert.deepEqual(threeChannels(planes.slice(0, 2)).map((p) => p[0]), [1, 2, 0]);
  assert.deepEqual(threeChannels(planes.slice(0, 1)).map((p) => p[0]), [1, 1, 1]);
});

test("resizing to the same size copies", () => {
  const data = Uint8Array.of(1, 2, 3, 4);
  assert.deepEqual([...resizeChannel(data, 2, 2, 2, 2)], [1, 2, 3, 4]);
});

test("prompt coordinates follow ResizeLongestSide.apply_coords", () => {
  // 360 → 1024 in both axes; 157 × 203 → 792 × 1024 (int(157 * 1024 / 203 + 0.5) = 792).
  assert.deepEqual(toModelCoordinates([180, 90], 360, 360), [512, 256]);
  assert.deepEqual(resizedShape(157, 203), { height: 792, width: 1024 });
  const [x, y] = toModelCoordinates([10, 20], 157, 203);
  assert.equal(x, 10 * (1024 / 203));
  assert.equal(y, 20 * (792 / 157));
});
