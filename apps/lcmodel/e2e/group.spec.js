// Groups of datasets and the per-fit report, against `vite preview` of the
// built app: Osprey's two Philips PRESS subjects through FID-A and LCModel,
// the group table and its downloads, cancelling, a failing dataset, and the
// printable report (opened, screenshotted and printed to PDF).
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const group = examples.find((e) => e.id === "philips-press-group");
const shots = join(process.env.TMPDIR ?? "test-results", "group-report", "shots");
mkdirSync(shots, { recursive: true });

function parseCsv(text) {
  return text.trimEnd().split("\n").map((line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1)
    .map(([, cell]) => (cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell)));
}

function table(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((h, k) => [h, row[k]])));
}

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const file = await event;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/** The example's files, as a user would drop them, plus any extra. */
async function groupFiles(request, extra = []) {
  const files = [];
  for (const file of group.files) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    files.push({ name: file.name, mimeType: "application/octet-stream", buffer: await response.body() });
  }
  return [...files, ...extra];
}

async function selectGroupExample(page) {
  await page.getByRole("combobox", { name: "Example", exact: true }).selectOption(group.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#datasetSelect option")).toHaveCount(2);
  await expect(page.locator("#runButton")).toHaveText("Fit all 2 datasets");
  await expect(page.locator("#runSelectedButton")).toBeVisible();
}

const groupRow = (page, name) => page.locator("#groupTable tbody tr").filter({ has: page.locator("th", { hasText: name }) });

test("a group of subjects is fitted in one run, tabulated and downloaded", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await selectGroupExample(page);
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#basisSelect")).toHaveValue("press-3t-te35-shaped");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("2 of 2 datasets fitted", { timeout: 240000 });
  await expect(page.locator(".nd-view-tab[data-view='group']")).toHaveClass(/active/);
  await expect(page.locator("#groupTable tbody tr")).toHaveCount(2);
  for (const subject of ["sub-01", "sub-02"]) {
    const row = groupRow(page, `${subject}_PRESS_35_act`);
    await expect(row.locator("td").nth(0)).toHaveText("fitted");
    await expect(row.locator("td").nth(1)).toHaveText("press-3t-te35-shaped");
    await expect(row.locator("td").nth(3)).toHaveText("mM");
  }
  await page.screenshot({ path: join(shots, "group-desktop.png") });

  // The long CSV: each subject paired with its own water reference, water-scaled NAA.
  const long = await download(page, "Group table (.csv)");
  expect(long.name).toBe("lcmodel_group.csv");
  const rows = table(long.bytes.toString());
  const naa = rows.filter((r) => r.metabolite === "NAA");
  expect(naa.map((r) => r.dataset)).toEqual(["sub-01_PRESS_35_act", "sub-02_PRESS_35_act"]);
  for (const r of naa) {
    expect(r.status).toBe("fitted");
    expect(r.unit).toBe("mM");
    expect(r.ratio_to).toBe("Cr+PCr");
    expect(Number(r.concentration)).toBeGreaterThan(4);
    expect(Number(r.concentration)).toBeLessThan(16);
    expect(Number(r.sd_percent)).toBeLessThan(20);
    expect(Number(r.lcmodel_fwhm_ppm)).toBeGreaterThan(0);
  }
  expect(naa[0].concentration).not.toBe(naa[1].concentration);

  const wide = table((await download(page, "one row per dataset")).bytes.toString());
  expect(wide.map((r) => r.dataset)).toEqual(["sub-01_PRESS_35_act", "sub-02_PRESS_35_act"]);
  expect(wide[1].NAA).toBe(naa[1].concentration);

  const zip = unzipSync(new Uint8Array((await download(page, "Reports of every fit")).bytes));
  expect(Object.keys(zip).sort()).toEqual(["lcmodel_group.csv", "sub-01_PRESS_35_act_report.html", "sub-02_PRESS_35_act_report.html"]);
  expect(strFromU8(zip["sub-02_PRESS_35_act_report.html"])).toContain("sub-02_PRESS_35_ref");

  // Ratios instead of concentrations, then a row shows that subject's fit.
  await page.locator("#groupShow").selectOption("ratio");
  await expect(groupRow(page, "sub-01_PRESS_35_act").locator("td").nth(3)).toHaveText("Cr+PCr");
  await groupRow(page, "sub-02_PRESS_35_act").getByRole("button").click();
  await expect(page.locator(".nd-view-tab[data-view='fit']")).toHaveClass(/active/);
  await expect(page.locator("#datasetSelect")).toHaveValue("1");
  await expect(page.locator("#fitSummary")).toContainText("sub-02_PRESS_35_act");
  await expect(page.locator(".lcm-plot .lcm-fit")).toHaveCount(1);
  const shown = page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: /^NAA$/ }) });
  expect(Number(await shown.locator("td").nth(1).textContent())).toBeCloseTo(Number(naa[1].concentration), 1);

  // The selected dataset alone can be refitted; the group keeps its other row.
  await page.locator("#runSelectedButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
  await page.locator(".nd-view-tab[data-view='group']").click();
  await expect(page.locator("#groupTable tbody tr")).toHaveCount(2);
});

test("the report downloads, opens in its own tab and prints on A4", async ({ page, context }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await selectGroupExample(page);
  await page.locator("#runSelectedButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 240000 });
  const report = await download(page, "Report, printable");
  expect(report.name).toBe("sub-01_PRESS_35_act_report.html");
  const html = report.bytes.toString();
  for (const text of [
    "LCModel fit: sub-01_PRESS_35_act", "Philips SDAT/SPAR", "sub-01_PRESS_35_ref", "PRESS, 3 T, TE 35 ms",
    "press-3t-te35", "LCModel 6.3-1N", "FID-A", "coil-combined data: aligned and averaged", "nunfil=", "Conc. (mM)", "/Cr+PCr",
  ]) expect(html).toContain(text);

  // Opened on its own, the document fetches nothing.
  const viewer = await context.newPage();
  const requests = [];
  viewer.on("request", (r) => requests.push(r.url()));
  await viewer.setContent(html);
  expect(requests.filter((url) => !url.startsWith("data:") && url !== "about:blank")).toEqual([]);
  await expect(viewer.locator("svg")).toHaveCount(3);
  const naa = viewer.locator("table.conc tr").filter({ has: viewer.locator("td:last-child", { hasText: /^NAA$/ }) });
  await expect(naa).toHaveCount(1);
  await viewer.emulateMedia({ media: "print" });
  await viewer.setViewportSize({ width: 794, height: 1123 });
  await viewer.screenshot({ path: join(shots, "report.png"), fullPage: true });
  const pdf = await viewer.pdf({ format: "A4", printBackground: true });
  writeFileSync(join(shots, "report.pdf"), pdf);
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pages).toBeGreaterThanOrEqual(1);
  expect(pages).toBeLessThanOrEqual(3);
  await viewer.close();

  // View opens the same report in a new tab, ready to print.
  const opened = context.waitForEvent("page");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Report, printable" }).getByRole("button", { name: "View" }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  await expect(tab).toHaveTitle("LCModel fit: sub-01_PRESS_35_act");
});

test("cancelling a group run keeps finished fits, and the group runs again", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await selectGroupExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Dataset 2 of 2", { timeout: 240000 });
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled: 1 of 2 datasets fitted");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(groupRow(page, "sub-01_PRESS_35_act").locator("td").first()).toHaveText("fitted");
  await expect(groupRow(page, "sub-02_PRESS_35_act").locator("td").first()).toHaveText("cancelled");
  // Cancel released the worker's copy of the data; the next run reads the files again.
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("2 of 2 datasets fitted", { timeout: 240000 });
});

test("a dataset that fails is listed with its error and the others are fitted", async ({ page, request }) => {
  test.setTimeout(300000);
  const files = await groupFiles(request);
  // A third subject whose scan holds no signal, and a truncated fourth that cannot be read.
  const spar = files.find((f) => f.name === "sub-02_PRESS_35_act.spar").buffer;
  const sdat = files.find((f) => f.name === "sub-02_PRESS_35_act.sdat").buffer;
  files.push(
    { name: "sub-03_PRESS_35_act.sdat", mimeType: "application/octet-stream", buffer: Buffer.alloc(sdat.length) },
    { name: "sub-03_PRESS_35_act.spar", mimeType: "text/plain", buffer: spar },
    { name: "sub-04_PRESS_35_act.sdat", mimeType: "application/octet-stream", buffer: sdat.subarray(0, 8000) },
    { name: "sub-04_PRESS_35_act.spar", mimeType: "text/plain", buffer: spar },
  );
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(files);
  await expect(page.locator("#runButton")).toHaveText("Fit all 3 datasets");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("2 of 3 datasets fitted", { timeout: 240000 });
  await expect(page.locator("#statusText")).toContainText("1 failed");
  await expect(page.locator("#groupTable tbody tr")).toHaveCount(4);
  const zero = groupRow(page, "sub-03_PRESS_35_act");
  await expect(zero.locator("td").first()).toHaveText("failed");
  await expect(zero.locator(".lcm-error")).toContainText("LCModel stopped");
  const truncated = groupRow(page, "sub-04_PRESS_35_act");
  await expect(truncated.locator(".lcm-error")).toContainText("truncated SDAT");
  await expect(groupRow(page, "sub-02_PRESS_35_act").locator("td").first()).toHaveText("fitted");
  const rows = table((await download(page, "Group table (.csv)")).bytes.toString());
  const failed = rows.filter((r) => r.status === "failed");
  expect(failed.map((r) => r.dataset).sort()).toEqual(["sub-03_PRESS_35_act", "sub-04_PRESS_35_act"]);
  expect(failed.every((r) => r.metabolite === "" && r.error)).toBe(true);
  // Its row shows the error rather than a fit.
  await zero.getByRole("button").click();
  await expect(page.locator("#viewerNotice")).toContainText("LCModel stopped");
});

test("a mixed group keeps the macromolecule model for MEGA-PRESS, and tissue-corrected values join the table", async ({ page, request }) => {
  test.setTimeout(400000);
  const mega = examples.find((e) => e.id === "philips-megapress");
  const files = [];
  for (const file of [...mega.files, ...group.files.filter((f) => f.name.startsWith("sub-02"))]) {
    const response = await request.get(file.url);
    expect(response.ok()).toBe(true);
    files.push({ name: file.name, mimeType: "application/octet-stream", buffer: await response.body() });
  }
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(files);
  await expect(page.locator("#runButton")).toHaveText("Fit all 2 datasets");
  const options = await page.locator("#datasetSelect option").allTextContents();
  await page.locator("#datasetSelect").selectOption({ index: options.findIndex((o) => o.startsWith("sub-01_megapress")) });
  await page.locator("#fitSettings > summary").click();
  await expect(page.locator("#mmModelField")).toBeVisible();
  await expect(page.locator("#lineBroadening")).toBeDisabled();
  await expect(page.locator("#lineBroadeningHint")).toBeVisible();
  await page.locator("#mmModel").selectOption("none");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("2 of 2 datasets fitted", { timeout: 300000 });
  let rows = table((await download(page, "Group table (.csv)")).bytes.toString());
  const megaRows = rows.filter((r) => r.dataset.startsWith("sub-01_megapress"));
  const pressRows = rows.filter((r) => r.dataset.startsWith("sub-02_PRESS"));
  expect(megaRows[0].basis).toBe("megapress-3t-te68-diff");
  expect(new Set(megaRows.map((r) => r.macromolecule_model))).toEqual(new Set(["none"]));
  expect(new Set(megaRows.map((r) => r.line_broadening))).toEqual(new Set(["lcmodel"]));
  expect(megaRows.some((r) => r.metabolite === "MM3co")).toBe(false);
  expect(megaRows.some((r) => r.metabolite === "GABA")).toBe(true);
  expect(new Set(pressRows.map((r) => r.macromolecule_model))).toEqual(new Set([""]));
  expect(new Set(pressRows.map((r) => r.line_broadening))).toEqual(new Set(["widened"]));
  expect(rows.every((r) => r.tissue_corrected_mmol_per_kg === "")).toBe(true);
  // Fractions typed in for the PRESS subject correct that dataset's fit.
  await groupRow(page, "sub-02_PRESS_35_act").getByRole("button").click();
  await page.locator("#tissueSection > summary").click();
  await page.locator("#fGm").fill("0.60");
  await page.locator("#fWm").fill("0.27");
  await page.locator("#fCsf").fill("0.13");
  // Clicking Download straight from the field commits it (change) as the click
  // starts; the re-rendered result list must not swallow that click.
  rows = table((await download(page, "Group table (.csv)")).bytes.toString());
  await expect(page.locator("#corrHeader")).toBeVisible();
  const naa = rows.find((r) => r.dataset.startsWith("sub-02_PRESS") && r.metabolite === "NAA+NAAG");
  expect(Number(naa.tissue_corrected_mmol_per_kg) / Number(naa.concentration)).toBeCloseTo(12.6215878899 / 12, 3);
  expect([naa.fraction_gm, naa.fraction_wm, naa.fraction_csf, naa.fraction_source]).toEqual(["0.6", "0.27", "0.13", "entered"]);
  expect(rows.filter((r) => r.dataset.startsWith("sub-01_megapress")).every((r) => r.tissue_corrected_mmol_per_kg === "")).toBe(true);
  await page.locator(".nd-view-tab[data-view='group']").click();
  await page.locator("#groupShow").selectOption("tissue");
  await expect(groupRow(page, "sub-02_PRESS_35_act").locator("td").nth(3)).toHaveText("mmol/kg");
});

test("the group table fits a phone screen", async ({ page }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await selectGroupExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("2 of 2 datasets fitted", { timeout: 240000 });
  await page.locator("#groupView").scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: join(shots, "group-phone.png"), fullPage: true });
});
