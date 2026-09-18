export const CHALLENGE = "ixi322-destination-v1";
export const SCORE_KEY = "vessel-surfer.scores.v1";
export function pointsFor(seconds, bumps) {
  return Math.max(0, 10000 - Math.ceil(seconds * 20) - bumps * 400);
}
export class Race {
  constructor(clearance = 0.1) {
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
      seconds: this.seconds,
      bumps: this.bumps,
      points: pointsFor(this.seconds, this.bumps),
      date: new Date().toISOString(),
    };
  }
}
export function readScores(storage) {
  try {
    const rows = JSON.parse(storage.getItem(SCORE_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (r) =>
          r.challenge === CHALLENGE &&
          Number.isFinite(r.seconds) &&
          r.seconds >= 0 &&
          Number.isInteger(r.bumps) &&
          r.bumps >= 0 &&
          r.points === pointsFor(r.seconds, r.bumps),
      )
      .sort((a, b) => b.points - a.points || a.seconds - b.seconds)
      .slice(0, 5);
  } catch {
    return [];
  }
}
export function saveScore(storage, result) {
  const rows = [...readScores(storage), { ...result, challenge: CHALLENGE }]
    .sort((a, b) => b.points - a.points || a.seconds - b.seconds)
    .slice(0, 5);
  try {
    storage.setItem(SCORE_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}
