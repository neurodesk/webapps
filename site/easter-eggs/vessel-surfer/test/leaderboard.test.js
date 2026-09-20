import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, createLeaderboard, formatTime } from "../src/leaderboard.js";
import { pointsFor } from "../src/race.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
  };
}
const result = { seconds: 12.5, bumps: 1, points: pointsFor(12.5, 1) };

test("names and times format consistently", () => {
  assert.equal(cleanName(" Ada \n Lovelace "), "Ada Lovelace");
  assert.equal(cleanName(""), "Anonymous");
  assert.equal(formatTime(72.34), "1:12.3");
});

test("reads and submits through the server when it is reachable", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const body =
      init.method === "POST"
        ? { rank: 3, scores: [{ ...JSON.parse(init.body), points: result.points }] }
        : { scores: [{ name: "Ada", points: 9700, seconds: 15, bumps: 0 }], total: 1 };
    return { ok: true, json: async () => body };
  };
  const storage = memoryStorage();
  const board = createLeaderboard({ url: "https://api.example/", storage, fetch });
  const top = await board.top(5);
  assert.equal(top.scope, "global");
  assert.equal(top.rows[0].name, "Ada");
  assert.equal(calls[0].url, "https://api.example/scores?challenge=pial-arteries-v2&limit=5");
  await board.top(3, "pial-arteries-v2-tour");
  assert.equal(calls[1].url, "https://api.example/scores?challenge=pial-arteries-v2-tour&limit=3");
  calls.length = 0;
  const saved = await board.submit(result, "  Grace  ");
  assert.equal(saved.scope, "global");
  assert.equal(saved.rank, 3);
  assert.equal(JSON.parse(calls[0].init.body).name, "Grace");
  assert.equal(board.name, "Grace");
  await assert.rejects(board.submit({ ...result, points: 1 }, "x"), /cannot be scored/);
  await assert.rejects(board.submit({ ...result, challenge: "no-such-track" }, "x"), /Unknown track/);
  const sprint = { challenge: "pial-arteries-v2-sprint", seconds: 6, bumps: 0, points: pointsFor(6, 0, "pial-arteries-v2-sprint") };
  await board.submit(sprint, "Grace");
  assert.equal(JSON.parse(calls.at(-1).init.body).challenge, "pial-arteries-v2-sprint");
});

test("falls back to this device's best runs when the server is unavailable", async () => {
  const storage = memoryStorage();
  const fetch = async () => {
    throw new Error("offline");
  };
  const board = createLeaderboard({ url: "https://api.example", storage, fetch });
  const empty = await board.top();
  assert.equal(empty.scope, "local");
  assert.deepEqual(empty.rows, []);
  const saved = await board.submit(result, "Grace");
  assert.equal(saved.scope, "local");
  assert.equal(saved.savedLocally, true);
  assert.equal(saved.error, "offline");
  assert.equal(saved.rows[0].points, result.points);
  assert.equal(saved.rows[0].name, "Grace");
  const failing = createLeaderboard({
    url: "https://api.example",
    storage,
    fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: "Too many runs" }) }),
  });
  assert.equal((await failing.submit(result, "Grace")).error, "Too many runs");
  const unconfigured = createLeaderboard({ url: "", storage, fetch });
  assert.equal((await unconfigured.top()).scope, "local");
});

test("Grand Tour completions persist on the server, including zero-point runs", async () => {
  const { handle, memoryStore } = await import("../../vessel-surfer-leaderboard/src/worker.js");
  const store = memoryStore();
  const board = createLeaderboard({
    url: "https://leaderboard.example",
    storage: memoryStorage(),
    fetch: (url, init) => handle(new Request(url, init), { store }),
  });
  const challenge = "pial-arteries-v2-tour";
  for (const bumps of [0, 4]) {
    const result = { challenge, seconds: 60, bumps, points: pointsFor(60, bumps, challenge) };
    const saved = await board.submit(result, `Pilot ${bumps}`);
    assert.equal(saved.scope, "global", saved.error);
  }
  const reloaded = await board.top(10, challenge);
  assert.equal(reloaded.total, 2);
  assert.deepEqual(reloaded.rows.map(({ points }) => points), [1600, 0]);
  assert.equal((await board.top(10, "pial-arteries-v2")).total, 0, "track boards stay separate");
});

test("a failed local write is not reported as a saved score", async () => {
  const board = createLeaderboard({
    url: "",
    storage: {
      getItem: () => null,
      setItem: () => { throw new Error("Storage unavailable"); },
    },
  });
  const saved = await board.submit(result, "Grace");
  assert.equal(saved.scope, "local");
  assert.equal(saved.savedLocally, false);
  assert.deepEqual(saved.rows, []);
});
