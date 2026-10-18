// Opening an image another app sent: it loads, the handoff is used up, and nothing segments.
import { test, expect } from "@playwright/test";

const MINUTE = 60 * 1000;

// A 3D FLAIR stand-in: 32 × 32 × 16 int16 voxels, 1 mm, scanner-aligned sform.
function flair() {
  const [nx, ny, nz] = [32, 32, 16];
  const bytes = Buffer.alloc(352 + nx * ny * nz * 2);
  bytes.writeInt32LE(348, 0);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((size, axis) => bytes.writeInt16LE(size, 40 + 2 * axis));
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  [1, 1, 1, 1].forEach((size, axis) => bytes.writeFloatLE(size, 76 + 4 * axis));
  bytes.writeFloatLE(352, 108);
  bytes.writeInt16LE(1, 254);
  [[1, 0, 0, -16], [0, 1, 0, -16], [0, 0, 1, -8]].forEach((row, index) => row.forEach((value, column) => bytes.writeFloatLE(value, 280 + 16 * index + 4 * column)));
  bytes.write("n+1\0", 344, "latin1");
  for (let voxel = 0; voxel < nx * ny * nz; voxel++) bytes.writeInt16LE(voxel % 1000, 352 + 2 * voxel);
  return bytes;
}

// Stores an entry as DICOM View's send would, with its secret in this tab, and opens its link.
async function arrive(page, { name = "series4_FLAIR.nii", bytes = flair(), age = 0 } = {}) {
  await page.goto("./");
  const id = await page.evaluate(async ({ name, data, age }) => {
    const id = crypto.randomUUID();
    const secret = crypto.randomUUID();
    sessionStorage.setItem(`neurodesk-handoff:${id}`, secret);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
    const proof = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("neurodesk-handoff", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("entries", "readwrite");
    transaction.objectStore("entries").put({
      id,
      createdAt: Date.now() - age,
      target: "white-matter-lesions",
      source: { app: "dicomview", title: "DICOM View" },
      proof,
      files: [{ name, type: "", blob: new Blob([new Uint8Array(data)]) }],
    });
    await new Promise((resolve) => { transaction.oncomplete = resolve; });
    database.close();
    return id;
  }, { name, data: [...bytes], age });
  await page.goto(`./#handoff=${id}`);
  await page.reload();
  return id;
}

function stored(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("neurodesk-handoff", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve) => {
      database.transaction("entries").objectStore("entries").getAllKeys().onsuccess = ({ target }) => resolve(target.result);
    });
    database.close();
    return { keys, secrets: Object.keys(sessionStorage).filter((key) => key.startsWith("neurodesk-handoff:")) };
  });
}

test.beforeEach(async ({ page }) => {
  // Every worker this page starts, to show that opening a handoff starts no segmentation.
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.startedWorkers = [];
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        window.startedWorkers.push(String(url));
      }
    };
  });
});

test("an image sent from DICOM View loads, is used up, and is not segmented", async ({ page }) => {
  await arrive(page);
  await expect(page.locator("#statusText")).toHaveText("Loaded series4_FLAIR.nii from DICOM View", { timeout: 60000 });
  await expect(page.locator("#statusText")).not.toHaveClass(/error/);
  await expect(page.locator("#fileInfo")).toHaveText("series4_FLAIR.nii · 32 × 32 × 16 voxels");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(new URL(page.url()).hash).toBe("");
  expect(await stored(page)).toEqual({ keys: [], secrets: [] });
  await page.waitForTimeout(2000);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#statusText")).toHaveText("Loaded series4_FLAIR.nii from DICOM View");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(1);
  const segmentation = await page.evaluate(() => window.startedWorkers.filter((url) => /\/worker-[^/]*\.js/.test(url)));
  expect(segmentation, "no segmentation worker started").toEqual([]);
});

test("a sent file that is not an image shows the error and leaves nothing behind", async ({ page }) => {
  await arrive(page, { name: "series4_FLAIR.nii", bytes: Buffer.from("not a NIfTI image") });
  await expect(page.locator("#statusText")).toHaveClass(/error/, { timeout: 60000 });
  await expect(page.locator("#statusText")).not.toHaveText("Drag and drop files");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  expect(new URL(page.url()).hash).toBe("");
  expect(await stored(page)).toEqual({ keys: [], secrets: [] });
});

test("an image sent more than two minutes ago is refused and deleted", async ({ page }) => {
  await arrive(page, { age: 2 * MINUTE + 1000 });
  // The shell's sweep may delete the expired entry first, and then the sender is unknown.
  await expect(page.locator("#statusText")).toHaveText(/^The image sent from (DICOM View|another app) is no longer available\. Send it again\.$/, { timeout: 60000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  const log = await page.locator("#technicalLog").textContent();
  expect(log.split("is no longer available").length - 1, "reported once").toBe(1);
  await expect(page.locator("#fileInfo")).toBeHidden();
  expect(new URL(page.url()).hash).toBe("");
  expect(await stored(page)).toEqual({ keys: [], secrets: [] });
});

// Holds the handoff at one step (the claim's secret digest, or the copy out of storage) until
// window.release(), so a drop can land while it is in progress.
async function holdHandoffAt(page, step) {
  await page.addInitScript((step) => {
    if (!location.hash.includes("handoff=")) return;
    const held = Promise.withResolvers();
    window.release = held.resolve;
    window.reachedHold = false;
    const [owner, method] = step === "claim" ? [crypto.subtle, "digest"] : [Blob.prototype, "arrayBuffer"];
    const original = owner[method];
    owner[method] = function (...args) {
      owner[method] = original;
      window.reachedHold = true;
      return held.promise.then(() => original.apply(this, args));
    };
  }, step);
}

async function drop(page, name) {
  await page.evaluate(([name, data]) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], name));
    document.getElementById("dropZone").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [name, [...flair()]]);
}

for (const step of ["claim", "copy"]) {
  test(`a drop while the handoff is at its ${step} waits behind it, and the sent image loads`, async ({ page }) => {
    await holdHandoffAt(page, step);
    await arrive(page);
    await page.waitForFunction(() => window.reachedHold);
    await expect(page.locator("#cancelButton"), "the handoff is the current job").toBeVisible();
    await drop(page, "dropped.nii");
    await expect(page.locator("#statusText")).toHaveText("Wait for the current step to finish or cancel it, then retry.");
    await page.evaluate(() => window.release());
    await expect(page.locator("#statusText")).toHaveText("Loaded series4_FLAIR.nii from DICOM View", { timeout: 60000 });
    await expect(page.locator("#fileInfo")).toHaveText("series4_FLAIR.nii · 32 × 32 × 16 voxels");
    expect(await stored(page)).toEqual({ keys: [], secrets: [] });
    await drop(page, "dropped.nii");
    await expect(page.locator("#fileInfo"), "a later drop replaces it as usual").toHaveText("dropped.nii · 32 × 32 × 16 voxels", { timeout: 60000 });
  });
}

test("cancelling while the handoff is taken leaves the app empty and the handoff used up", async ({ page }) => {
  await holdHandoffAt(page, "copy");
  await arrive(page);
  await page.waitForFunction(() => window.reachedHold);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#statusText")).not.toHaveClass(/error/);
  await page.evaluate(() => window.release());
  await page.waitForTimeout(1000);
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  expect(await stored(page)).toEqual({ keys: [], secrets: [] });
});
