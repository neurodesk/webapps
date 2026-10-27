import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadAppsRegistry } from "../../../scripts/lib/apps-registry.mjs";

const appTitle = (await loadAppsRegistry()).apps.find(app => app.id === "pipeline-builder").title;

const [example] = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const exampleUrl = example.files[0].url;
const template = JSON.parse(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));

async function chooseExample(page) {
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
}

async function exported(page) {
  const download = page.waitForEvent("download");
  await page.locator("#runButton").click();
  return JSON.parse(readFileSync(await (await download).path(), "utf8"));
}

async function dropWorkflow(page, target) {
  await page.evaluate(([text, id]) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], "dropped.workflow.json", { type: "application/json" }));
    document.getElementById(id).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [JSON.stringify(template), target]);
}

async function automationRun(page) {
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "t1.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)) });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "workflow" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  const snapshot = () => page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  await expect.poll(async () => (await snapshot()).state).not.toBe("running");
  return snapshot();
}

test("app boots with the catalog ready", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toContainText("operations from the Neurodesk catalog");
  await expect(page.locator("#toolSelect option[value='neurodesk.webapps/n4/correct']")).toHaveCount(1);
  await expect(page.locator("#toolSelect option[value^='neurodesk.webapps/pipeline-builder/']")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the page publishes a NeuroFlow registry beside itself", async ({ page }) => {
  await page.goto("/");
  const index = await page.evaluate(async () => (await fetch("neuroflow/neuroflow-registry.json")).json());
  expect(index.kind).toBe("neuroflow/registry-index");
  expect(index.workflows).toEqual(["workflows/dwi-preprocessing.workflow.json", "workflows/t1-segmentation.workflow.json"]);
  const statuses = await page.evaluate(paths => Promise.all(paths.map(async path => (await fetch(`neuroflow/${path}`)).status)), [...index.tools.slice(0, 3), "scripts/neurodesk.mjs"]);
  expect(statuses).toEqual([200, 200, 200, 200]);
});

test("the hosted example is the shipped template and exports unchanged", async ({ page }) => {
  await page.goto("/");
  await chooseExample(page);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#fileInfo")).toHaveText("t1-segmentation.workflow.json");
  await expect(page.locator("#stepRows tr")).toHaveCount(3);
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
  const download = page.waitForEvent("download");
  await page.locator("#runButton").click();
  expect((await download).suggestedFilename()).toBe("t1-segmentation.workflow.json");
  expect(JSON.parse(readFileSync(await (await download).path(), "utf8"))).toEqual(template);
});

for (const [failure, response, message] of [
  ["download", { status: 503, body: "" }, "Could not download t1-segmentation.workflow.json (HTTP 503)."],
  ["checksum", { status: 200, body: " ".repeat(example.files[0].bytes) }, "The checksum for t1-segmentation.workflow.json did not match."],
]) {
  test(`a failed example ${failure} opens nothing and can retry`, async ({ page }) => {
    let attempts = 0;
    await page.context().route(exampleUrl, route => (++attempts > 1 ? route.fallback() : route.fulfill(response)));
    await page.goto("/");
    await chooseExample(page);
    const selector = page.locator("[data-neurodesk-examples]");
    await expect(selector).toHaveAttribute("data-example-state", "error");
    await expect(selector).toContainText(message);
    await expect(page.locator("#stepRows tr")).toHaveCount(0);
    await expect(page.locator("#runButton")).toBeDisabled();
    await chooseExample(page);
    await expect(selector).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
    expect(attempts).toBe(2);
  });
}

test("cancelling the example download opens nothing and permits a retry", async ({ page }) => {
  let attempts = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.context().route(exampleUrl, async route => {
    if (++attempts > 1) return route.fallback();
    await held;
    return route.fulfill({ body: JSON.stringify(template) });
  });
  await page.goto("/");
  await chooseExample(page);
  const selector = page.locator("[data-neurodesk-examples]");
  await expect(selector).toHaveAttribute("data-example-state", "loading");
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(selector).toHaveAttribute("data-example-state", "cancelled");
  release();
  await expect(page.locator("#stepRows tr")).toHaveCount(0);
  await expect(page.locator("#fileInfo")).toBeHidden();
  await chooseExample(page);
  await expect(selector).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#stepRows tr")).toHaveCount(3);
});

test("rebinding a step drops the workflow input nothing reads any more", async ({ page }) => {
  await page.goto("/");
  await chooseExample(page);
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
  await page.getByRole("button", { name: "n4", exact: true }).click();
  await page.locator("#bind-input_image").selectOption("new");
  await expect(page.locator("#ioRows td:first-child")).toHaveText(["image", "brain", "labels"]);
  const doc = await exported(page);
  expect(Object.keys(doc.inputs)).toEqual(["image"]);
  expect(doc.steps.n4.inputs.input_image).toEqual({ ref: "inputs.image" });
});

test("steps chain by compatible outputs and the export validates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/n4/correct");
  await page.locator("#addStepButton").click();
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/brain-extraction/extract");
  await page.locator("#addStepButton").click();
  const source = page.locator("#bind-input_image");
  await expect(source).toHaveValue("steps.n4.outputs.output_image");
  await expect(source.locator("option[value='steps.n4.outputs.report']")).toHaveCount(0);
  await page.getByLabel("Workflow output: brain").check();
  await expect(page.locator("#validationSummary")).toHaveText("1 problem to fix before export. Workflow description is required.");
  await page.locator("#workflowId").fill("lab.pipelines/strip");
  await page.locator("#workflowDescription").fill("Bias-correct and skull-strip a head MRI.");
  await page.locator("#workflowDescription").press("Tab");
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 2 steps.");
  const doc = await exported(page);
  expect(doc.neuroflow).toBe("0.1.1");
  expect(doc.id).toBe("lab.pipelines/strip");
  expect(doc.description).toBe("Bias-correct and skull-strip a head MRI.");
  expect(Object.keys(doc.steps)).toEqual(["n4", "brain-extraction"]);
  expect(doc.steps.n4.inputs.input_image).toEqual({ ref: "inputs.image" });
  expect(doc.outputs.brain).toEqual({ type: "neuro:volume", ref: "steps.brain-extraction.outputs.output_brain" });
});

test("a DWI chain keeps corrected images and matching optional gradients", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  for (const operation of ["dwidenoise/denoise", "degibbs/degibbs", "dwicorrect/correct", "n4/correct", "brain-extraction/extract", "noddi/fit", "dwi2trx/tractography"]) {
    await page.locator("#toolSelect").selectOption(`neurodesk.webapps/${operation}`);
    await page.locator("#addStepButton").click();
  }
  await expect(page.locator("#bind-input_image")).toHaveValue("steps.n4.outputs.output_image");
  await expect(page.locator("#bind-input_bval")).toHaveValue("steps.n4.outputs.output_bval");
  await expect(page.locator("#bind-input_bvec")).toHaveValue("steps.n4.outputs.output_bvec");
  await expect(page.locator("#bind-input_mask")).toHaveValue("steps.noddi.outputs.output_mask");
  await expect(page.locator("#bind-input_bval option[value$='output_bvec']")).toHaveCount(0);
  await expect(page.locator("#bind-input_mask option[value='steps.n4.outputs.output_bias']")).toHaveCount(0);
  await page.getByRole("button", { name: "n4", exact: true }).click();
  await expect(page.locator("#bind-input_image")).toHaveValue("steps.dwicorrect.outputs.output_dwi");
  await page.locator("#workflowDescription").fill("Process diffusion MRI and track streamlines.");
  await page.locator("#workflowDescription").press("Tab");
  const doc = await exported(page);
  expect(doc.steps.dwicorrect.inputs.input_bvec).toEqual({ ref: "steps.degibbs.outputs.output_bvec" });
  expect(doc.steps.noddi.inputs.input_image).toEqual({ ref: "steps.n4.outputs.output_image" });
  expect(doc.steps.dwi2trx.inputs.input_bval).toEqual({ ref: "steps.n4.outputs.output_bval" });
});

test("editing a step keeps its sections as the user left them and keeps focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/brain-extraction/extract");
  await page.locator("#addStepButton").click();
  const parameters = page.locator("#stepEditor details");
  await parameters.locator("summary").click();
  const threshold = page.locator("#param-param_threshold");
  await threshold.fill("0.3");
  await threshold.press("Enter");
  await expect(parameters).toHaveAttribute("open", "");
  await expect(threshold).toBeFocused();
  await threshold.fill("0.4");
  await threshold.press("Tab");
  await expect(page.locator("#output-output_brain")).toBeFocused();
  await page.locator("#param-param_method").selectOption("bet");
  await expect(parameters).toHaveAttribute("open", "");
  await page.locator("#output-output_brain").check();
  await expect(page.locator("#output-output_brain")).toBeFocused();
  await expect(parameters).toHaveAttribute("open", "");
  await expect(threshold).toHaveValue("0.4");

  await page.locator("#stepSection > summary").click();
  await page.locator("#workflowDescription").fill("Skull-strip a head MRI.");
  await page.locator("#workflowDescription").press("Tab");
  await expect(page.locator("#stepSection")).not.toHaveAttribute("open", "");
  const stepButton = page.getByRole("button", { name: "brain-extraction", exact: true });
  await stepButton.focus();
  await stepButton.press("Enter");
  await expect(page.locator("#stepSection")).toHaveAttribute("open", "");
  await expect(page.locator("#step-brain-extraction")).toBeFocused();
  await expect(page.locator("#step-brain-extraction")).toHaveAttribute("aria-pressed", "true");
  const doc = await exported(page);
  expect(doc.steps["brain-extraction"].inputs).toMatchObject({ param_threshold: { constant: 0.4 }, param_method: { constant: "bet" } });
});

test("validation diagnostics reach the console as the workflow is edited", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  const log = page.locator("#technicalLog");
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/n4/correct");
  await page.locator("#addStepButton").click();
  await expect(log).toContainText("Workflow description is required.");
  await expect(log).toHaveClass(/collapsed/);
  await page.locator("#workflowDescription").fill("Correct a bias field.");
  await page.locator("#workflowDescription").press("Tab");
  await expect(log).toContainText("Valid · 1 step.");
});

test("a workflow dropped on the window opens through the workflow input", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await expect(page.locator("#dropZone")).toHaveClass(/nd-file-merged/);
  await dropWorkflow(page, "viewer");
  await expect(page.locator("#fileInfo")).toHaveText("dropped.workflow.json");
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
});

test("an invalid workflow opens with its problems and cannot be exported", async ({ page }) => {
  const broken = structuredClone(template);
  broken.steps.segment.inputs.input_image = { ref: "steps.n4.outputs.report" };
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#workflowInput").setInputFiles({ name: "broken.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(page.locator("#validationSummary")).toHaveText("1 problem to fix before export.");
  await expect(page.locator("#stepRows tr").nth(2)).toContainText("incompatible");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the automation operation validates a workflow", async ({ page }) => {
  await page.goto("/");
  expect((await automationRun(page)).state).toBe("succeeded");
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "workflow" }));
  expect(JSON.parse(readFileSync(await (await download).path(), "utf8"))).toEqual(template);
});

for (const [part, pattern, status] of [
  ["registry", "**/neuroflow/neuroflow-registry.json", 503],
  ["tool", "**/neuroflow/tools/n4/correct.tool.json", 404],
  ["validator", "**/*.wasm", 404],
]) {
  test(`a catalog whose ${part} cannot load validates nothing`, async ({ page }) => {
    await page.context().route(pattern, route => route.fulfill({ status, body: "" }));
    const uncaught = [];
    page.on("pageerror", error => uncaught.push(error.message));
    await page.goto("/");
    await expect(page.locator("#statusText")).toContainText("The tool catalog could not load");
    await dropWorkflow(page, "dropZone");
    await dropWorkflow(page, "viewer");
    const run = await automationRun(page);
    expect(run.state).toBe("failed");
    expect(run.error.message).toMatch(/^The tool catalog could not load: /);
    expect(run.report).toBeUndefined();
    await expect(page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "validation" }))).rejects.toThrow("unavailable");
    await expect(page.locator("#stepRows tr")).toHaveCount(0);
    await expect(page.locator("#fileInfo")).toBeHidden();
    await expect(page.locator("#validationSummary")).not.toContainText("Valid");
    await expect(page.locator("#runButton")).toBeDisabled();
    expect(uncaught).toEqual([]);
  });
}

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});


for (const width of [390, 1440]) {
  test(`About uses the catalog title at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "About", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: `About ${appTitle}`, exact: true })).toBeVisible();
    const screenshot = testInfo.outputPath(`about-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach("About dialog", { path: screenshot, contentType: "image/png" });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  });
}
