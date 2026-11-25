// Browser E2E test for the functional MRS (fMRS) workflow in the LCModel app:
// loads unaveraged GE PRESS phantom data, uploads a BIDS events.tsv, enables
// sliding windows + BOLD linewidth matching + 2D dynamic spectral GLM, runs
// the full fMRS pipeline, inspects all Time course views and window fits, and
// downloads the fMRS CSVs and HTML report.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const geExample = examples.find((e) => e.id === "ge-press-phantom");

// GE PRESS phantom has 16 averages at TR = 1.5 s (24 s total): 4 windows of 4 averages (6 s each).
const EVENTS_TSV = [
  "onset\tduration\ttrial_type",
  "0\t6\tRest",
  "6\t6\tStim",
  "12\t6\tRest",
  "18\t6\tStim",
].join("\n");

test("functional MRS workflow: windowing, BOLD matching, 2D dynamic GLM, plots, and downloads", async ({ page }) => {
  test.setTimeout(360000);
  await page.goto("/");

  // Load multi-transient GE PRESS phantom example
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(geExample.id);
  await expect(page.locator("#fileInfo")).toContainText(geExample.files[0].name, { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  // Open Functional MRS section and configure sliding windows + BOLD matching + 2D dynamic GLM
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("sliding");
  await expect(page.locator("#fmrsWindowRow")).toBeVisible();
  await expect(page.locator("#fmrsControls")).toBeVisible();
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");

  // Upload BIDS events.tsv and verify Clear events works before re-uploading
  await page.locator("#eventsInput").setInputFiles({
    name: "task-pilot_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(EVENTS_TSV, "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("task-pilot_events.tsv");
  await expect(page.locator("#eventsInfo")).toContainText("4 events");
  await expect(page.locator("#clearEventsBtn")).toBeVisible();
  await page.locator("#clearEventsBtn").click();
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await page.locator("#eventsInput").setInputFiles({
    name: "task-pilot_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(EVENTS_TSV, "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("task-pilot_events.tsv");

  // Use 4-average windows (so the 16-avg GE phantom splits into 4 windows: Rest/Stim/Rest/Stim)
  await page.locator("#fmrsWindow").fill("4");
  await page.locator("#matchLinewidth").check();
  await expect(page.locator("#dynamicGlm")).toBeChecked();

  // Verify empirical MM & baseline stiffness controls exist inside LCModel settings
  await page.locator("#fitSettings > summary").click();
  await expect(page.locator("#simulateMm")).toBeChecked();
  await page.locator("#baselineStiffness").fill("0.5");

  // Run fMRS analysis
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("fMRS done:", { timeout: 300000 });

  // Time course view is active with metabolite SVG
  await expect(page.locator(".nd-view-tab[data-view='fmrs']")).toHaveClass(/active/);
  await expect(page.locator("#plot svg.lcm-plot")).toBeVisible();
  await expect(page.locator("#fmrsPanel")).toBeVisible();
  await expect(page.locator("#fmrsMetabolite")).toBeVisible();

  // Pass 5 High-2: Grand mean is shown initially; its own Concentrations CSV download must be present and match grand_mean
  const grandDownload = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Concentrations (.csv)" }).getByRole("button", { name: "Download" }).click();
  const grandFile = await grandDownload;
  expect(grandFile.suggestedFilename()).toContain("grand_mean");
  const grandCsv = readFileSync(await grandFile.path(), "utf8");
  expect(grandCsv).toContain("Metabolite,Concentration");

  // Switch to QC time courses
  await page.locator("#fmrsPanel").selectOption("qc");
  await expect(page.locator("#plot svg.lcm-plot")).toBeVisible();
  await expect(page.locator("#plotLabel")).toContainText("QC time courses");

  // Switch to Per-transient drift
  await page.locator("#fmrsPanel").selectOption("transients");
  await expect(page.locator("#plot svg.lcm-plot")).toBeVisible();
  await expect(page.locator("#plotLabel")).toContainText("Per-transient spectral registration");

  // Switch to Contrasts & windows table and inspect the SECOND window's LCModel fit
  await page.locator("#fmrsPanel").selectOption("stats");
  await expect(page.locator("#fmrsView")).toBeVisible();
  await expect(page.locator("#fmrsView")).toContainText("By condition");
  await expect(page.locator("#fmrsView")).toContainText("Dynamic projection");

  // Click the SECOND window native button (index 1) and verify its fit & per-window downloads work
  await page.locator("#fmrsView button").nth(1).click();
  await expect(page.locator(".nd-view-tab[data-view='fit']")).toHaveClass(/active/);
  await expect(page.locator(".lcm-plot .lcm-fit")).toHaveCount(1);

  const winConcDownload = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Concentrations (.csv)" }).getByRole("button", { name: "Download" }).click();
  const winConc = await winConcDownload;
  expect(winConc.suggestedFilename()).toContain("win_02");
  expect(readFileSync(await winConc.path(), "utf8")).toContain("Metabolite,Concentration");

  const winReportDownload = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Report, printable (.html)" }).getByRole("button", { name: "Download" }).click();
  const winReport = await winReportDownload;
  expect(winReport.suggestedFilename()).toContain("win_02");
  expect(readFileSync(await winReport.path(), "utf8")).toContain("Stim #2");

  // Download fMRS time course CSV and stats CSV
  const tcDownload = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "fMRS time course, long" }).getByRole("button", { name: "Download" }).click();
  const tcCsv = readFileSync(await (await tcDownload).path(), "utf8");
  expect(tcCsv.split("\n")[0]).toContain("broadening_applied_hz");
  expect(tcCsv.split("\n")[0]).toContain("linewidth_match_status");
  expect(tcCsv).toContain("qc_status");

  const statsDownload = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "fMRS condition contrasts" }).getByRole("button", { name: "Download" }).click();
  const statsCsv = readFileSync(await (await statsDownload).path(), "utf8");
  expect(statsCsv).toContain("dynamic_projection_glm");
  expect(statsCsv).toContain("BOLD_Linewidth_Hz");

  // Pass 6 Medium: Replacing the schedule invalidates the previous fMRS run's results and downloads
  await page.locator("#eventsInput").setInputFiles({
    name: "schedule_replacement.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t12\tCondX\n12\t12\tCondY\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("schedule_replacement.tsv");
  await expect(page.locator("#resultList .nd-volume-toggle").filter({ hasText: "fMRS time course" })).toHaveCount(0);
  await expect(page.locator(".nd-view-tab[data-view='fmrs']")).toBeDisabled();
});

test("replacement events file immediately disables Run while reading, and combined page drop commits spectra + events together", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");

  // Construct a minimal 4-row Philips SDAT/SPAR + events.tsv and drop all three together onto document.body.
  await page.evaluate(() => {
    const n = 128;
    const rows = 4;
    const sdat = new Uint8Array(n * rows * 8);
    for (let i = 0; i < n * rows * 2; i += 1) {
      sdat[i * 4] = 0x80;
      sdat[i * 4 + 1] = 0x40;
    }
    const spar = "samples : 128\nrows : 4\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n";
    const tsv = "onset\tduration\ttrial_type\n0\t4\tRest\n4\t4\tStim\n";
    const dt = new DataTransfer();
    dt.items.add(new File([sdat], "scan.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([spar], "scan.spar", { type: "text/plain" }));
    dt.items.add(new File([tsv], "task_events.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });

  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("blocks");
  await expect(page.locator("#eventsInfo")).toContainText("task_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Delay File.prototype.text() on the replacement events file and confirm Run disables immediately
  await page.evaluate(() => {
    const origText = File.prototype.text;
    window.__releaseEventsRead = null;
    File.prototype.text = function delayedText() {
      if (this.name === "slow_events.tsv") {
        return new Promise((resolve) => {
          window.__releaseEventsRead = () => resolve(origText.call(this));
        });
      }
      return origText.call(this);
    };
  });

  await page.locator("#eventsInput").setInputFiles({
    name: "slow_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tA\n4\t4\tB\n", "utf8"),
  });
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#eventsInfo")).toContainText("Reading slow_events.tsv");
  await expect(page.locator("#clearEventsBtn")).toBeVisible();

  // Release the delayed read and verify the new schedule commits cleanly
  await page.evaluate(() => window.__releaseEventsRead?.());
  await expect(page.locator("#eventsInfo")).toContainText("slow_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Pass 5 Medium-1: Sliding mode must ALSO disable Run while a replacement events file is reading
  await page.locator("#fmrsMode").selectOption("sliding");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#eventsInput").setInputFiles({
    name: "slow_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tX\n4\t4\tY\n", "utf8"),
  });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.evaluate(() => window.__releaseEventsRead?.());
  await expect(page.locator("#eventsInfo")).toContainText("slow_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Pass 7 Medium-4: Picking a fast replacement while an older schedule read is still pending
  // must immediately unblock Run without waiting for the superseded read to settle.
  await page.locator("#eventsInput").setInputFiles({
    name: "slow_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tOld1\n4\t4\tOld2\n", "utf8"),
  });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#eventsInput").setInputFiles({
    name: "fast_replacement.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tNew1\n4\t4\tNew2\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("fast_replacement.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => window.__releaseEventsRead?.());
  await expect(page.locator("#eventsInfo")).toContainText("fast_replacement.tsv");

  // Pass 8 Medium-4: Clear events remains available while a replacement schedule is reading,
  // allowing the user to abandon the pending read and immediately run in sliding mode.
  await page.locator("#eventsInput").setInputFiles({
    name: "slow_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tCancel1\n4\t4\tCancel2\n", "utf8"),
  });
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#clearEventsBtn")).toBeVisible();
  await page.locator("#clearEventsBtn").click();
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => window.__releaseEventsRead?.());
  await expect(page.locator("#eventsInfo")).toBeHidden();
});

test("clearing events syncs pageDrop Undo and delayed automation read cannot overwrite a newer schedule", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");

  // Build minimal 4-row Philips SDAT/SPAR in memory
  const makeSdat = () => {
    const n = 128;
    const rows = 4;
    const buf = Buffer.alloc(n * rows * 8);
    for (let i = 0; i < n * rows * 2; i += 1) {
      buf[i * 4] = 0x80;
      buf[i * 4 + 1] = 0x40;
    }
    return buf;
  };
  const sdatBuf = makeSdat();
  const sparBuf = Buffer.from(
    "samples : 128\nrows : 4\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  );

  await page.locator("#dataInput").setInputFiles([
    { name: "scan.sdat", mimeType: "application/octet-stream", buffer: sdatBuf },
    { name: "scan.spar", mimeType: "text/plain", buffer: sparBuf },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });

  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("blocks");

  // 1. Upload eventsA, clear it, drop eventsB on the page, then click Undo -> eventsA must NOT return
  await page.locator("#eventsInput").setInputFiles({
    name: "events_a.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tRest\n4\t4\tStim\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_a.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#clearEventsBtn").click();
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();

  // Simulate a page drop of events_b.tsv on document.body
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tTaskA\n4\t4\tTaskB\n"], "events_b.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_b.tsv");
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();

  // 1b. Pass 5 Medium-2: Load scan + eventsA, drop scanB without events, click Undo -> BOTH scan + eventsA return
  await page.locator("#eventsInput").setInputFiles({
    name: "events_keep.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tRest\n4\t4\tStim\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_b.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });
  await expect(page.locator("#fileInfo")).toContainText("scan_b.sdat", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 1c. Pass 6 High-1: Delay spectrum B read, drop [B + eventsB], click Undo while B is pending ->
  // must stay on scan.sdat + events_keep.tsv (NEVER pair slow_b.sdat with events_keep.tsv)
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    window.__releaseSlowB = null;
    window.__slowBStarted = new Promise((resolve) => {
      window.__markSlowBStarted = resolve;
    });
    File.prototype.arrayBuffer = function delayedAB() {
      if (this.name === "slow_b.sdat") {
        window.__markSlowBStarted?.();
        return new Promise((resolve) => {
          window.__releaseSlowB = () => resolve(origAB.call(this));
        });
      }
      return origAB.call(this);
    };
  });

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "slow_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "slow_b.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tOther1\n4\t4\tOther2\n"], "events_other.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });

  await page.evaluate(() => window.__slowBStarted);
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();

  // Release the aborted slow_b.sdat read and confirm scan.sdat + events_keep.tsv remain paired
  await page.evaluate(() => window.__releaseSlowB?.());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat");
  await expect(page.locator("#fileInfo")).not.toContainText("slow_b.sdat");
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");

  // 1d. Pass 7 High-2: Undo while a paired dropped schedule is still reading (after spectrum loaded)
  // must abort cleanly and keep scan.sdat + events_keep.tsv active.
  await page.evaluate(() => {
    const origText = File.prototype.text;
    window.__releaseSlowPairedEv = null;
    window.__slowPairedEvStarted = new Promise((resolve) => {
      window.__markSlowPairedEvStarted = resolve;
    });
    File.prototype.text = function delayedPairedEv() {
      if (this.name === "slow_paired_events.tsv") {
        window.__markSlowPairedEvStarted?.();
        return new Promise((resolve) => {
          window.__releaseSlowPairedEv = () => resolve(origText.call(this));
        });
      }
      return origText.call(this);
    };
  });

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_c.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_c.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tC1\n4\t4\tC2\n"], "slow_paired_events.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });

  await page.evaluate(() => window.__slowPairedEvStarted);
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await page.evaluate(() => window.__releaseSlowPairedEv?.());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat");
  await expect(page.locator("#fileInfo")).not.toContainText("scan_c.sdat");
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");

  // 1e. Pass 7 Medium-3: Dropping schedule first + invalid spectrum second must keep resident
  // scan.sdat and events_keep.tsv intact with Run enabled in blocks mode.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tBad1\n4\t4\tBad2\n"], "events_orphan.tsv", { type: "text/tab-separated-values" }));
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], "broken_only.sdat", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#statusText")).toContainText(/no readable|no spectroscopy|error|missing|spar/i, { timeout: 15000 });
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat");
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 1f. Pass 8 High-1: After that rejected [events_orphan.tsv, broken_only.sdat] drop,
  // dropping a standalone schedule and clicking Undo MUST restore events_keep.tsv (NEVER events_orphan.tsv).
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tSolo1\n4\t4\tSolo2\n"], "events_solo.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_solo.tsv");
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#eventsInfo")).toContainText("events_keep.tsv");
  await expect(page.locator("#eventsInfo")).not.toContainText("events_orphan.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 1g. Pass 8 Medium-3: Selecting a schedule alongside its scan in #dataInput ("Load files…")
  // commits BOTH the scan and the schedule without listing the TSV as a spectroscopy source.
  await page.locator("#dataInput").setInputFiles([
    { name: "scan_picked.sdat", mimeType: "application/octet-stream", buffer: sdatBuf },
    { name: "scan_picked.spar", mimeType: "text/plain", buffer: sparBuf },
    { name: "picked_events.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tPickA\n4\t4\tPickB\n", "utf8") },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("scan_picked.sdat", { timeout: 30000 });
  await expect(page.locator("#fileInfo")).not.toContainText("picked_events.tsv");
  await expect(page.locator("#eventsInfo")).toContainText("picked_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 1h. Pass 9 High-2: Picking a lone schedule via #dataInput preserves resident scan for Undo
  await page.locator("#dataInput").setInputFiles({
    name: "lone_picked.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tLoneA\n4\t4\tLoneB\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("lone_picked.tsv");
  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_after_lone.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_after_lone.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });
  await expect(page.locator("#fileInfo")).toContainText("scan_after_lone.sdat", { timeout: 30000 });
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan_picked.sdat", { timeout: 30000 });
  await expect(page.locator("#fileInfo")).not.toContainText("scan_after_lone.sdat");
  await expect(page.locator("#eventsInfo")).toContainText("lone_picked.tsv");

  // 1i. Pass 9 Medium-3: A page drop with two schedules refuses ambiguity instead of loading the first
  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_ambig.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_ambig.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tA1\n4\t4\tA2\n"], "ambig_1.tsv", { type: "text/tab-separated-values" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tB1\n4\t4\tB2\n"], "ambig_2.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });
  await expect(page.locator("#fileInfo")).toContainText("scan_ambig.sdat", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();

  // 1j. Pass 9 Medium-5 & Pass 17 Medium-4: A schedule read that settles while a failing scan
  // import is busy clears "Reading…" and commits once the unchanged resident spectrum settles.
  await page.evaluate(() => {
    const origText = File.prototype.text;
    const origAB = File.prototype.arrayBuffer;
    window.__releaseDiscardEv = null;
    window.__releaseFailScan = null;
    window.__failScanStarted = new Promise((resolve) => {
      window.__markFailScanStarted = resolve;
    });
    File.prototype.text = function delayedDiscard() {
      if (this.name === "slow_discard.tsv") {
        return new Promise((resolve) => {
          window.__releaseDiscardEv = () => resolve(origText.call(this));
        });
      }
      return origText.call(this);
    };
    File.prototype.arrayBuffer = function delayedFailAB() {
      if (this.name === "fail_slow.sdat") {
        window.__markFailScanStarted?.();
        return new Promise((resolve) => {
          window.__releaseFailScan = () => resolve(origAB.call(this));
        });
      }
      return origAB.call(this);
    };
  });
  await page.locator("#eventsInput").setInputFiles({
    name: "slow_discard.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tD1\n4\t4\tD2\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("Reading slow_discard.tsv");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], "fail_slow.sdat", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.evaluate(() => window.__failScanStarted);
  await page.evaluate(() => window.__releaseDiscardEv?.());
  await page.evaluate(() => window.__releaseFailScan?.());
  await expect(page.locator("#statusText")).toContainText(/no readable|no spectroscopy|error|missing|spar/i, { timeout: 15000 });
  await expect(page.locator("#eventsInfo")).toContainText("slow_discard.tsv: 2 events");
  await expect(page.locator("#eventsInfo")).not.toContainText("Reading");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 1k. Pass 10 High-1: Loading scan A via #dropZone records scan A for Undo so a subsequent
  // page drop of [scan B, schedule B] restores BOTH scan A and schedule A on Undo.
  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_dz_a.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_dz_a.spar", { type: "text/plain" }));
    document.getElementById("dropZone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });
  await expect(page.locator("#fileInfo")).toContainText("scan_dz_a.sdat", { timeout: 30000 });
  await page.locator("#eventsInput").setInputFiles({
    name: "events_dz_a.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tDzA1\n4\t4\tDzA2\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_dz_a.tsv");

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_dz_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_dz_b.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tDzB1\n4\t4\tDzB2\n"], "events_dz_b.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes: Array.from(sdatBuf), sparBytes: Array.from(sparBuf) });
  await expect(page.locator("#fileInfo")).toContainText("scan_dz_b.sdat", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("events_dz_b.tsv");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan_dz_a.sdat", { timeout: 30000 });
  await expect(page.locator("#fileInfo")).not.toContainText("scan_dz_b.sdat");
  await expect(page.locator("#eventsInfo")).toContainText("events_dz_a.tsv");

  // 1l. Pass 10 High-2: Dropping a standalone anatomical NIfTI alongside an unrelated TSV
  // loads T1 while keeping scan A + schedule A intact, and must NOT poison a later Undo.
  const t1Bytes = Array.from(syntheticNifti({ dims: [8, 8, 8], gzip: false }));
  await page.evaluate(({ t1Bytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(t1Bytes)], "anatomy_side.nii", { type: "application/octet-stream" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tUnrel1\n4\t4\tUnrel2\n"], "unrelated_side.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { t1Bytes });
  await expect(page.locator("#t1Canvas")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#eventsInput")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("events_dz_a.tsv");

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tAfter1\n4\t4\tAfter2\n"], "events_after_side.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#eventsInfo")).toContainText("events_after_side.tsv");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#eventsInfo")).toContainText("events_dz_a.tsv");
  await expect(page.locator("#eventsInfo")).not.toContainText("unrelated_side.tsv");

  // 2. Delayed automation fit-fmrs events read must not overwrite a newer picker schedule
  await page.evaluate(() => {
    const origText = File.prototype.text;
    window.__releaseAutoEvents = null;
    window.__autoReadStarted = new Promise((resolve) => {
      window.__markAutoReadStarted = resolve;
    });
    File.prototype.text = function delayedAutoText() {
      if (this.name === "auto_stale.tsv") {
        window.__markAutoReadStarted?.();
        return new Promise((resolve) => {
          window.__releaseAutoEvents = () => resolve(origText.call(this));
        });
      }
      return origText.call(this);
    };
  });

  const dispatch = (command, request = {}) =>
    page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

  await page.locator("#neurodesk-input-transfer").setInputFiles([
    { name: "scan.sdat", mimeType: "application/octet-stream", buffer: sdatBuf },
    { name: "scan.spar", mimeType: "text/plain", buffer: sparBuf },
  ]);
  await dispatch("adopt", { role: "spectra" });
  await page.locator("#neurodesk-input-transfer").setInputFiles([
    { name: "auto_stale.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tStale1\n4\t4\tStale2\n", "utf8") },
  ]);
  await dispatch("adopt", { role: "events" });
  await dispatch("start", { operation: "fit-fmrs", parameters: { fmrsMode: "blocks", dynamicGlm: false } });

  // Wait until fit-fmrs has finished importing spectra and paused on reading auto_stale.tsv
  await page.evaluate(() => window.__autoReadStarted);

  // User picks a newer schedule while automation's read is suspended
  await page.locator("#eventsInput").setInputFiles({
    name: "user_newer.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tFreshA\n4\t4\tFreshB\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("user_newer.tsv");

  // Release the delayed automation read and verify it fails without overwriting user_newer.tsv
  await page.evaluate(() => window.__releaseAutoEvents?.());
  await expect.poll(async () => (await dispatch("snapshot")).state, { timeout: 30000 }).not.toBe("running");
  const snapshot = await dispatch("snapshot");
  expect(snapshot.state).toBe("failed");
  expect(snapshot.error?.message ?? "").toMatch(/changed while reading automation events/i);
  await expect(page.locator("#eventsInfo")).toContainText("user_newer.tsv");
});

test("Undo restores paired T1 anatomy, custom basis, RAW water, and never leaks pre-automation schedules or empty-start Undo", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");

  const makeSdat = () => {
    const n = 128;
    const rows = 4;
    const buf = Buffer.alloc(n * rows * 8);
    for (let i = 0; i < n * rows * 2; i += 1) {
      buf[i * 4] = 0x80;
      buf[i * 4 + 1] = 0x40;
    }
    return buf;
  };
  const sdatBytes = Array.from(makeSdat());
  const sparBytes = Array.from(Buffer.from(
    "samples : 128\nrows : 4\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  ));
  const t1ABytes = Array.from(syntheticNifti({ dims: [8, 8, 8], gzip: false }));
  const t1BBytes = Array.from(syntheticNifti({ dims: [10, 10, 10], gzip: false }));

  // 1. Pass 11 Medium-4: Starting empty -> pick unreadable file -> drop valid scan+schedule -> NO Undo offered
  await page.locator("#dataInput").setInputFiles({
    name: "unreadable.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(page.locator("#statusText")).toContainText(/no readable|no spectroscopy|error/i, { timeout: 15000 });

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_a.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_a.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tA1\n4\t4\tA2\n"], "ev_a.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes, sparBytes });
  await expect(page.locator("#fileInfo")).toContainText("scan_a.sdat", { timeout: 30000 });
  await expect(page.locator(".nd-status-undo")).toHaveCount(0);

  // 2. Pass 11 High-1a: Spectrum A + T1 A -> drop [Spectrum B, T1 B] -> Undo restores BOTH Spectrum A and T1 A
  await page.locator("#tissueSection > summary").click();
  await page.locator("#t1Input").setInputFiles({
    name: "t1_a.nii",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(t1ABytes),
  });
  await expect(page.locator("#t1Info")).toContainText("t1_a.nii", { timeout: 30000 });
  await expect(page.locator("#t1Input")).toBeEnabled({ timeout: 30000 });

  await page.evaluate(({ sdatBytes, sparBytes, t1BBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_b.spar", { type: "text/plain" }));
    dt.items.add(new File([new Uint8Array(t1BBytes)], "t1_b.nii", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes, sparBytes, t1BBytes });
  await expect(page.locator("#fileInfo")).toContainText("scan_b.sdat", { timeout: 30000 });
  await expect(page.locator("#t1Info")).toContainText("t1_b.nii", { timeout: 30000 });
  // Pass 12 High-1: Click Undo immediately without waiting for anatomy rendering to finish
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan_a.sdat", { timeout: 30000 });
  await expect(page.locator("#t1Info")).toContainText("t1_a.nii", { timeout: 30000 });
  await expect(page.locator("#t1Info")).not.toContainText("t1_b.nii");
  await expect(page.locator("#dataInput")).toBeEnabled({ timeout: 30000 });

  // 2b. Pass 12 High-2: Explicitly attached Philips water with the SAME filenames as the spectrum
  // must stay a single water-paired dataset after Undo (never turning into 2 metabolite datasets).
  await page.locator("#dataInput").setInputFiles([
    { name: "scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });
  await page.locator("#waterSection > summary").click();
  await page.locator("#waterInput").setInputFiles([
    { name: "scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#datasetSummary")).toContainText("with water", { timeout: 30000 });
  await expect(page.locator("#datasetField")).toBeHidden();

  await page.evaluate(({ sdatBytes, sparBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_other.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_other.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes, sparBytes });
  await expect(page.locator("#fileInfo")).toContainText("scan_other.sdat", { timeout: 30000 });
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });
  await expect(page.locator("#datasetSummary")).toContainText("with water", { timeout: 30000 });
  await expect(page.locator("#datasetField")).toBeHidden();

  // 2c. Pass 13 High-1a: Immediate Undo while replacement T1 B is still rendering must ALSO
  // preserve Philips A's same-filename explicit water pair alongside T1 A.
  await page.locator("#t1Input").setInputFiles({
    name: "t1_water_a.nii",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(t1ABytes),
  });
  await expect(page.locator("#t1Info")).toContainText("t1_water_a.nii", { timeout: 30000 });
  await expect(page.locator("#t1Input")).toBeEnabled({ timeout: 30000 });
  await page.evaluate(({ sdatBytes, sparBytes, t1BBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdatBytes)], "scan_water_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(sparBytes)], "scan_water_b.spar", { type: "text/plain" }));
    dt.items.add(new File([new Uint8Array(t1BBytes)], "t1_water_b.nii", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdatBytes, sparBytes, t1BBytes });
  await expect(page.locator(".nd-status-undo")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#t1Info")).toContainText("t1_water_b.nii", { timeout: 30000 });
  // Click Undo immediately while T1 B may still be rendering!
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("scan.sdat", { timeout: 30000 });
  await expect(page.locator("#t1Info")).toContainText("t1_water_a.nii", { timeout: 30000 });
  await expect(page.locator("#datasetSummary")).toContainText("with water", { timeout: 30000 });
  await expect(page.locator("#datasetField")).toBeHidden();
  await expect(page.locator("#waterScaling")).toBeEnabled({ timeout: 30000 });

  // 3. Pass 11 High-1b, Pass 12 Medium-3 & Pass 13 High-1b: RAW A + explicitly attached generic-named water
  // (`acquisition_002.raw`) -> immediate Undo while RAW B is still reading MUST restore RAW A WITH water
  // scaling enabled, and settled Undo after [RAW B, custom_b.basis] must restore RAW A WITH water and clear basis.
  const rawBody = " $SEQPAR\n HZPPPM=123.25\n ECHOT=30\n SEQ='PRESS'\n DELTAT=0.0005\n $END\n $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(64);
  const basisBody = " $SEQPAR\n HZPPPM=123.25\n ECHOT=30\n SEQ='PRESS'\n $END\n $BASIS1\n IDBASI='TESTB'\n $END\n $BASIS\n METABO='NAA'\n $END\n";
  await page.locator("#dataInput").setInputFiles({
    name: "acquisition_001.raw",
    mimeType: "text/plain",
    buffer: Buffer.from(rawBody, "utf8"),
  });
  await expect(page.locator("#fileInfo")).toContainText("acquisition_001.raw", { timeout: 15000 });
  await page.locator("#waterInput").setInputFiles({
    name: "acquisition_002.raw",
    mimeType: "text/plain",
    buffer: Buffer.from(rawBody, "utf8"),
  });
  await page.locator("#fitSettings > summary").click();
  await expect(page.locator("#waterScaling")).toBeEnabled({ timeout: 15000 });

  // 3a. Immediate Undo while slow_raw_b.raw is still reading must keep acquisition_002.raw water scaling enabled!
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    window.__releaseSlowRawB = null;
    window.__slowRawBStarted = new Promise((resolve) => { window.__markSlowRawBStarted = resolve; });
    File.prototype.arrayBuffer = function delayedRawB() {
      if (this.name === "slow_raw_b.raw") {
        window.__markSlowRawBStarted?.();
        return new Promise((resolve) => {
          window.__releaseSlowRawB = () => resolve(origAB.call(this));
        });
      }
      return origAB.call(this);
    };
  });
  await page.evaluate(({ rawBody }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([rawBody], "slow_raw_b.raw", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { rawBody });
  await page.evaluate(() => window.__slowRawBStarted);
  await expect(page.locator(".nd-status-undo")).toBeVisible({ timeout: 15000 });
  await page.locator(".nd-status-undo").click();
  await page.evaluate(() => window.__releaseSlowRawB?.());
  await expect(page.locator("#dataInput")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#fileInfo")).toContainText("acquisition_001.raw", { timeout: 15000 });
  await expect(page.locator("#waterScaling")).toBeEnabled({ timeout: 15000 });

  // 3b. Settled Undo after dropping [raw_b.raw, custom_b.basis]
  await page.evaluate(({ rawBody, basisBody }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([rawBody], "raw_b.raw", { type: "text/plain" }));
    dt.items.add(new File([basisBody], "custom_b.basis", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { rawBody, basisBody });
  await expect(page.locator("#fileInfo")).toContainText("raw_b.raw", { timeout: 15000 });
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("acquisition_001.raw", { timeout: 15000 });
  await expect(page.locator("#waterScaling")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#basisSelect")).not.toHaveValue("custom");

  // 3c. Pass 14 Medium-2a: Water-only page drop keeps Undo on completion and restores prior water.
  await page.evaluate(({ rawBody }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([rawBody], "water_b.h2o", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { rawBody });
  await expect(page.locator("#waterInfo")).toContainText("water_b.h2o", { timeout: 15000 });
  await expect(page.locator("#dataInput")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#waterInfo")).toContainText("acquisition_002.raw", { timeout: 15000 });
  await expect(page.locator("#waterScaling")).toBeEnabled({ timeout: 15000 });

  // 3d. Pass 14 Medium-2b: Anatomy-only page drop keeps Undo on completion and restores prior T1.
  await page.evaluate(({ t1BBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(t1BBytes)], "t1_solo_b.nii", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { t1BBytes });
  await expect(page.locator("#t1Info")).toContainText("t1_solo_b.nii", { timeout: 30000 });
  await expect(page.locator("#dataInput")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#t1Info")).toContainText("t1_water_a.nii", { timeout: 30000 });

  // 3e. Pass 14 Medium-1: A delayed replacement .basis read cannot overwrite an Undo restore.
  const basisABody = basisBody.replace("IDBASI='TESTB'", "IDBASI='BASISA'");
  await page.locator("#basisInput").setInputFiles({
    name: "basis_a.basis",
    mimeType: "text/plain",
    buffer: Buffer.from(basisABody, "utf8"),
  });
  await expect(page.locator("#basisInfo")).toContainText("basis_a.basis", { timeout: 15000 });
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    window.__releaseSlowBasis = null;
    window.__slowBasisStarted = new Promise((resolve) => { window.__markSlowBasisStarted = resolve; });
    File.prototype.arrayBuffer = function delayedBasis() {
      if (this.name === "slow_basis_b.basis") {
        window.__markSlowBasisStarted?.();
        return new Promise((resolve) => {
          window.__releaseSlowBasis = () => resolve(origAB.call(this));
        });
      }
      return origAB.call(this);
    };
  });
  await page.evaluate(({ basisBody }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([basisBody], "slow_basis_b.basis", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { basisBody });
  await page.evaluate(() => window.__slowBasisStarted);
  // Pass 15 Medium-2: Run must disable while a replacement .basis file is still reading.
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#basisInfo")).toContainText("basis_a.basis", { timeout: 15000 });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  await page.evaluate(() => window.__releaseSlowBasis?.());
  await page.waitForTimeout(150);
  await expect(page.locator("#basisInfo")).toContainText("basis_a.basis");
  await expect(page.locator("#basisInfo")).not.toContainText("slow_basis_b.basis");

  // 3f. Pass 15 Medium-1 & Pass 16 Medium-3: Undoing an anatomy-only drop on a headerless .RAW
  // must preserve manually entered frequency/dwell fields, keep Run enabled, and NOT reopen
  // the already-loaded .RAW file (even if its File.arrayBuffer() later becomes unreadable).
  const bareRawBody = " $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(64);
  await page.locator("#dataInput").setInputFiles({
    name: "bare_acq.raw",
    mimeType: "text/plain",
    buffer: Buffer.from(bareRawBody, "utf8"),
  });
  await expect(page.locator("#fileInfo")).toContainText("bare_acq.raw", { timeout: 15000 });
  await page.locator("#hzpppmInput").fill("123.25");
  await page.locator("#dwellInput").fill("0.5");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function failBareRawOnUndo() {
      if (this.name === "bare_acq.raw") {
        return Promise.reject(new Error("Simulated unreadable resident .RAW"));
      }
      return origAB.call(this);
    };
  });
  await page.evaluate(({ t1BBytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(t1BBytes)], "t1_on_raw.nii", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { t1BBytes });
  await expect(page.locator("#t1Info")).toContainText("t1_on_raw.nii", { timeout: 30000 });
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#t1Info")).toContainText("t1_water_a.nii", { timeout: 30000 });
  await expect(page.locator("#hzpppmInput")).toHaveValue("123.25");
  await expect(page.locator("#dwellInput")).toHaveValue("0.5");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 3f2. Pass 16 Medium-2: Overlapping spectrum import while a basis read is pending, where
  // the basis finishes reading BEFORE the spectrum import settles, must still apply the basis.
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    window.__releaseOverlapBasis = null;
    window.__releaseOverlapSpec = null;
    window.__overlapBasisStarted = new Promise((r) => { window.__markOverlapBasis = r; });
    window.__overlapSpecStarted = new Promise((r) => { window.__markOverlapSpec = r; });
    File.prototype.arrayBuffer = function overlapReads() {
      if (this.name === "overlap_b.basis") {
        window.__markOverlapBasis?.();
        return new Promise((r) => { window.__releaseOverlapBasis = () => r(origAB.call(this)); });
      }
      if (this.name === "overlap_spec.raw") {
        window.__markOverlapSpec?.();
        return new Promise((r) => { window.__releaseOverlapSpec = () => r(origAB.call(this)); });
      }
      return origAB.call(this);
    };
  });
  await page.locator("#basisInput").setInputFiles({
    name: "overlap_b.basis",
    mimeType: "text/plain",
    buffer: Buffer.from(basisBody.replace("IDBASI='TESTB'", "IDBASI='OVERLAPB'"), "utf8"),
  });
  await page.evaluate(() => window.__overlapBasisStarted);
  await page.locator("#dataInput").setInputFiles({
    name: "overlap_spec.raw",
    mimeType: "text/plain",
    buffer: Buffer.from(rawBody, "utf8"),
  });
  await page.evaluate(() => window.__overlapSpecStarted);
  // Release basis FIRST while spectrum import is still busy, then release spectrum import.
  await page.evaluate(() => window.__releaseOverlapBasis?.());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__releaseOverlapSpec?.());
  await expect(page.locator("#fileInfo")).toContainText("overlap_spec.raw", { timeout: 15000 });
  await expect(page.locator("#basisInfo")).toContainText("overlap_b.basis", { timeout: 15000 });
  await expect(page.locator("#basisSelect")).toHaveValue("custom");

  // 3g. Pass 15 Medium-3 & Pass 16 Medium-1: Incompatible shared water replacement ("Apply to all")
  // must be rejected without wiping the existing valid water reference, and partial compatibility
  // must preserve auto-paired references on skipped datasets and report how many received the new file.
  const spar7tBytes = Array.from(Buffer.from(
    "samples : 128\nrows : 4\nsynthesizer_frequency : 298039000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  ));
  await page.locator("#dataInput").setInputFiles([
    { name: "ds1.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "ds1.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "ds2.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "ds2.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "w3t.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w3t.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("all 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // Incompatible 7 T shared water must fail cleanly and keep w3t attached.
  await page.locator("#waterInput").setInputFiles([
    { name: "w7t.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w7t.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText(/spectrometer frequency/i, { timeout: 30000 });
  await expect(page.locator("#waterScaling")).toBeEnabled();
  await expect(page.locator("#waterInfo")).toContainText("w3t");

  // Mixed 3 T (with auto-paired 3 T ref) + 7 T datasets with 7 T shared water must report
  // partial attachment (1 of 2) AND preserve the 3 T dataset's auto-paired reference!
  await page.locator("#dataInput").setInputFiles([
    { name: "mix3t_act.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "mix3t_act.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "mix3t_ref.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "mix3t_ref.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "mix7t.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "mix7t.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("mix3t_act.sdat", { timeout: 30000 });
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "w7t_part.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w7t_part.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("1 of 2 datasets", { timeout: 30000 });
  // Dataset 0 (mix3t_act) must STILL have its auto-paired mix3t_ref water reference!
  await expect(page.locator("#waterScaling")).toBeEnabled();
  await expect(page.locator("#waterInfo")).toContainText("mix3t_ref");

  // 3h. Pass 17 Medium-1 & Medium-2: Second shared-water upload on [3T, 7T] must preserve the
  // 3 T dataset's previously shared 3 T reference, and a subsequent individual replacement on
  // 7 T must succeed without a stale "*" assignment failing on the 3 T dataset.
  await page.locator("#dataInput").setInputFiles([
    { name: "two3t.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "two3t.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "two7t.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "two7t.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("two3t.sdat", { timeout: 30000 });
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "w3t_sh.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w3t_sh.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("1 of 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("w3t_sh");
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // Second Apply-to-all upload with 7 T water: attaches to 7 T while 3 T KEEPS w3t_sh!
  await page.locator("#waterInput").setInputFiles([
    { name: "w7t_sh.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w7t_sh.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("1 of 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("w3t_sh");
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // Switch to dataset 1 (7 T), uncheck Apply to all, and replace 7 T water individually.
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("w7t_sh");
  await page.locator("#waterAllToggle").uncheck();
  await page.locator("#waterInput").setInputFiles([
    { name: "w7t_ind.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w7t_ind.spar", mimeType: "text/plain", buffer: Buffer.from(spar7tBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("Water reference attached to the selected dataset", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("w7t_ind");
  await page.locator("#datasetSelect").selectOption("0");
  await expect(page.locator("#waterInfo")).toContainText("w3t_sh");
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // 3i. Pass 17 Medium-3 & Medium-4: Pending .basis and events.tsv reads that finish while a
  // standalone T1 import is busy must both drain and commit once T1 finishes, leaving Run enabled.
  await page.locator("#dataInput").setInputFiles([
    { name: "t1_ov_scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "t1_ov_scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("t1_ov_scan.sdat", { timeout: 30000 });
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    const origText = File.prototype.text;
    window.__releaseT1OvBasis = null;
    window.__releaseT1OvEvents = null;
    window.__releaseT1OvNii = null;
    window.__t1OvBasisStarted = new Promise((r) => { window.__markT1OvBasis = r; });
    window.__t1OvEventsStarted = new Promise((r) => { window.__markT1OvEvents = r; });
    window.__t1OvNiiStarted = new Promise((r) => { window.__markT1OvNii = r; });
    File.prototype.arrayBuffer = function t1OverlapAB() {
      if (this.name === "t1_ov.basis") {
        window.__markT1OvBasis?.();
        return new Promise((r) => { window.__releaseT1OvBasis = () => r(origAB.call(this)); });
      }
      if (this.name === "t1_ov.nii") {
        window.__markT1OvNii?.();
        return new Promise((r) => { window.__releaseT1OvNii = () => r(origAB.call(this)); });
      }
      return origAB.call(this);
    };
    File.prototype.text = function t1OverlapText() {
      if (this.name === "t1_ov_events.tsv") {
        window.__markT1OvEvents?.();
        return new Promise((r) => { window.__releaseT1OvEvents = () => r(origText.call(this)); });
      }
      return origText.call(this);
    };
  });
  await page.locator("#basisInput").setInputFiles({
    name: "t1_ov.basis",
    mimeType: "text/plain",
    buffer: Buffer.from(basisBody.replace("IDBASI='TESTB'", "IDBASI='T1OVB'"), "utf8"),
  });
  await page.evaluate(() => window.__t1OvBasisStarted);
  await page.locator("#eventsInput").setInputFiles({
    name: "t1_ov_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tRest\n4\t4\tStim\n", "utf8"),
  });
  await page.evaluate(() => window.__t1OvEventsStarted);
  await page.locator("#t1Input").setInputFiles({
    name: "t1_ov.nii",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(t1BBytes),
  });
  await page.evaluate(() => window.__t1OvNiiStarted);
  // Release basis AND events while standalone T1 import is busy, then release T1!
  await page.evaluate(() => {
    window.__releaseT1OvBasis?.();
    window.__releaseT1OvEvents?.();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__releaseT1OvNii?.());
  await expect(page.locator("#t1Info")).toContainText("t1_ov.nii", { timeout: 30000 });
  await expect(page.locator("#basisInfo")).toContainText("t1_ov.basis", { timeout: 15000 });
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await expect(page.locator("#eventsInfo")).toContainText("t1_ov_events.tsv", { timeout: 15000 });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  // Close fmrsSection back so section 4 below re-opens it cleanly
  await page.locator("#fmrsSection > summary").click();

  // 4. Pass 11 High-2: Automation load resets pageDrop's remembered schedule so a subsequent
  // schedule drop + Undo never resurrects an earlier manual session's schedule.
  await page.locator("#dataInput").setInputFiles([
    { name: "manual_prev.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "manual_prev.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("manual_prev.sdat", { timeout: 30000 });
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("sliding");
  await page.locator("#eventsInput").setInputFiles({
    name: "manual_old_sched.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tOldManual1\n4\t4\tOldManual2\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("manual_old_sched.tsv");

  // Run automation fit-fmrs with NO events (fails or finishes after clearing events & syncing pageDrop)
  const dispatch = (command, request = {}) =>
    page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
  await page.locator("#neurodesk-input-transfer").setInputFiles([
    { name: "auto_scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "auto_scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await dispatch("adopt", { role: "spectra" });
  await dispatch("start", { operation: "fit-fmrs", parameters: { fmrsMode: "blocks", dynamicGlm: false } });
  await expect.poll(async () => (await dispatch("snapshot")).state, { timeout: 30000 }).not.toBe("running");
  await expect(page.locator("#fileInfo")).toContainText("auto_scan.sdat");
  await expect(page.locator("#eventsInfo")).toBeHidden();

  // Drop a new schedule and click Undo -> must NOT resurrect manual_old_sched.tsv!
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tNewPost1\n4\t4\tNewPost2\n"], "post_auto.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator("#eventsInfo")).toContainText("post_auto.tsv");
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#eventsInfo")).not.toContainText("manual_old_sched.tsv");
});

test("fMRS per-transient QC and preprocessing stay inspectable when every window fit fails", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#runButton")).toBeVisible();

  // Build an offline 8-transient Philips SDAT/SPAR with clean damped NAA (2.0 ppm) + Cr (3.0 ppm)
  // singlets in VAX F-float format so FID-A preprocessing runs deterministically without network I/O.
  const writeVaxF = (buf, offset, val) => {
    if (val === 0) { buf.writeUInt32LE(0, offset); return; }
    const tmp = Buffer.alloc(4);
    tmp.writeFloatLE(val * 4, 0); // VAX F bias is +2 over IEEE-754 (×4)
    buf[offset] = tmp[2];
    buf[offset + 1] = tmp[3];
    buf[offset + 2] = tmp[0];
    buf[offset + 3] = tmp[1];
  };
  const n = 512;
  const rows = 8;
  const sw = 2000;
  const hzpppm = 123.25;
  const fCr = (3.03 - 4.65) * hzpppm;
  const fNaa = (2.01 - 4.65) * hzpppm;
  const sdatBuf = Buffer.alloc(n * rows * 8);
  for (let r = 0; r < rows; r += 1) {
    const df = (r - 3.5) * 0.4;
    for (let k = 0; k < n; k += 1) {
      const t = k / sw;
      const env = Math.exp(-t * 18);
      const aCr = 2 * Math.PI * (fCr + df) * t;
      const aNaa = 2 * Math.PI * (fNaa + df) * t;
      const re = env * (Math.cos(aCr) + 1.5 * Math.cos(aNaa));
      const im = env * (Math.sin(aCr) + 1.5 * Math.sin(aNaa));
      const off = (r * n + k) * 8;
      writeVaxF(sdatBuf, off, re);
      writeVaxF(sdatBuf, off + 4, im);
    }
  }
  const sparBuf = Buffer.from(
    `samples : ${n}\nrows : ${rows}\nsynthesizer_frequency : ${Math.round(hzpppm * 1e6)}\nsample_frequency : ${sw}\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n`,
    "utf8",
  );
  await page.locator("#dataInput").setInputFiles([
    { name: "fmrs_fail.sdat", mimeType: "application/octet-stream", buffer: sdatBuf },
    { name: "fmrs_fail.spar", mimeType: "text/plain", buffer: sparBuf },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("fmrs_fail.sdat", { timeout: 30000 });

  // Invert the LCModel fit range so FID-A fMRS preprocessing succeeds,
  // then every window's LCModel fit fails cleanly with a non-fatal per-bin error.
  await page.locator("#fitSettings > summary").click();
  await page.locator("#ppmStart").fill("1.0");
  await page.locator("#ppmEnd").fill("3.0");

  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("sliding");
  await page.locator("#fmrsWindow").fill("4");
  await page.locator("#dynamicGlm").uncheck();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/No fMRS windows could be fitted/i, { timeout: 60000 });

  // Time course tab must be enabled and automatically land on Per-transient drift with SVG plotted.
  const fmrsTab = page.getByRole("button", { name: "Time course" });
  const preTab = page.getByRole("button", { name: "Preprocessing" });
  await expect(fmrsTab).toBeEnabled();
  await expect(preTab).toBeEnabled();
  await expect(page.locator("#fmrsPanel")).toHaveValue("transients");
  await expect(page.locator("#plot svg.lcm-plot")).toBeVisible();
  await expect(page.locator("#plotLabel")).toContainText(/Per-transient spectral registration/i);

  // Switching to Summary & stats shows the failed window rows.
  await page.locator("#fmrsPanel").selectOption("stats");
  await expect(page.locator("#fmrsView")).toBeVisible();
  await expect(page.locator("#fmrsView")).toContainText("Window 1");
  await expect(page.locator("#resultList")).toContainText("fMRS");

  // Pass 14 Medium-3: Toggling the editing override must clear stale fMRS results & downloads.
  await page.locator("#editedToggle").check();
  await expect(fmrsTab).toBeDisabled();
  await expect(page.locator("#resultList")).not.toContainText("fMRS");
});

test("Pass 18: water Undo after individual replacement, in-flight events across water attach, and Apply-to-all after partial import", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#runButton")).toBeVisible();

  const sdatBytes = Array.from(Buffer.alloc(128 * 4 * 8, 0));
  for (let i = 0; i < 128 * 4 * 2; i += 1) {
    sdatBytes[i * 4] = 0x80;
    sdatBytes[i * 4 + 1] = 0x40;
  }
  const sparBytes = Array.from(Buffer.from(
    "samples : 128\nrows : 4\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  ));
  const truncatedSdat = Buffer.alloc(16, 0x80);

  // 1. Undo after shared water + individual water replacement must restore committed per-dataset
  // assignments without duplicate targets.
  await page.locator("#dataInput").setInputFiles([
    { name: "p18_ds1.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p18_ds1.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "p18_ds2.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p18_ds2.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await page.locator("#waterSection > summary").click();
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "w_shared.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w_shared.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("all 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("w_shared");

  // Replace dataset 0 individually via file picker.
  await page.locator("#waterAllToggle").uncheck();
  await page.locator("#waterInput").setInputFiles([
    { name: "w_indiv.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w_indiv.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("Water reference attached to the selected dataset", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("w_indiv");
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("w_shared");

  // Page-drop a different scan and click Undo: both datasets must return with their distinct references.
  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "p18_other.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p18_other.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#fileInfo")).toContainText("p18_other.sdat", { timeout: 30000 });
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#datasetSelect option")).toHaveCount(2);
  await expect(page.locator("#fileInfo")).toContainText("8 files");
  await page.locator("#datasetSelect").selectOption("0");
  await expect(page.locator("#waterInfo")).toContainText("w_indiv");
  await expect(page.locator("#waterScaling")).toBeEnabled();
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("w_shared");
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // Also check Undo directly after page-dropping an individual water replacement over shared water:
  // Undo must restore w_shared to BOTH datasets.
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "w_both.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "w_both.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("all 2 datasets", { timeout: 30000 });
  await page.locator("#waterAllToggle").uncheck();
  await page.locator("#datasetSelect").selectOption("0");
  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "w_drop_ind_ref.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "w_drop_ind_ref.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#waterInfo")).toContainText("w_drop_ind_ref", { timeout: 30000 });
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#waterInfo")).toContainText("w_both", { timeout: 30000 });
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("w_both");

  // 2. Attaching a water reference while an events.tsv read is in flight must NOT discard the
  // events schedule; once water attachment finishes, the schedule commits and Run is enabled.
  await page.locator("#dataInput").setInputFiles([
    { name: "p18_ev_scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p18_ev_scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("p18_ev_scan.sdat", { timeout: 30000 });
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.evaluate(() => {
    const origAB = File.prototype.arrayBuffer;
    const origText = File.prototype.text;
    window.__releaseP18Events = null;
    window.__releaseP18Water = null;
    window.__p18EventsStarted = new Promise((r) => { window.__markP18Events = r; });
    window.__p18WaterStarted = new Promise((r) => { window.__markP18Water = r; });
    File.prototype.text = function p18Text() {
      if (this.name === "p18_inflight.tsv") {
        window.__markP18Events?.();
        return new Promise((r) => { window.__releaseP18Events = () => r(origText.call(this)); });
      }
      return origText.call(this);
    };
    let pausedWater = false;
    File.prototype.arrayBuffer = function p18AB() {
      if (this.name === "p18_w_busy.sdat" && !pausedWater) {
        pausedWater = true;
        window.__markP18Water?.();
        return new Promise((r) => { window.__releaseP18Water = () => r(origAB.call(this)); });
      }
      return origAB.call(this);
    };
  });
  await page.locator("#eventsInput").setInputFiles({
    name: "p18_inflight.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tRest\n4\t4\tStim\n", "utf8"),
  });
  await page.evaluate(() => window.__p18EventsStarted);
  await page.locator("#waterInput").setInputFiles([
    { name: "p18_w_busy.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p18_w_busy.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await page.evaluate(() => window.__p18WaterStarted);
  // Release events while water import is still busy, then release water.
  await page.evaluate(() => window.__releaseP18Events?.());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__releaseP18Water?.());
  await expect(page.locator("#waterInfo")).toContainText("p18_w_busy", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("p18_inflight.tsv", { timeout: 15000 });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });

  // 3. Apply-to-all water reference must succeed after a partial spectrum import that included a
  // truncated/unreadable metabolite file, attaching to all valid datasets without aborting.
  await page.locator("#dataInput").setInputFiles([
    { name: "ok1.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "ok1.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "ok2.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "ok2.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
    { name: "broken.sdat", mimeType: "application/octet-stream", buffer: truncatedSdat },
    { name: "broken.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#datasetSelect option")).toHaveCount(2);
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles([
    { name: "p18_partial_w.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p18_partial_w.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#statusText")).toContainText("all 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("p18_partial_w");
  await expect(page.locator("#waterScaling")).toBeEnabled();
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("p18_partial_w");
  await expect(page.locator("#waterScaling")).toBeEnabled();
});

test("Pass 19: combined water+events drop updates schedule (and Undo restores it), and unreadable other-study DICOM does not block Apply-to-all", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#runButton")).toBeVisible();

  const sdatBytes = Array.from(Buffer.alloc(128 * 4 * 8, 0));
  for (let i = 0; i < 128 * 4 * 2; i += 1) {
    sdatBytes[i * 4] = 0x80;
    sdatBytes[i * 4 + 1] = 0x40;
  }
  const sparBytes = Array.from(Buffer.from(
    "samples : 128\nrows : 4\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  ));

  // 1. Load a spectrum + old_events.tsv, then page-drop [water_ref, new_events.tsv] together.
  await page.locator("#dataInput").setInputFiles([
    { name: "p19_scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p19_scan.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("p19_scan.sdat", { timeout: 30000 });
  await page.locator("#fmrsSection > summary").click();
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.locator("#eventsInput").setInputFiles({
    name: "old_sched.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tOldA\n4\t4\tOldB\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("OldA, OldB");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#waterSection > summary").click();
  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "p19_water_ref.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p19_water_ref.spar", { type: "text/plain" }));
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tNewX\n4\t4\tNewY\n"], "new_sched.tsv", { type: "text/tab-separated-values" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#waterInfo")).toContainText("p19_water_ref", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("new_sched.tsv");
  await expect(page.locator("#eventsInfo")).toContainText("NewX, NewY");
  await expect(page.locator("#eventsInfo")).not.toContainText("OldA");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Undo restores the pre-drop state (no water + old_sched.tsv).
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#eventsInfo")).toContainText("old_sched.tsv", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("OldA, OldB");
  await expect(page.locator("#waterScaling")).toBeDisabled();

  // Reverse-order combined drop [malformed_sched.tsv, water_ref] must NOT silently keep old_sched.tsv.
  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["not_a_valid_header\nfoo\n"], "bad_sched.tsv", { type: "text/tab-separated-values" }));
    dt.items.add(new File([new Uint8Array(sdat)], "p19_w2_ref.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p19_w2_ref.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#waterInfo")).toContainText("p19_w2_ref", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();

  // 2. Two valid Study A DICOM spectra + 1 unreadable Study B DICOM spectrum -> Apply-to-all with
  // a Study A DICOM water reference must succeed and attach to both valid datasets.
  const makeDicom = ({ study, patient, series, readable }) => {
    const chunks = [Buffer.alloc(128, 0), Buffer.from("DICM", "ascii")];
    const pushLo = (group, elem, text) => {
      let buf = Buffer.from(text, "ascii");
      if (buf.length % 2 !== 0) buf = Buffer.concat([buf, Buffer.from(" ")]);
      const hdr = Buffer.alloc(8);
      hdr.writeUInt16LE(group, 0);
      hdr.writeUInt16LE(elem, 2);
      hdr.write("LO", 4, "ascii");
      hdr.writeUInt16LE(buf.length, 6);
      chunks.push(hdr, buf);
    };
    pushLo(0x0020, 0x000d, study);
    pushLo(0x0010, 0x0020, patient);
    pushLo(0x0020, 0x000e, series);
    const fid = Buffer.alloc(64 * 8, 0);
    for (let k = 0; k < 64; k += 1) fid.writeFloatLE(1.0, k * 8);
    const ofHdr = Buffer.alloc(12);
    ofHdr.writeUInt16LE(0x5600, 0);
    ofHdr.writeUInt16LE(0x0020, 2);
    ofHdr.write("OF", 4, "ascii");
    ofHdr.writeUInt32LE(fid.length, 8);
    chunks.push(ofHdr, fid);
    if (readable) {
      let proto = Buffer.from(
        "### ASCCONV BEGIN ###\nlVectorSize = 64\nalDwellTime[0] = 500000\nlFrequency = 123250000\nflNominalB0 = 2.89\nalTE[0] = 30000\nalTR[0] = 2000000\ntSequenceFileName = \"svs_se\"\n### ASCCONV END ###\n",
        "ascii",
      );
      if (proto.length % 2 !== 0) proto = Buffer.concat([proto, Buffer.from(" ")]);
      const utHdr = Buffer.alloc(12);
      utHdr.writeUInt16LE(0x0029, 0);
      utHdr.writeUInt16LE(0x1010, 2);
      utHdr.write("UT", 4, "ascii");
      utHdr.writeUInt32LE(proto.length, 8);
      chunks.push(utHdr, proto);
    }
    return Buffer.concat(chunks);
  };
  await page.locator("#dataInput").setInputFiles([
    { name: "studyA_1.dcm", mimeType: "application/dicom", buffer: makeDicom({ study: "studyA", patient: "patA", series: "ser1", readable: true }) },
    { name: "studyA_2.dcm", mimeType: "application/dicom", buffer: makeDicom({ study: "studyA", patient: "patA", series: "ser2", readable: true }) },
    { name: "studyB_bad.dcm", mimeType: "application/dicom", buffer: makeDicom({ study: "studyB", patient: "patB", series: "ser3", readable: false }) },
  ]);
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#datasetSelect option")).toHaveCount(2);
  await page.locator("#waterAllToggle").check();
  await page.locator("#waterInput").setInputFiles({
    name: "studyA_water.dcm",
    mimeType: "application/dicom",
    buffer: makeDicom({ study: "studyA", patient: "patA", series: "serW", readable: true }),
  });
  await expect(page.locator("#statusText")).toContainText("all 2 datasets", { timeout: 30000 });
  await expect(page.locator("#waterInfo")).toContainText("studyA_water");
  await expect(page.locator("#waterScaling")).toBeEnabled();
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#waterInfo")).toContainText("studyA_water");
  await expect(page.locator("#waterScaling")).toBeEnabled();

  // 3. Pass 20 & 21: Dropping [new_events.tsv, ineligible single-average scan_b, t1_b] with
  // events FIRST, holding post-commit T1 rendering open across the Undo click, must restore
  // scan_a, old_events.tsv, AND Blocks mode with Run enabled as "Run fMRS analysis".
  await page.locator("#dataInput").setInputFiles([
    { name: "p20_scan_a.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p20_scan_a.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("p20_scan_a.sdat", { timeout: 30000 });
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.locator("#eventsInput").setInputFiles({
    name: "p20_old_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tKeepA\n4\t4\tKeepB\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("p20_old_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");

  const singleSdatBytes = Array.from(Buffer.alloc(128 * 1 * 8, 0));
  for (let i = 0; i < 128 * 1 * 2; i += 1) {
    singleSdatBytes[i * 4] = 0x80;
    singleSdatBytes[i * 4 + 1] = 0x40;
  }
  const singleSparBytes = Array.from(Buffer.from(
    "samples : 128\nrows : 1\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n",
    "utf8",
  ));
  const t1Bytes = Array.from(syntheticNifti({ dims: [8, 8, 8], gzip: false }));
  await page.evaluate(() => {
    const origPost = Worker.prototype.postMessage;
    let pausedRender = false;
    window.__releaseP20Render = null;
    window.__p20RenderStarted = new Promise((r) => { window.__markP20Render = r; });
    Worker.prototype.postMessage = function p20PostMessage(...args) {
      // Hold NiiVue's volume-loader worker message once #t1Info has been set inside commitT1,
      // deterministically keeping post-commit anatomy rendering busy across the Undo click.
      if (!pausedRender && document.getElementById("t1Info")?.textContent?.includes("p20_t1_b.nii")) {
        pausedRender = true;
        window.__releaseP20Render = () => origPost.apply(this, args);
        window.__markP20Render?.();
        return;
      }
      return origPost.apply(this, args);
    };
  });
  // Drop events FIRST, then ineligible single-average spectrum + T1; hold post-commit rendering
  // open through the Undo click so busy Undo is deterministically exercised!
  await page.evaluate(({ sdat, spar, t1 }) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["onset\tduration\ttrial_type\n0\t4\tNew1\n4\t4\tNew2\n"], "p20_new_events.tsv", { type: "text/tab-separated-values" }));
    dt.items.add(new File([new Uint8Array(sdat)], "p20_single_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p20_single_b.spar", { type: "text/plain" }));
    dt.items.add(new File([new Uint8Array(t1)], "p20_t1_b.nii", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: singleSdatBytes, spar: singleSparBytes, t1: t1Bytes });
  await page.evaluate(() => window.__p20RenderStarted);
  await expect(page.locator("#fileInfo")).toContainText("p20_single_b.sdat", { timeout: 30000 });
  await expect(page.locator("#t1Info")).toContainText("p20_t1_b.nii", { timeout: 30000 });
  await expect(page.locator("#fmrsMode")).toHaveValue("off");
  await expect(page.locator("#dataInput")).toBeDisabled();
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await page.evaluate(() => window.__releaseP20Render?.());
  await expect(page.locator("#fileInfo")).toContainText("p20_scan_a.sdat", { timeout: 30000 });
  await expect(page.locator("#eventsInfo")).toContainText("p20_old_events.tsv", { timeout: 15000 });
  await expect(page.locator("#eventsInfo")).toContainText("KeepA, KeepB");
  await expect(page.locator("#fmrsMode")).toHaveValue("blocks");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");

  // 4. Pass 22: Multi-dataset Undo with a non-first dataset selected (first dataset ineligible,
  // second dataset eligible in Blocks mode with a schedule) must restore the second dataset
  // selected BEFORE checking fMRS eligibility, keeping Blocks mode and "Run fMRS analysis".
  await page.locator("#dataInput").setInputFiles([
    { name: "p22_a_single.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(singleSdatBytes) },
    { name: "p22_a_single.spar", mimeType: "text/plain", buffer: Buffer.from(singleSparBytes) },
    { name: "p22_b_multi.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p22_b_multi.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#datasetSelect option")).toHaveCount(2);
  await page.locator("#datasetSelect").selectOption("1");
  await expect(page.locator("#fmrsSection")).toBeVisible();
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.locator("#eventsInput").setInputFiles({
    name: "p22_ds2_events.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tDs2Rest\n4\t4\tDs2Stim\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("p22_ds2_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");

  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "p22_repl.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p22_repl.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: singleSdatBytes, spar: singleSparBytes });
  await expect(page.locator("#fileInfo")).toContainText("p22_repl.sdat", { timeout: 30000 });
  await expect(page.locator("#fmrsMode")).toHaveValue("off");
  await expect(page.locator(".nd-status-undo")).toBeVisible();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#datasetField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#datasetSelect")).toHaveValue("1");
  await expect(page.locator("#fmrsMode")).toHaveValue("blocks");
  await expect(page.locator("#eventsInfo")).toContainText("p22_ds2_events.tsv");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");

  // 5. Pass 23: Undo must also restore the saved fMRS mode (including Off and Blocks) when an
  // eligible replacement was dropped and its mode was changed before clicking Undo.
  await page.locator("#dataInput").setInputFiles([
    { name: "p23_off_a.sdat", mimeType: "application/octet-stream", buffer: Buffer.from(sdatBytes) },
    { name: "p23_off_a.spar", mimeType: "text/plain", buffer: Buffer.from(sparBytes) },
  ]);
  await expect(page.locator("#fileInfo")).toContainText("p23_off_a.sdat", { timeout: 30000 });
  await page.locator("#fmrsMode").selectOption("off");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toHaveText("Preprocess and fit");

  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "p23_elig_b.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p23_elig_b.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#fileInfo")).toContainText("p23_elig_b.sdat", { timeout: 30000 });
  await page.locator("#fmrsMode").selectOption("blocks");
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("p23_off_a.sdat", { timeout: 30000 });
  await expect(page.locator("#fmrsMode")).toHaveValue("off");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#runButton")).toHaveText("Preprocess and fit");

  // Session originally in Blocks with schedule -> eligible replacement switched to Sliding -> Undo restores Blocks.
  await page.locator("#fmrsMode").selectOption("blocks");
  await page.locator("#eventsInput").setInputFiles({
    name: "p23_blocks.tsv",
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from("onset\tduration\ttrial_type\n0\t4\tBlkA\n4\t4\tBlkB\n", "utf8"),
  });
  await expect(page.locator("#eventsInfo")).toContainText("p23_blocks.tsv");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(({ sdat, spar }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(sdat)], "p23_elig_c.sdat", { type: "application/octet-stream" }));
    dt.items.add(new File([new Uint8Array(spar)], "p23_elig_c.spar", { type: "text/plain" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { sdat: sdatBytes, spar: sparBytes });
  await expect(page.locator("#fileInfo")).toContainText("p23_elig_c.sdat", { timeout: 30000 });
  await page.locator("#fmrsMode").selectOption("sliding");
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("p23_off_a.sdat", { timeout: 30000 });
  await expect(page.locator("#fmrsMode")).toHaveValue("blocks");
  await expect(page.locator("#eventsInfo")).toContainText("p23_blocks.tsv");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 15000 });
  await expect(page.locator("#runButton")).toHaveText("Run fMRS analysis");
});
