import assert from "node:assert/strict";
import test from "node:test";
import { denoiseVolume, denoiseVolumeAsync } from "../src/core/denoise.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import {
  denoiseZsN2nAuto,
  formatAdapterName,
  isSoftwareAdapter,
  probeWebGpuAdapter,
} from "../src/core/zsn2n-webgpu.js";

test("isSoftwareAdapter flags SwiftShader, llvmpipe, WARP, and fallback adapters", () => {
  assert.equal(isSoftwareAdapter({ isFallbackAdapter: true }), true);
  assert.equal(isSoftwareAdapter({ vendor: "google", architecture: "swiftshader" }), true);
  assert.equal(isSoftwareAdapter({ description: "Mesa llvmpipe (LLVM 17)" }), true);
  assert.equal(isSoftwareAdapter({ description: "Microsoft Basic Render Driver" }), true);
  assert.equal(isSoftwareAdapter({ vendor: "apple", architecture: "common-3", device: "Apple M3" }), false);
  assert.equal(isSoftwareAdapter({ vendor: "nvidia", description: "NVIDIA RTX 4090" }), false);
});

test("formatAdapterName produces readable labels with fallback", () => {
  assert.equal(formatAdapterName({ vendor: "apple", device: "Apple M2" }), "apple Apple M2");
  assert.equal(formatAdapterName({}), "WebGPU adapter");
});

test("probeWebGpuAdapter reports unavailable in Node without navigator.gpu", async () => {
  const probe = await probeWebGpuAdapter();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /navigator\.gpu/i);
});

test("denoiseZsN2nAuto and denoiseVolumeAsync fall back identically to CPU when WebGPU is absent", async () => {
  const h = 24;
  const w = 24;
  const randn = createNormalRng(createRng(77));
  const data = new Float32Array(h * w);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = 40 + 25 * Math.sin(i / 5) + randn() * 5;
  }

  const syncRes = denoiseVolume(data, [1, h, w], { method: "zs-n2n", iterations: 50, channels: 16, seed: 42 });
  const asyncRes = await denoiseVolumeAsync(data, [1, h, w], { method: "zs-n2n", iterations: 50, channels: 16, seed: 42 });
  assert.equal(asyncRes.details.backend, "cpu");
  assert.deepEqual(asyncRes.denoised, syncRes.denoised);

  const direct = await denoiseZsN2nAuto(data, [1, h, w], { iterations: 50, channels: 16, seed: 42 });
  assert.equal(direct.details.backend, "cpu");
  assert.deepEqual(direct.denoised, syncRes.denoised);
});
