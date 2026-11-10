// The built app against the Node reference compute server in single-owner mode
// (simulated relion tool, see e2e/compute-server.mjs): the tutorial example from
// import to post-processing, class selection by clicking, downloads, a failing
// step and its retry, cancellation, and deletion rules.
import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_PORT, COMPUTE_TOKEN, E2E_ROOT } from "../playwright.config.js";

const [example] = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const COMPUTE_URL = `http://127.0.0.1:${COMPUTE_PORT}`;
const STEP_TIMEOUT = 30000;
const LABELS = {
  import: "Import movies", motioncorr: "Motion correction", ctffind: "CTF estimation", autopick: "Particle picking",
  extract: "Particle extraction", class2d: "2D classification", select: "Class selection", initialmodel: "Initial model",
  refine3d: "3D refinement", maskcreate: "Mask creation", postprocess: "Post-processing",
};

async function connect(page) {
  await page.goto("/");
  const panel = page.locator("#computeConnection");
  await panel.locator('input[type="text"]').fill(COMPUTE_URL);
  await panel.locator('input[type="password"]').fill(COMPUTE_TOKEN);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "simulated");
  await expect(page.locator("#projectSelect")).toBeEnabled();
}

async function createProject(page, name) {
  await page.locator("#projectName").fill(name);
  await page.locator("#createProject").click();
  await expect(page.locator("#projectSelect option:checked")).toHaveText(name);
  return page.locator("#projectSelect").inputValue();
}

async function loadExample(page) {
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
}

async function run(page, command, outcome = "finished") {
  await page.locator("#stepSelect").selectOption(command);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#formMessage")).toBeHidden();
  await expect(page.locator("#statusText")).toContainText(`${LABELS[command]} ${outcome}`, { timeout: STEP_TIMEOUT });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: STEP_TIMEOUT });
}

async function download(page, name) {
  const pending = page.waitForEvent("download");
  await page.locator(`#resultList [data-stage$="/${name}"] .nd-download-btn`).click();
  const item = await pending;
  return { filename: item.suggestedFilename(), bytes: readFileSync(await item.path()) };
}

function projectDir(id) {
  return join(E2E_ROOT, "data/projects", id);
}

test("boots on the workspace with the shared bar and a disabled run", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nd-app-bar:visible")).toHaveCount(1);
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#stepSelect option")).toHaveCount(11);
  await expect(page.locator("#option-angpix")).toBeVisible();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
  const bar = page.locator(".nd-app-bar:visible");
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("RELION 5.1.1");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("stay on the cluster");
});

test("a server without single-owner projects is named as unsuitable", async ({ page }) => {
  await page.route(`${COMPUTE_URL}/api/v1/info`, async route => {
    const response = await route.fetch();
    const info = await response.json();
    await route.fulfill({ response, json: { ...info, ownership: "pairing", features: [] } });
  });
  await page.goto("/");
  const panel = page.locator("#computeConnection");
  await panel.locator('input[type="text"]').fill(COMPUTE_URL);
  await panel.locator('input[type="password"]').fill(COMPUTE_TOKEN);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "simulated");
  await expect(page.locator("#serverNeeds")).toBeVisible();
  await expect(page.locator("#projectSelect")).toBeDisabled();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the RELION tutorial runs from import to post-processing", async ({ page }) => {
  test.setTimeout(300000);
  await connect(page);
  const project = await createProject(page, "Tutorial chain");
  const checksums = page.waitForResponse(response => {
    let request = response.request();
    while (request.redirectedFrom()) request = request.redirectedFrom();
    return request.url() === example.files[0].url && response.ok();
  });
  await loadExample(page);
  expect((await (await checksums).body()).length).toBe(example.files[0].bytes);
  await expect(page.locator("#option-angpix")).toHaveValue("0.885");
  await expect(page.locator("#input-movies-pattern")).toHaveValue("*.tiff");
  await expect(page.locator("#stepForm .nd-file-info")).toContainText("24 of 25 files match");

  await run(page, "import");
  await page.locator("#stepSelect").selectOption("motioncorr");
  await expect(page.locator("#input-movies")).toHaveValue(/^Import\/job001\/movies\.star$/);
  await expect(page.locator("#input-gain")).toHaveValue("@dataFile");
  await expect(page.locator("#option-dosePerFrame")).toHaveValue("1.277");
  for (const command of ["motioncorr", "ctffind", "autopick", "extract", "class2d"]) await run(page, command);

  await expect(page.locator("#classView")).toBeVisible();
  await expect(page.locator("#classGrid button[data-class]")).toHaveCount(50);
  await page.locator('#classGrid button[data-class="1"]').click();
  await page.locator('#classGrid button[data-class="3"]').click();
  await expect(page.locator('#classGrid button[data-class="3"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#stepSelect").selectOption("select");
  await expect(page.locator("#option-classes")).toHaveValue("1, 3");
  await expect(page.locator("#input-particles")).toHaveValue("Class2D/job006/run_it200_data.star");
  await run(page, "select");
  const particles = readFileSync(join(projectDir(project), "Select/job007/particles.star"), "utf8");
  expect(particles).toContain("@Extract/job005/");

  for (const command of ["initialmodel", "refine3d", "maskcreate"]) await run(page, command);
  await expect(page.locator("#imageLabel")).toContainText("MaskCreate/job010/mask.mrc");
  await page.locator("#stepSelect").selectOption("postprocess");
  await expect(page.locator("#input-halfMap")).toHaveValue("Refine3D/job009/run_half1_class001_unfil.mrc");
  await expect(page.locator("#input-mask")).toHaveValue("MaskCreate/job010/mask.mrc");
  await run(page, "postprocess");

  await expect(page.locator("#fscView")).toBeVisible();
  const star = readFileSync(join(projectDir(project), "PostProcess/job011/postprocess.star"), "utf8");
  const resolution = Number(star.match(/_rlnFinalResolution\s+(\S+)/)[1]);
  await expect(page.locator("#fscLead")).toContainText(`Final resolution ${resolution.toFixed(2)} Å`);
  await expect(page.locator("#fscChart svg.nd-chart .nd-chart-marker")).toHaveCount(1);
  await expect(page.locator("#jobList .nd-volume-toggle")).toHaveCount(11);

  const map = await download(page, "postprocess_masked.mrc");
  expect(map.filename).toBe("postprocess_masked.mrc");
  expect(map.bytes.toString("latin1", 208, 212)).toBe("MAP ");
  expect(map.bytes).toEqual(readFileSync(join(projectDir(project), "PostProcess/job011/postprocess_masked.mrc")));
  await page.locator('#resultList [data-stage$="/postprocess.mrc"] .nd-view-btn').click();
  await expect(page.locator("#imageLabel")).toContainText("× 32 × 32");
});

test("a step whose input file is gone fails, and runs again once the input is rebuilt", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  const project = await createProject(page, "Failure and retry");
  await loadExample(page);
  await run(page, "import");
  await run(page, "motioncorr");
  const movies = join(projectDir(project), "MotionCorr/job002/Movies");
  for (const name of readdirSync(movies).filter(name => name.endsWith(".mrc"))) rmSync(join(movies, name));

  await run(page, "ctffind", "failed");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText("which does not exist");
  await expect(page.locator("#technicalLog")).not.toHaveClass(/collapsed/);
  await expect(page.locator("#jobList")).toContainText("CtfFind/job003 · failed");

  // The failed job's inputs belong to MotionCorr/job002, which a job now depends on.
  await page.locator('#jobList [aria-label="View MotionCorr/job002"]').click();
  await page.locator("#deleteJob").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete job" }).click();
  await expect(page.locator("#statusText")).toContainText("cannot be deleted");

  await run(page, "motioncorr");
  await page.locator("#stepSelect").selectOption("ctffind");
  await expect(page.locator("#input-micrographs")).toHaveValue("MotionCorr/job004/corrected_micrographs.star");
  await run(page, "ctffind");
  await expect(page.locator("#jobList")).toContainText("CtfFind/job005 · succeeded");

  await page.locator('#jobList [aria-label="View CtfFind/job003"]').click();
  await page.locator("#deleteJob").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete job" }).click();
  await expect(page.locator("#jobList")).not.toContainText("CtfFind/job003");

  await page.locator("#deleteProject").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.locator("#projectSelect option", { hasText: "Failure and retry" })).toHaveCount(0);
});

test("the footer × cancels a running step", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  await createProject(page, "Cancellation");
  await loadExample(page);
  await run(page, "import");
  await page.locator("#stepSelect").selectOption("motioncorr");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toContainText("Motion correction cancelled", { timeout: STEP_TIMEOUT });
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#jobList")).toContainText("MotionCorr/job002 · cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a second Run click while the step is being submitted sends nothing", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  await createProject(page, "Double click");
  await loadExample(page);
  let submissions = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`${COMPUTE_URL}/api/v1/jobs`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions += 1;
    await held;
    await route.fallback();
  });
  await page.locator("#stepSelect").selectOption("import");
  await page.locator("#runButton").evaluate(button => { button.click(); button.click(); });
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect.poll(() => submissions).toBe(1);
  release();
  await expect(page.locator("#statusText")).toContainText("Import movies finished", { timeout: STEP_TIMEOUT });
  expect(submissions).toBe(1);
  await expect(page.locator("#jobList")).not.toContainText("Import/job002");
});

test("a finishing step's late refresh does not reopen Run while the next step is being submitted", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  const projectId = await createProject(page, "Late refresh");
  await loadExample(page);
  // Step A's refreshes: the first (after submitting) passes, the second (after it ends) is held.
  let projectReads = 0;
  let releaseRefresh;
  const refreshHeld = new Promise(resolve => { releaseRefresh = resolve; });
  await page.route(`${COMPUTE_URL}/api/v1/projects/${projectId}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    projectReads += 1;
    if (projectReads === 2) await refreshHeld;
    await route.fallback();
  });
  let submissions = 0;
  let releaseSubmit;
  const submitHeld = new Promise(resolve => { releaseSubmit = resolve; });
  await page.route(`${COMPUTE_URL}/api/v1/jobs`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions += 1;
    if (submissions === 2) await submitHeld;
    await route.fallback();
  });
  await page.locator("#stepSelect").selectOption("import");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Import movies finished", { timeout: STEP_TIMEOUT });
  await expect.poll(() => projectReads).toBe(2);
  // Step B starts while A's handler still waits for its refresh.
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect.poll(() => submissions).toBe(2);
  const refreshed = page.waitForResponse(response => response.url() === `${COMPUTE_URL}/api/v1/projects/${projectId}` && response.request().method() === "GET");
  releaseRefresh();
  await refreshed;
  // Let A's handler run to its end; it must leave B's guard alone.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  await expect(page.locator("#runButton")).toBeDisabled();
  releaseSubmit();
  await expect(page.locator("#statusText")).toContainText("Import movies finished", { timeout: STEP_TIMEOUT });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: STEP_TIMEOUT });
  expect(submissions).toBe(2);
});

test("a refresh that sees a just-submitted job leaves following it to the submit", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  const projectId = await createProject(page, "One follower");
  await loadExample(page);
  // Step A's second refresh (after it ends) is held until step B's job exists on the server.
  let projectReads = 0;
  let releaseRefresh;
  const refreshHeld = new Promise(resolve => { releaseRefresh = resolve; });
  await page.route(`${COMPUTE_URL}/api/v1/projects/${projectId}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    projectReads += 1;
    if (projectReads === 2) await refreshHeld;
    await route.fallback();
  });
  // Step B is created on the server, but its receipt reaches the page only after that refresh.
  let submissions = 0;
  let releaseReceipt;
  const receiptHeld = new Promise(resolve => { releaseReceipt = resolve; });
  let created;
  const jobCreated = new Promise(resolve => { created = resolve; });
  await page.route(`${COMPUTE_URL}/api/v1/jobs`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions += 1;
    if (submissions !== 2) return route.fallback();
    const response = await route.fetch();
    created();
    await receiptHeld;
    await route.fulfill({ response });
  });
  let streams = 0;
  page.on("request", request => { if (/\/api\/v1\/jobs\/[^/]+\/events$/.test(request.url())) streams += 1; });
  await page.locator("#stepSelect").selectOption("import");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Import movies finished", { timeout: STEP_TIMEOUT });
  await expect.poll(() => projectReads).toBe(2);
  await page.locator("#runButton").click();
  await jobCreated;
  const refreshed = page.waitForResponse(response => response.url() === `${COMPUTE_URL}/api/v1/projects/${projectId}` && response.request().method() === "GET");
  releaseRefresh();
  await refreshed;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  const streamsBeforeReceipt = streams;
  releaseReceipt();
  await expect(page.locator("#statusText")).toContainText("Import movies finished", { timeout: STEP_TIMEOUT });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: STEP_TIMEOUT });
  // Only the submit handler followed step B, under the step's own label.
  expect(streamsBeforeReceipt).toBe(1);
  expect(streams).toBe(2);
});

test("a job the server created is followed although both submit responses were lost", async ({ page }) => {
  test.setTimeout(120000);
  await connect(page);
  await createProject(page, "Lost receipt");
  await loadExample(page);
  // The server creates the job (the retry finds it by its idempotency key), but no response reaches the page.
  let submissions = 0;
  await page.route(`${COMPUTE_URL}/api/v1/jobs`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submissions += 1;
    await route.fetch();
    await route.abort("connectionreset");
  });
  let streams = 0;
  page.on("request", request => { if (/\/api\/v1\/jobs\/[^/]+\/events$/.test(request.url())) streams += 1; });
  await page.locator("#stepSelect").selectOption("import");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Import movies (Import/job001) finished", { timeout: STEP_TIMEOUT });
  expect(submissions).toBe(2);
  expect(streams).toBe(1);
});

test("a failed example download can be retried", async ({ page }) => {
  let attempts = 0;
  await page.route(example.files[0].url, route => {
    attempts += 1;
    return attempts === 1 ? route.fulfill({ status: 503, body: "" }) : route.continue();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
  await expect(page.locator("#option-angpix")).toHaveValue("0.885");
  expect(attempts).toBe(2);
});
