import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));
const diffusion = JSON.parse(readFileSync(new URL("../src/workflows/dwi-preprocessing.workflow.json", import.meta.url), "utf8"));

async function importWorkflow(page, doc) {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#workflowInput").setInputFiles({
    name: "settings.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });
}

async function exportWorkflow(page) {
  const downloaded = page.waitForEvent("download");
  await page.locator("#runButton").click();
  return JSON.parse(readFileSync(await (await downloaded).path(), "utf8"));
}

for (const [input, output] of [["bval", "bvec"], ["bvec", "bval"]]) {
  test(`an imported ${output}-to-${input} binding blocks export until corrected`, async ({ page }) => {
    const doc = structuredClone(diffusion);
    doc.steps.models.inputs[`input_${input}`].ref = `steps.correct.outputs.output_${output}`;
    await importWorkflow(page, doc);
    await expect(page.locator("#validationSummary")).toContainText("problem");
    await expect(page.locator("#stepRows")).toContainText(/formats.*incompatible/i);
    await expect(page.locator("#runButton")).toBeDisabled();
    await page.getByRole("button", { name: "models", exact: true }).click();
    await page.locator(`#bind-input_${input}`).selectOption(`steps.correct.outputs.output_${input}`);
    await expect(page.locator("#validationSummary")).toContainText("Valid");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect((await exportWorkflow(page)).steps.models.inputs[`input_${input}`].ref)
      .toBe(`steps.correct.outputs.output_${input}`);
  });
}

for (const theme of ["light", "dark"]) {
  test(`selected steps retain readable colours on hover in ${theme} mode`, async ({ page }) => {
    await importWorkflow(page, template);
    await page.evaluate(theme => document.documentElement.setAttribute("data-neurodesk-theme", theme), theme);
    const step = page.getByRole("button", { name: "n4", exact: true });
    await step.click();
    await page.mouse.move(0, 0);
    await step.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const colours = () => step.evaluate(element => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor };
    });
    const resting = await colours();
    await step.hover();
    await expect.poll(colours).toEqual(resting);
    expect(resting.text).not.toBe(resting.background);
  });
}

test("steps move in both directions while retaining their bindings and settings", async ({ page }) => {
  const doc = structuredClone(template);
  doc.steps.brain.inputs.param_threshold = { constant: 0.3 };
  await importWorkflow(page, doc);
  await page.getByRole("button", { name: "n4", exact: true }).click();
  const up = page.getByRole("button", { name: "Move up", exact: true });
  const down = page.getByRole("button", { name: "Move down", exact: true });
  await expect(up).toBeDisabled();
  await down.click();
  await expect(page.locator("#stepRows td:first-child")).toHaveText(["brain", "n4", "segment"]);
  await expect(up).toBeEnabled();
  const reordered = await exportWorkflow(page);
  expect(Object.keys(reordered.steps)).toEqual(["brain", "n4", "segment"]);
  expect(reordered.steps).toEqual(doc.steps);
  expect(reordered.inputs).toEqual(doc.inputs);
  expect(reordered.outputs).toEqual(doc.outputs);
  await up.click();
  await expect(page.locator("#stepRows td:first-child")).toHaveText(["n4", "brain", "segment"]);
  expect(await exportWorkflow(page)).toEqual(doc);
});

test("new array inputs keep their type and show the deferred count check in Export", async ({ page }) => {
  await importWorkflow(page, template);
  await page.getByRole("button", { name: "n4", exact: true }).click();
  await page.locator("#bind-input_image").selectOption("new");
  const warnings = page.locator("#workflowWarnings");
  await expect(warnings).toBeVisible();
  await warnings.locator("summary").click();
  await expect(page.locator("#warningMessages")).toContainText("Item count needs a run-time check");
  await expect(page.locator("#runButton")).toBeEnabled();
  const doc = await exportWorkflow(page);
  expect(doc.inputs.image.type).toBe("core:array<neuro:volume>");
  expect(doc.steps.n4.inputs.input_image).toEqual({ ref: "inputs.image" });
  await page.locator("#exportSection > summary").click();
  await page.locator("#exportSection > summary").click();
  await expect(warnings).toHaveAttribute("open", "");
  await expect(page.locator("#warningMessages")).toContainText("Item count needs a run-time check");
});

test("an optional NODDI map warns before exporting it or feeding a required input", async ({ page }) => {
  const doc = {
    neuroflow: "0.1.1", kind: "workflow", id: "lab.pipelines/optional-map", version: "0.1.0",
    description: "Inspect optional NODDI output availability.",
    inputs: { image: { type: "neuro:volume", formats: ["nii-gz"] } },
    steps: {
      fit: { tool: "neurodesk.webapps/noddi/fit", inputs: { input_image: { ref: "inputs.image" } } },
      n4: { tool: "neurodesk.webapps/n4/correct", inputs: { input_image: { ref: "steps.fit.outputs.output_noddi-icvf" } } },
    },
    outputs: { icvf: { type: "neuro:volume", ref: "steps.fit.outputs.output_noddi-icvf" } },
  };
  await importWorkflow(page, doc);
  await page.locator("#workflowWarnings > summary").click();
  await expect(page.locator("#warningMessages")).toContainText("is optional and may be absent when this required input runs");
  await expect(page.locator("#warningMessages")).toContainText("is optional and may not produce this workflow output");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(await exportWorkflow(page)).toEqual(doc);
});
