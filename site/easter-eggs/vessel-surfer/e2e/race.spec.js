import { openGame } from "./open-game.js";
import { fixtureMask } from "./fixture-mask.js";
import { test, expect } from "@playwright/test";

const board = [
  { name: "Ada", points: 9800, seconds: 10, bumps: 0 },
  { name: "Grace", points: 9300, seconds: 15, bumps: 1 },
];

test("map follows the player, the timer pauses, and the global leaderboard renders", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  await page.route("**/scores*", async (route) => {
    requests.push(route.request());
    await route.fulfill({
      json: { challenge: "pial-arteries-v1", scores: board, total: 2 },
    });
  });
  await openGame(page);
  await expect(page.locator("#board-status")).toHaveText("Top 2 worldwide");
  await expect(page.locator("#score-rows tr")).toHaveCount(2);
  for (const text of ["Ada", "9,800", "0:10.0", "Grace"])
    await expect(page.locator("#score-rows")).toContainText(text);
  expect(requests[0].url()).toMatch(/\/scores\?challenge=pial-arteries-v2&limit=10$/);
  const target = await page.locator("#ocean").getAttribute("data-target");
  // Tracks: each has its own board; the choice is remembered and changes the route.
  await expect(page.locator("#tracks .track")).toHaveCount(4);
  await expect(page.locator("#board-title")).toHaveText("Trunk run leaderboard");
  await page.locator('#tracks .track[data-track="pial-arteries-v2-sprint"]').click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-track", "pial-arteries-v2-sprint");
  await expect(page.locator("#board-title")).toHaveText("Sprint leaderboard");
  await expect(page.locator("#mission-text")).toContainText("Sprint");
  await expect
    .poll(() => page.locator("#ocean").getAttribute("data-target"))
    .not.toBe(target);
  expect(requests.at(-1).url()).toMatch(/challenge=pial-arteries-v2-sprint&limit=10$/);
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled({ timeout: 60000 });
  await expect(page.locator("#ocean")).toHaveAttribute("data-track", "pial-arteries-v2-sprint");
  await page.locator('#tracks .track[data-track="pial-arteries-v2"]').click();
  await expect
    .poll(() => page.locator("#ocean").getAttribute("data-target"))
    .toBe(target);
  await page.locator("#play").click();
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#target-distance")).toContainText("away");
  await expect(page.locator("#ocean")).toHaveAttribute("data-map-zoom", "brain");
  await page.locator("#map-view").click();
  await expect(page.locator("#map-view")).toHaveText("Route · show whole brain");
  await expect(page.locator("#ocean")).toHaveAttribute("data-map-zoom", "route");
  await expect
    .poll(async () =>
      Number(await page.locator("#ocean").getAttribute("data-elapsed")),
    )
    .toBeGreaterThan(1);
  await page.locator("#quick-play").click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-state", "paused");
  const elapsed = await page.locator("#ocean").getAttribute("data-elapsed");
  await page.waitForTimeout(250);
  expect(await page.locator("#ocean").getAttribute("data-elapsed")).toBe(elapsed);
  await expect(page.locator("#map")).toBeVisible();
  await page.screenshot({ path: "/tmp/vessel-race-phone.png" });
  await page.locator("#menu-button").click();
  await expect(page.locator("#score")).toHaveText("0:00.0");
  await expect(page.locator("#bumps")).toHaveText("0 bumps");
  expect(await page.locator("#ocean").getAttribute("data-target")).toBe(target);
});

test("an unreachable leaderboard falls back to this device's best runs", async ({
  page,
}) => {
  await page.route("**/scores*", (route) => route.abort());
  await page.goto("/surf/");
  await page.evaluate(() =>
    localStorage.setItem(
      "vessel-surfer.scores.v2",
      JSON.stringify([
        {
          challenge: "pial-arteries-v2",
          name: "Me",
          seconds: 10,
          bumps: 0,
          points: 8000,
        },
      ]),
    ),
  );
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled({ timeout: 60000 });
  await expect(page.locator("#board-status")).toContainText("offline");
  await expect(page.locator("#score-rows")).toContainText("Me");
  await expect(page.locator("#score-rows")).toContainText("8,000");
});

// Keyboard autopilot: each tick holds the arrow keys for a share of the tick
// proportional to the demanded turn, which the steering ramp smooths.
async function steerWithKeys(page, yaw, pitch, tick = 60) {
  const held = [];
  if (Math.abs(yaw) > 0.08) held.push([yaw > 0 ? "ArrowRight" : "ArrowLeft", Math.abs(yaw)]);
  if (Math.abs(pitch) > 0.08) held.push([pitch > 0 ? "ArrowUp" : "ArrowDown", Math.abs(pitch)]);
  for (const [key] of held) await page.keyboard.down(key);
  const order = [...held].sort((a, b) => a[1] - b[1]);
  let elapsed = 0;
  for (const [key, share] of order) {
    const until = Math.min(1, share) * tick;
    if (until > elapsed) await page.waitForTimeout(until - elapsed);
    elapsed = Math.max(elapsed, until);
    await page.keyboard.up(key);
  }
  if (tick > elapsed) await page.waitForTimeout(tick - elapsed);
}

test("a practice run in an imported mask reaches its destination with the keyboard", async ({
  page,
}) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/scores*", (route) =>
    route.fulfill({ json: { scores: board, total: 2 } }),
  );
  await openGame(page);
  await page.getByText("Surf your own vessel mask", { exact: true }).click();
  await page.locator("#mask").setInputFiles({
    name: "race-tunnel.nii",
    mimeType: "application/octet-stream",
    buffer: fixtureMask(),
  });
  await expect(page.locator("#load-status")).toContainText("Loaded");
  await expect(page.locator("#mission-text")).toContainText("Practice run");
  await page.getByText("Controls", { exact: true }).click();
  await page.locator("#speed").fill("3");
  await page.locator("#play").click();
  await expect(page.locator("#ocean")).toHaveAttribute("data-state", "running");
  // A tiny autopilot: hold the arrow keys in proportion to the angle between
  // the heading and the destination.
  const ocean = page.locator("#ocean");
  for (let i = 0; i < 1200; i++) {
    const data = await ocean.evaluate((el) => ({ ...el.dataset }));
    if (data.state === "complete") break;
    const p = JSON.parse(data.position);
    const h = JSON.parse(data.heading);
    const t = JSON.parse(data.target);
    const d = t.map((v, k) => v - p[k]);
    const length = Math.hypot(...d) || 1;
    const desired = d.map((v) => v / length);
    // The camera frame: looking along +z with +y up, "right" is -x.
    const right = [-h[2], 0, h[0]];
    const rightLength = Math.hypot(...right) || 1;
    right.forEach((v, k) => (right[k] = v / rightLength));
    const up = [
      right[1] * h[2] - right[2] * h[1],
      right[2] * h[0] - right[0] * h[2],
      right[0] * h[1] - right[1] * h[0],
    ];
    const dotWith = (a) => a.reduce((sum, v, k) => sum + v * desired[k], 0);
    let yaw = dotWith(right);
    const pitch = dotWith(up);
    if (dotWith(h) < 0 && Math.abs(yaw) < 0.3) yaw = 1;
    await steerWithKeys(page, yaw, pitch);
  }
  await expect(ocean).toHaveAttribute("data-state", "complete");
  await expect(page.locator("#run-result")).toContainText("Practice complete");
  await expect(page.locator("#submit-form")).toBeHidden();
  await expect(page.locator("#score-rows")).toContainText("Ada");
  await page.screenshot({ path: "/tmp/vessel-race-finish.png" });
  await page.locator("#play").click();
  await expect(ocean).toHaveAttribute("data-state", "running");
  await expect(page.locator("#score")).not.toHaveText("0:00.0");
});

test("the brain challenge can be completed and saved to the global leaderboard", async ({
  page,
}) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const posted = [];
  await page.route("**/scores*", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const entry = request.postDataJSON();
      posted.push(entry);
      const points = Math.max(
        0,
        Math.round(80000 / Math.max(1, entry.seconds)) - entry.bumps * 400,
      );
      await route.fulfill({
        status: 201,
        json: { rank: 1, scores: [{ ...entry, points }, ...board] },
      });
    } else await route.fulfill({ json: { scores: board, total: 2 } });
  });
  await openGame(page);
  await page.getByText("Controls", { exact: true }).click();
  await page.locator("#speed").fill("3");
  await page.locator("#play").click();
  const ocean = page.locator("#ocean");
  await expect(ocean).toHaveAttribute("data-state", "running");
  // Pure pursuit along the validated reference route with the arrow keys.
  const dist = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
  for (let i = 0; i < 4000; i++) {
    const data = await ocean.evaluate((el) => ({ ...el.dataset }));
    if (data.state === "complete") break;
    const p = JSON.parse(data.position);
    const h = JSON.parse(data.heading);
    const up = JSON.parse(data.up);
    const path = JSON.parse(data.path);
    let nearest = 0;
    path.forEach((q, k) => {
      if (dist(q, p) < dist(path[nearest], p)) nearest = k;
    });
    let waypoint = JSON.parse(data.target);
    for (let k = nearest; k < path.length; k++)
      if (dist(path[k], p) > 1.2) {
        waypoint = path[k];
        break;
      }
    const length = dist(waypoint, p) || 1;
    const desired = waypoint.map((v, k) => (v - p[k]) / length);
    const right = [
      h[1] * up[2] - h[2] * up[1],
      h[2] * up[0] - h[0] * up[2],
      h[0] * up[1] - h[1] * up[0],
    ];
    const dotWith = (a) => a.reduce((sum, v, k) => sum + v * desired[k], 0);
    let yaw = dotWith(right);
    let pitch = dotWith(up);
    if (dotWith(h) < 0) {
      yaw = Math.sign(yaw) || 1;
      pitch = Math.sign(pitch);
    }
    // Pinned on a wall: let go so the lumen assist finds the opening.
    if (data.blocked === "true") yaw = pitch = 0;
    await steerWithKeys(page, yaw, pitch);
  }
  await expect(ocean).toHaveAttribute("data-state", "complete");
  await expect(page.locator("#run-result")).toContainText("points");
  await expect(page.locator("#run-breakdown")).toContainText("Speed score");
  await expect(page.locator("#run-breakdown")).toContainText("Wall penalty");
  await expect(page.locator("#submit-form")).toBeVisible();
  await page.locator("#player-name").fill("  Test Pilot  ");
  await page.locator("#submit").click();
  await expect(page.locator("#submit-status")).toHaveText(
    "Saved. You are #1 in the world.",
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    challenge: "pial-arteries-v2",
    name: "Test Pilot",
    bumps: Number(await ocean.getAttribute("data-bumps")),
  });
  expect(posted[0].seconds).toBeCloseTo(
    Number(await ocean.getAttribute("data-elapsed")),
    2,
  );
  await expect(page.locator("#score-rows tr.is-you")).toContainText("Test Pilot");
  await expect(page.locator("#submit")).toBeDisabled();
  await page.screenshot({ path: "/tmp/vessel-race-brain-finish.png" });
  await page.reload();
  await expect(page.locator("#play")).toBeEnabled({ timeout: 60000 });
  expect(await page.evaluate(() => localStorage.getItem("vessel-surfer.name.v1"))).toBe(
    "Test Pilot",
  );
});
