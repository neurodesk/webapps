// Browser tests against `vite preview` of the built app: the shared shell, and
// the examples through the real workflow (download, FID-A, LCModel, results).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(examples.map((e) => [e.id, e]));

test("app boots on the workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#basisSelect option")).toHaveCount(16);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await expect(page.locator("#infoDialog")).toContainText("LCModel 6.3-1N");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

async function selectExample(page, id) {
  await page.getByRole("combobox", { name: "Example", exact: true }).selectOption(id);
  await expect(page.locator("#fileInfo")).toContainText(byId[id].files[0].name, { timeout: 300000 });
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function concentration(page, name) {
  const row = page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${name.replace(/[+]/g, "\\+")}$`) }) });
  return (await row.locator("td").nth(1).textContent()).trim();
}

test("the synthetic LCModel test case reproduces LCModel's native table", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await selectExample(page, "lcmodel-test");
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await expect(page.locator("#hzpppmInput")).toHaveValue("127.786142");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 150000 });
  // Native gfortran LCModel on the same files (exes/lcmodel/tests/data/test_lcm/native.table).
  expect(await concentration(page, "NAA")).toBe("1.91e-6");
  expect(await concentration(page, "Cr+PCr")).toBe("1.83e-6");
  await expect(page.locator("#concHeader")).toHaveText("Conc. (a.u.)");
  await expect(page.locator(".lcm-plot .lcm-fit")).toHaveCount(1);
  await page.locator("[data-view='metabolites'], .nd-view-tab:has-text('Metabolites')").first().click();
  await expect(page.locator(".lcm-plot .lcm-metabolite").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Concentrations" }).getByRole("button", { name: "Download" }).click();
  const csv = readFileSync(await (await download).path(), "utf8");
  expect(csv.split("\n")[0]).toBe("Metabolite,Concentration,SD (%),/Cr+PCr");
  expect(csv).toContain("\nNAA,0.00000191,5,1.047\n");
});

test("the GE PRESS phantom goes through FID-A and the recommended basis set", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await selectExample(page, "ge-press-phantom");
  await expect(page.locator("#datasetSummary")).toContainText("TE 35 ms");
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#basisSelect")).toHaveValue("press-3t-te35");
  await expect(page.locator("#basisAdvice")).toHaveClass(/success/);
  await expect(page.locator("#waterScaling")).toBeChecked();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 240000 });
  await expect(page.locator("#concHeader")).toHaveText("Conc. (mM)");
  const naa = Number(await concentration(page, "NAA"));
  expect(naa).toBeGreaterThan(5);
  expect(naa).toBeLessThan(12);
  await page.locator(".nd-view-tab:has-text('Preprocessing')").click();
  await expect(page.locator("#plotLabel")).toContainText("averages removed");
  const download = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "FID-A report" }).getByRole("button", { name: "Download" }).click();
  const report = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  expect(report.pipeline).toBe("run_pressproc_GEauto");
  expect(report.conjugated).toBe(true);
});

test("the Siemens SPECIAL example preprocesses and fits (178 MB download)", async ({ page }) => {
  test.skip(!process.env.LCMODEL_E2E_LARGE, "set LCMODEL_E2E_LARGE=1 to download the 178 MB twix example");
  test.setTimeout(900000);
  await page.goto("/");
  await selectExample(page, "siemens-special");
  await expect(page.locator("#basisSelect")).toHaveValue("special-3t-te8.5");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 600000 });
  expect(Number(await concentration(page, "NAA"))).toBeGreaterThan(3);
});

test("the Siemens MEGA-PRESS example fits GABA on the difference spectrum (86 MB download)", async ({ page }) => {
  test.skip(!process.env.LCMODEL_E2E_LARGE, "set LCMODEL_E2E_LARGE=1 to download the 86 MB twix example");
  test.setTimeout(900000);
  await page.goto("/");
  await selectExample(page, "siemens-megapress");
  await expect(page.locator("#datasetSummary")).toContainText("MEGA-PRESS");
  await expect(page.locator("#basisSelect")).toHaveValue("megapress-3t-te68-diff");
  await expect(page.locator("#basisAdvice")).toHaveClass(/success/);
  await expect(page.locator("#ppmEnd")).toHaveValue("1.95");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 600000 });
  await expect(page.locator("#ratioHeader")).toHaveText("/NAA+NAAG");
  const gaba = page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: /^GABA$/ }) });
  const sd = Number((await gaba.locator("td").nth(2).textContent()).replace("%", ""));
  expect(sd).toBeLessThan(20);
  const ratio = Number(await gaba.locator("td").nth(3).textContent());
  expect(ratio).toBeGreaterThan(0.05);
  expect(ratio).toBeLessThan(0.4);
  await page.locator(".nd-view-tab:has-text('Preprocessing')").click();
  await expect(page.locator("#plotLabel")).toContainText("edit-OFF");
  const download = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Edit-OFF" }).getByRole("button", { name: "Download" }).click();
  expect(readFileSync(await (await download).path(), "utf8")).toContain("$NMID");
});

test("the Philips MEGA-PRESS example is detected as edited and fits GABA", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await selectExample(page, "philips-megapress");
  // SDAT does not record editing; alternate transients show it.
  await expect(page.locator("#editedField")).toBeVisible();
  await expect(page.locator("#editedToggle")).toBeChecked();
  await expect(page.locator("#datasetSummary")).toContainText("MEGA-PRESS");
  await expect(page.locator("#datasetSummary")).toContainText("160 averages");
  await expect(page.locator("#basisSelect")).toHaveValue("megapress-3t-te68-diff");
  await expect(page.locator("#ppmEnd")).toHaveValue("1.95");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 240000 });
  await expect(page.locator("#ratioHeader")).toHaveText("/NAA+NAAG");
  const gaba = page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: /^GABA$/ }) });
  expect(Number((await gaba.locator("td").nth(2).textContent()).replace("%", ""))).toBeLessThan(20);
  const ratio = Number(await gaba.locator("td").nth(3).textContent());
  expect(ratio).toBeGreaterThan(0.1);
  expect(ratio).toBeLessThan(0.4);
  // Overriding the detection treats the transients as one unedited series.
  await page.locator("#editedToggle").uncheck();
  await expect(page.locator("#datasetSummary")).not.toContainText("MEGA-PRESS");
  await expect(page.locator("#basisSelect")).not.toHaveValue("megapress-3t-te68-diff");
  await expect(page.locator("#ppmEnd")).toHaveValue("0.2");
  await expect(page.locator("#concTable")).toBeHidden();
});

test("an uploaded .BASIS file becomes the selected basis set", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator("#basisDrop")).toBeVisible();
  const basis = byId["lcmodel-test"].files.find((f) => f.name === "3t.basis");
  const response = await request.get(basis.url);
  await page.locator("#basisInput").setInputFiles({ name: "my.basis", mimeType: "text/plain", buffer: await response.body() });
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await expect(page.locator("#basisSelect option:checked")).toHaveText("Your basis set: my.basis");
  await expect(page.locator("#basisInfo")).toContainText("my.basis");
  await page.locator("#basisSelect").selectOption("press-3t-te30");
  await expect(page.locator("#basisInfo")).toBeHidden();
});

test("a failed download can retry the same example", async ({ page }) => {
  const example = byId["lcmodel-test"];
  let attempts = 0;
  await page.route(example.files[0].url, (route) => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 503, body: "" }) : route.continue();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Example", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling a fit stops it and the fit can run again", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await selectExample(page, "lcmodel-test");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 150000 });
});
