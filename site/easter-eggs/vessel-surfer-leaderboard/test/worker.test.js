import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBMISSIONS_PER_HOUR,
  cleanName,
  handle,
  memoryStore,
  validateEntry,
} from "../src/worker.js";
import { CHALLENGE, TRACKS, pointsFor } from "../../vessel-surfer/src/race.js";

const origin = "https://webapps.neurodesk.org";
const options = (store, extra = {}) => ({
  store,
  allowedOrigins: [origin],
  now: () => new Date("2026-09-18T10:00:00Z"),
  ipHash: "abc",
  ...extra,
});
const post = (body, headers = { origin }) =>
  new Request("https://api.example/scores", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const run = (name, seconds, bumps = 0) => ({ challenge: CHALLENGE, name, seconds, bumps });

test("names are printable, trimmed and bounded", () => {
  assert.equal(cleanName("  Ada\u0000  Lovelace  "), "Ada Lovelace");
  assert.equal(cleanName(""), "Anonymous");
  assert.equal(cleanName("x".repeat(40)).length, 16);
});

test("entries are validated and points are recomputed on the server", () => {
  const entry = validateEntry({ ...run("Ada", 12.3456, 1), points: 99999 });
  assert.equal(entry.points, pointsFor(12.346, 1));
  assert.equal(entry.seconds, 12.346);
  for (const bad of [
    null,
    { challenge: "other", seconds: 10, bumps: 0 },
    { challenge: CHALLENGE, seconds: 1, bumps: 0 },
    { challenge: CHALLENGE, seconds: "10", bumps: 0 },
    { challenge: CHALLENGE, seconds: 10, bumps: 1.5 },
    { challenge: CHALLENGE, seconds: 10, bumps: -1 },
    { challenge: "pial-arteries-v3-tour", seconds: 9, bumps: 0 },
  ])
    assert.throws(() => validateEntry(bad), /./, JSON.stringify(bad));
  for (const track of TRACKS) {
    const entry = validateEntry({ challenge: track.challenge, name: "T", seconds: 30, bumps: 1 });
    assert.equal(entry.points, pointsFor(30, 1, track.challenge), track.name);
  }
  assert.equal(validateEntry(run("Zero", 600, 1)).points, 0);
  const sprint = validateEntry({ challenge: "pial-arteries-v2-sprint", name: "S", seconds: 5, bumps: 0 });
  assert.equal(sprint.points, 6400, "a short track accepts short times and scales its points");
});

test("saving a run returns its world rank and the top ten", async () => {
  const store = memoryStore();
  for (const [name, seconds] of [["A", 20], ["B", 10], ["C", 15]]) {
    const response = await handle(post(run(name, seconds)), options(store));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  const response = await handle(post(run("D", 12)), options(store));
  const body = await response.json();
  assert.equal(body.rank, 2);
  assert.deepEqual(body.scores.map((row) => row.name), ["B", "D", "C", "A"]);
  const list = await handle(
    new Request(`https://api.example/scores?challenge=${CHALLENGE}&limit=2`, { headers: { origin } }),
    options(store),
  );
  const listed = await list.json();
  assert.equal(listed.total, 4);
  assert.deepEqual(listed.scores.map((row) => row.points), [8000, 6667]);
  assert.equal(list.headers.get("cache-control"), "no-store");
});

test("ties rank by faster time, and equal runs share a rank", async () => {
  const store = memoryStore();
  await handle(post(run("A", 10)), options(store));
  const same = await (await handle(post(run("B", 10)), options(store))).json();
  assert.equal(same.rank, 1);
  const slower = await (await handle(post(run("C", 10.02)), options(store))).json();
  assert.equal(slower.rank, 3);
});

test("rejects bad bodies, foreign origins, unknown paths and excessive submissions", async () => {
  const store = memoryStore();
  assert.equal((await handle(post("not json"), options(store))).status, 400);
  assert.equal((await handle(post(run("A", 10), { origin: "https://evil.example" }), options(store))).status, 403);
  assert.equal((await handle(post("x".repeat(3000)), options(store))).status, 413);
  assert.equal((await handle(new Request("https://api.example/other"), options(store))).status, 404);
  assert.equal((await handle(new Request("https://api.example/scores", { method: "DELETE" }), options(store))).status, 405);
  const preflight = await handle(
    new Request("https://api.example/scores", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:4178" } }),
    options(store),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:4178");
  for (let i = 0; i < SUBMISSIONS_PER_HOUR; i++)
    assert.equal((await handle(post(run("A", 10)), options(store))).status, 201);
  assert.equal((await handle(post(run("A", 10)), options(store))).status, 429);
  assert.equal((await handle(post(run("A", 10)), options(store, { ipHash: "other" }))).status, 201);
  const later = options(store, { now: () => new Date("2026-09-18T11:30:00Z") });
  assert.equal((await handle(post(run("A", 10)), later)).status, 201);
});
