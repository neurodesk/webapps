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
  assert.equal(result.points, 9700);
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
  assert.equal(pointsFor(15, 2), 8900);
  assert.equal(pointsFor(999, 100), 0);
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
    [9800, 9600, 9400, 9200, 9000],
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
      { seconds: 10, bumps: 0, points: 9800 },
    ),
    false,
  );
});
test("the fixed real-brain destination has a continuous in-vessel reference route", () => {
  const a = humanChallenge(network),
    b = humanChallenge(network);
  assert.deepEqual(a.target.toArray(), b.target.toArray());
  assert.ok(a.target.distanceTo(a.path[0]) > 2);
  for (const p of a.path) assert.ok(insideMask(volume, p.toArray()));
  let position = a.path[0].clone();
  for (const next of a.path.slice(1))
    position = swim(volume, position, next.clone().sub(position));
  assert.ok(position.distanceTo(a.target) < 0.001);
});
