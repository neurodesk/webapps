import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Race,
  pointsFor,
  readScores,
  saveScore,
  SCORE_KEY,
} from "../src/race.js";
import { humanChallenge } from "../src/navigation-map.js";
import { TRACKS, CHALLENGES, trackFor } from "../src/race.js";
import { network, volume } from "../test-fixtures/human.js";
import { insideMask } from "../src/mask.js";
import { swim } from "../src/swim.js";
test("active elapsed time counts slow frames and excludes pauses", () => {
  const race = new Race();
  race.resume(1000);
  race.tick(11000);
  race.pause(13000);
  race.tick(90000);
  assert.equal(race.seconds, 12);
  race.resume(100000);
  const result = race.finish(103000);
  assert.equal(result.seconds, 15);
  assert.equal(result.points, 5333);
  assert.equal(race.finish(200000), null);
});
test("a wall contact counts once until movement separates the player from it", () => {
  const race = new Race(0.1);
  race.resume(0);
  for (let i = 0; i < 100; i++) race.movement(0.05, 0);
  assert.equal(race.bumps, 1);
  race.movement(0, 0);
  race.pause(1000);
  race.resume(5000);
  race.movement(0.05, 0);
  assert.equal(race.bumps, 1);
  race.movement(0.05, 0.05);
  race.movement(0.05, 0.05);
  race.movement(0.05, 0);
  assert.equal(race.bumps, 2);
  assert.equal(pointsFor(15, 2), 5333 - 800, "speed score minus wall penalty");
  assert.equal(pointsFor(10, 0), 8000);
  assert.ok(pointsFor(10, 0) > pointsFor(20, 0), "faster runs earn more");
  assert.ok(pointsFor(20, 0) > pointsFor(20, 1), "every bump costs");
  assert.equal(pointsFor(999, 100), 0);
  assert.equal(pointsFor(10, 0, "pial-arteries-v2-sprint"), 3200, "track points scale the speed score");
  assert.equal(pointsFor(10, 0, "no-such-track"), 8000, "unknown tracks fall back to the standard points");
  for (const track of TRACKS)
    assert.ok(
      Math.abs(track.speedPoints / track.length - 80000 / 33.6) / (80000 / 33.6) < 0.02,
      `${track.name} pays about the same per millimetre`,
    );
});
test("completed scores persist, rank fairly, and keep only five valid results", () => {
  const data = new Map(),
    storage = {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
    };
  for (const seconds of [60, 50, 40, 30, 20, 10])
    saveScore(storage, { seconds, bumps: 0, points: pointsFor(seconds, 0) });
  assert.deepEqual(
    readScores(storage).map((r) => r.points),
    [8000, 4000, 2667, 2000, 1600],
  );
  data.set(SCORE_KEY, "not json");
  assert.deepEqual(readScores(storage), []);
  assert.equal(
    saveScore(
      {
        getItem() {
          throw Error();
        },
        setItem() {
          throw Error();
        },
      },
      { seconds: 10, bumps: 0, points: 8000 },
    ),
    false,
  );
});
test("each track keeps its own best runs on the device", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  saveScore(storage, { challenge: "pial-arteries-v2-sprint", seconds: 10, bumps: 0, points: pointsFor(10, 0, "pial-arteries-v2-sprint") });
  saveScore(storage, { seconds: 20, bumps: 0, points: pointsFor(20, 0) });
  assert.deepEqual(readScores(storage).map((r) => r.points), [4000]);
  assert.deepEqual(readScores(storage, "pial-arteries-v2-sprint").map((r) => r.points), [3200]);
  assert.deepEqual(readScores(storage, "pial-arteries-v3-tour"), []);
  assert.equal(new Race(0.1, "pial-arteries-v3-tour").challenge, "pial-arteries-v3-tour");
});
test("every track has a continuous in-vessel route of its declared length", () => {
  assert.equal(new Set(CHALLENGES).size, TRACKS.length, "challenge ids are unique");
  const ends = new Set();
  for (const track of TRACKS) {
    assert.equal(trackFor(track.challenge), track);
    assert.ok(track.minSeconds < track.length / 2.5, `${track.name} allows a flat-out run`);
    const a = humanChallenge(network, volume, track),
      b = humanChallenge(network, volume, track);
    assert.deepEqual(a.target.toArray(), b.target.toArray(), "deterministic");
    assert.ok(Math.abs(a.length - track.length) < 0.3, `${track.name}: ${a.length} mm vs ${track.length}`);
    assert.equal(a.directions.length, a.path.length);
    ends.add(a.path[0].toArray().join() + ">" + a.target.toArray().join());
    let along = 0;
    for (let i = 1; i < a.path.length; i++) {
      const step = a.path[i].distanceTo(a.path[i - 1]);
      assert.ok(step > 0.05 && step < 0.5, `${track.name} sample spacing ${step}`);
      assert.ok(a.directions[i - 1].dot(a.path[i].clone().sub(a.path[i - 1]).normalize()) > 0.99);
      along += step;
    }
    assert.ok(Math.abs(along - a.length) < 1, "samples cover the whole route");
    for (const p of a.path) assert.ok(insideMask(volume, p.toArray()));
    let position = a.path[0].clone();
    for (const next of a.path.slice(1))
      position = swim(volume, position, next.clone().sub(position));
    assert.ok(position.distanceTo(a.target) < 0.001, `${track.name} is flyable end to end`);
  }
  assert.equal(ends.size, TRACKS.length, "tracks are distinct");
});
