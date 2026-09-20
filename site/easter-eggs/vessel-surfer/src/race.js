// Tracks are fixed routes through the pial artery graph. Each is its own
// leaderboard challenge. `start` names where the route begins: the launch
// point on the widest trunk with a direction, or a leaf node of the graph;
// the route then follows the longest simple path using only branches whose
// lumen stays at least `floor` millimetres wide (see navigation-map.js).
// `length` is the resolved route length, checked by the unit tests, and
// `speedPoints` scales the speed score so a given average speed earns about
// the same on every track (80,000 per 33.6 mm).
export const TRACKS = [
  {
    challenge: "pial-arteries-v2",
    name: "Trunk run",
    blurb: "The main arterial trunk, one sweeping bend. The standard race.",
    start: { edge: "launch", direction: "longest" },
    floor: 0.15,
    length: 33.6,
    speedPoints: 80000,
    minSeconds: 8,
  },
  {
    challenge: "pial-arteries-v2-sprint",
    name: "Sprint",
    blurb: "Short and wide. Go flat out.",
    start: { edge: "launch", direction: "shortest" },
    floor: 0.15,
    length: 13.5,
    speedPoints: 32000,
    minSeconds: 4,
  },
  {
    challenge: "pial-arteries-v2-tour",
    name: "Grand tour",
    blurb: "From a far branch tip across the whole trunk. The longest wide route.",
    start: { node: 144 },
    floor: 0.15,
    length: 40.4,
    speedPoints: 96000,
    minSeconds: 10,
  },
  {
    challenge: "pial-arteries-v2-narrows",
    name: "Narrows",
    blurb: "The longest route through branches barely wider than the sub. Expert.",
    start: { node: 384 },
    floor: 0.1,
    length: 50.0,
    speedPoints: 119000,
    minSeconds: 12,
  },
];
export const CHALLENGE = TRACKS[0].challenge;
export const CHALLENGES = TRACKS.map((track) => track.challenge);
export const SCORE_KEY = "vessel-surfer.scores.v2";
export function trackFor(challenge = CHALLENGE) {
  return TRACKS.find((track) => track.challenge === challenge) || null;
}
// Points reward speed and punish wall contact separately so the trade-off is
// visible: a faster run earns more, every bump costs a fixed amount, and the
// leaderboard server recomputes both from the submitted time and bump count.
export const SPEED_POINTS = TRACKS[0].speedPoints;
export const BUMP_PENALTY = 400;
export function speedScore(seconds, challenge = CHALLENGE) {
  const points = trackFor(challenge)?.speedPoints ?? SPEED_POINTS;
  return Math.round(points / Math.max(1, seconds));
}
export function bumpPenalty(bumps) {
  return bumps * BUMP_PENALTY;
}
export function pointsFor(seconds, bumps, challenge = CHALLENGE) {
  return Math.max(0, speedScore(seconds, challenge) - bumpPenalty(bumps));
}
export class Race {
  constructor(clearance = 0.1, challenge = CHALLENGE) {
    this.challenge = challenge;
    this.seconds = 0;
    this.bumps = 0;
    this.since = null;
    this.finished = false;
    this.contact = false;
    this.clearTravel = 0;
    this.clearance = clearance;
  }
  resume(now) {
    if (!this.finished && this.since === null) this.since = now;
  }
  tick(now) {
    if (this.since !== null) {
      this.seconds += Math.max(0, now - this.since) / 1000;
      this.since = now;
    }
  }
  pause(now) {
    this.tick(now);
    this.since = null;
  }
  movement(attempted, moved) {
    if (this.finished || this.since === null || attempted < 1e-7) return;
    if (moved < attempted - 1e-5) {
      if (!this.contact) this.bumps++;
      this.contact = true;
      this.clearTravel = 0;
    } else {
      this.clearTravel += moved;
      if (this.clearTravel >= this.clearance) this.contact = false;
    }
  }
  finish(now) {
    if (this.finished) return null;
    this.pause(now);
    this.finished = true;
    return {
      challenge: this.challenge,
      seconds: this.seconds,
      bumps: this.bumps,
      points: pointsFor(this.seconds, this.bumps, this.challenge),
      date: new Date().toISOString(),
    };
  }
}
// This device's best five runs per track, kept for when the server is away.
function validScores(storage) {
  try {
    const rows = JSON.parse(storage.getItem(SCORE_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (r) =>
        CHALLENGES.includes(r.challenge) &&
        Number.isFinite(r.seconds) &&
        r.seconds >= 0 &&
        Number.isInteger(r.bumps) &&
        r.bumps >= 0 &&
        r.points === pointsFor(r.seconds, r.bumps, r.challenge),
    );
  } catch {
    return [];
  }
}
const byPoints = (a, b) => b.points - a.points || a.seconds - b.seconds;
export function readScores(storage, challenge = CHALLENGE) {
  return validScores(storage)
    .filter((r) => r.challenge === challenge)
    .sort(byPoints)
    .slice(0, 5);
}
export function saveScore(storage, result) {
  const challenge = result.challenge || CHALLENGE;
  const mine = [...readScores(storage, challenge), { ...result, challenge }]
    .sort(byPoints)
    .slice(0, 5);
  const rows = [
    ...validScores(storage).filter((r) => r.challenge !== challenge),
    ...mine,
  ];
  try {
    storage.setItem(SCORE_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}
