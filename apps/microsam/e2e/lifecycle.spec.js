// The image session's lifecycle with a stand-in worker: a decode still in flight when its worker
// is terminated (channel change, new image) must not leave prompting waiting on it.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixture = (name) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url));

// Embeds at once; decodes answer a full-image mask unless window.holdDecodes is set, in which
// case they never answer, as a worker terminated mid-decode never does.
async function fakeWorker(page) {
  await page.addInitScript(() => {
    window.workerLog = [];
    window.holdDecodes = false;
    window.Worker = class {
      postMessage(message) {
        window.workerLog.push(message.type);
        if (message.type === "embed") {
          queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "embedded", backend: "wasm", seconds: 0, summary: {} } }));
        }
        if (message.type === "decode" && !window.holdDecodes) {
          const mask = new Uint8Array(message.height * message.width).fill(1);
          queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "decoded", mask, score: 1, token: 0 } }));
        }
      }

      terminate() {
        window.workerLog.push("terminate");
      }
    };
  });
}

async function embed(page) {
  await expect(page.locator("#embedButton")).toBeEnabled();
  await page.locator("#embedButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Embeddings ready/);
}

async function clickImage(page) {
  const box = await page.locator("#canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function holdDecode(page) {
  await page.evaluate(() => { window.holdDecodes = true; });
  const before = await page.evaluate(() => window.workerLog.filter((type) => type === "decode").length);
  await clickImage(page);
  await expect.poll(() => page.evaluate(() => window.workerLog.filter((type) => type === "decode").length)).toBe(before + 1);
  // A decode in flight is busy: the image and channel cannot change under it.
  await expect(page.locator("#imageInput")).toBeDisabled();
  await expect(page.locator("#channel")).toBeDisabled();
  await expect(page.locator("#acceptButton")).toBeDisabled();
  await page.evaluate(() => { window.holdDecodes = false; });
}

async function promptAndAccept(page, objects) {
  await clickImage(page);
  await expect(page.locator("#acceptButton")).toBeEnabled();
  await page.locator("#acceptButton").click();
  await expect(page.locator("#objectInfo")).toHaveText(`${objects} ${objects === 1 ? "object" : "objects"} accepted`);
}

test("a channel change or a new image during a decode leaves prompting usable", async ({ page }) => {
  await fakeWorker(page);
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "rgb.tif", mimeType: "image/tiff", buffer: fixture("rgb.tif") });
  await embed(page);

  await holdDecode(page);
  // Automation and other callers change the channel without the control; the session must end cleanly.
  await page.evaluate(() => {
    const select = document.getElementById("channel");
    select.value = "0";
    select.dispatchEvent(new Event("change"));
  });
  await embed(page);
  await promptAndAccept(page, 1);
  await expect(page.locator("#statusText")).toHaveText("Object 1 accepted · 1 object");

  await holdDecode(page);
  // The drop zone takes a new image while the decode is held.
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "uint16.tif", { type: "image/tiff" }));
    document.getElementById("dropZone").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [...fixture("uint16.tif")]);
  await expect(page.locator("#fileInfo")).toContainText("uint16.tif");
  await embed(page);
  await promptAndAccept(page, 1);
});

test("a mask inside accepted objects is reported as such", async ({ page }) => {
  await fakeWorker(page);
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "uint16.tif", mimeType: "image/tiff", buffer: fixture("uint16.tif") });
  const snapshot = await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { prompts: JSON.stringify([{ points: [[2, 2, 1]] }, { points: [[5, 5, 1]] }]) } });
    for (;;) {
      const state = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (state.state !== "running") return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  expect(snapshot.state).toBe("failed");
  expect(snapshot.error.message).toBe("This mask lies inside accepted objects; prompt a new object or undo one.");
});
