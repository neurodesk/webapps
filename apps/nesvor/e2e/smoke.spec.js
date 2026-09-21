// Real browser test against the built app and the Node reference compute server
// (simulated nesvor). Proves the deployed contract: shell, isolation, the example,
// connection explanations, a reconstruction round trip, cancellation and failure.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { COMPUTE_PORT, COMPUTE_TOKEN } from "../playwright.config.js";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const example = examples[0];
const COMPUTE_URL = `http://127.0.0.1:${COMPUTE_PORT}`;

async function loadExample(page) {
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#stackRows [data-stack]")).toHaveCount(example.files.filter(file => file.role === "stack").length);
}

async function connect(page, { address = COMPUTE_URL, token = COMPUTE_TOKEN } = {}) {
  const panel = page.locator("#computeConnection");
  await panel.locator('input[type="text"]').fill(address);
  await panel.locator('input[type="password"]').fill(token);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel).not.toHaveAttribute("data-state", "connecting", { timeout: 30000 });
  return panel;
}

async function download(page, name) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator(`#resultList button:has-text("Download")`).nth(name).click();
  const item = await downloadPromise;
  const stream = await item.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { filename: item.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

test("app boots with the shared bar, isolation and the compute section open", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  await expect(page.locator("#computeSection")).toHaveAttribute("open", "");
  await expect(page.locator("#computeConnection")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#runButton")).toBeDisabled();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("compute server");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("inside your own network");
});

test("the example loads every stack with its thickness and pairs the mask", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await expect(page.locator("#fileInfo")).toContainText("6 stacks loaded");
  await expect(page.locator("#thickness-0")).toHaveValue("1.25");
  await expect(page.locator("#mask-2")).toHaveValue("0");
  await expect(page.locator("#mask-0")).toHaveValue("");
  await expect(page.locator("#stackRows [data-stack]").nth(0)).toContainText("90 slices");
  await expect(page.locator("#protocol")).toHaveValue("fetal-brain");
  await expect(page.locator("#segmentation")).toBeChecked();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#runButton")).toHaveAttribute("title", /Connect to a compute server/);
  await expect(page.locator("#emptyState")).toBeHidden();
});

test("connection problems are explained and a good token connects", async ({ page }) => {
  await page.goto("/");
  const panel = await connect(page, { address: "", token: "" });
  await expect(panel).toHaveAttribute("data-state", "error");
  await expect(panel.locator(".nd-message")).toContainText("Enter the address");
  await connect(page, { address: "http://127.0.0.1:1" });
  await expect(panel).toHaveAttribute("data-state", "error", { timeout: 30000 });
  await expect(panel.locator(".nd-message")).toContainText("Could not reach 127.0.0.1:1");
  await connect(page, { token: "wrong" });
  await expect(panel.locator(".nd-message")).toContainText("rejected the access token");
  await connect(page);
  await expect(panel).toHaveAttribute("data-state", "simulated");
  await expect(panel.locator(".nd-message")).toContainText("nesvor 0.5.0");
  await expect(page.locator("#computeSection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#computeBadge")).toHaveText("simulated");
  await page.reload();
  await expect(page.locator("#computeConnection input[type=\"text\"]")).toHaveValue(COMPUTE_URL);
});

test("the example reconstructs on the compute server and downloads a NIfTI volume", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/Simulated result ready/, { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#progress")).toHaveAttribute("value", "1");
  await expect(page.locator("#resultList")).toContainText("Simulated placeholder");
  const volume = await download(page, 0);
  expect(volume.filename).toMatch(/_nesvor\.nii\.gz$/);
  const raw = gunzipSync(volume.bytes);
  expect(raw.readInt32LE(0)).toBe(348);
  expect(raw.toString("latin1", 344, 347)).toBe("n+1");
  expect(raw.length).toBeGreaterThan(352);
  const record = await download(page, 1);
  expect(JSON.parse(record.bytes.toString()).simulated).toBe(true);
  const logFile = await download(page, 2);
  expect(logFile.bytes.toString()).toContain("--registration svort");
  expect(logFile.bytes.toString()).toContain("--segmentation");
  await expect(page.locator("#technicalLog")).toContainText("Registration starts");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a running reconstruction can be cancelled and then retried", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText(/Running|Queued|Loading stacks|Motion correction/, { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Reconstruction cancelled", { timeout: 30000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/Simulated result ready/, { timeout: 120000 });
});

test("a failed job is reported with the server's reason and the app stays usable", async ({ page, request }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await request.post(`${COMPUTE_URL}/__test/fail-next`);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Reconstruction failed: nesvor exited with status 1", { timeout: 120000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#technicalLog")).toContainText("CUDA out of memory");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList button:has-text(\"Download\")")).toHaveCount(0);
});

test("changing a setting switches the protocol to custom and presets restore it", async ({ page }) => {
  await page.goto("/");
  await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
  await page.locator("#protocol").selectOption("neonatal-brain");
  await expect(page.locator("#registration")).toHaveValue("stack");
  await expect(page.locator("#otsuThresholding")).toBeChecked();
  await page.locator("#iterations").fill("2000");
  await page.locator("#iterations").dispatchEvent("change");
  await expect(page.locator("#protocol")).toHaveValue("custom");
  await page.locator("#protocol").selectOption("fetal-body");
  await expect(page.locator("#deformable")).toBeChecked();
  await expect(page.locator("#outputResolution")).toHaveValue("1");
});
