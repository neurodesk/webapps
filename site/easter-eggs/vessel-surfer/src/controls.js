export const clamp = (value, low = -1, high = 1) =>
  Math.min(high, Math.max(low, value));

// Map a pointer offset in pixels to a steering demand in [-1, 1] per axis.
// A dead zone keeps a resting pointer straight and a squared curve gives fine
// control near the centre with full authority at the rim.
export function aimFromOffset(dx, dy, radius, dead = 0.08) {
  const x = dx / radius;
  const y = -dy / radius;
  const magnitude = Math.hypot(x, y);
  if (magnitude < dead || !(radius > 0)) return { yaw: 0, pitch: 0 };
  const scaled = Math.min(1, (magnitude - dead) / (1 - dead));
  const curve = scaled * scaled;
  return { yaw: (x / magnitude) * curve, pitch: (y / magnitude) * curve };
}

// Turn rates ramp toward the demanded value instead of switching on and off,
// so a tap nudges the heading and a hold sweeps it.
export class Steering {
  constructor({ maxRate = 1.7, response = 12 } = {}) {
    this.maxRate = maxRate;
    this.response = response;
    this.yawRate = 0;
    this.pitchRate = 0;
  }
  update(yaw, pitch, dt) {
    const blend = 1 - Math.exp(-dt * this.response);
    this.yawRate += (clamp(yaw) * this.maxRate - this.yawRate) * blend;
    this.pitchRate += (clamp(pitch) * this.maxRate - this.pitchRate) * blend;
    return { yaw: this.yawRate * dt, pitch: this.pitchRate * dt };
  }
  reset() {
    this.yawRate = 0;
    this.pitchRate = 0;
  }
}

// Combine player demand with the lumen assist. The assist only fills the
// authority the player is not using and never pushes against the direction
// the player is already steering, so deliberate steering always wins.
// Inputs below `threshold` are treated as no input, so a pointer resting just
// outside the dead zone cannot veto the assist while the nose is on a wall.
export function combineDemand(player, assist, strength, threshold = 0.05) {
  const yaw = clamp(player.yaw);
  const pitch = clamp(player.pitch);
  const authority = Math.max(0, 1 - Math.min(1, Math.hypot(yaw, pitch)));
  const agree = (input, help) =>
    Math.abs(input) >= threshold && input * help < 0 ? 0 : help;
  return {
    yaw: clamp(yaw + agree(yaw, assist.yaw) * strength * authority),
    pitch: clamp(pitch + agree(pitch, assist.pitch) * strength * authority),
  };
}

// A one-shot half turn. The heading sweeps exactly 180 degrees at a steady
// rate toward the more open side of the vessel, so reversing direction is a
// single key or button instead of timing a spin with the pointer at the rim.
export class UTurn {
  constructor(rate = 3) {
    this.rate = rate;
    this.remaining = 0;
    this.side = 1;
  }
  get active() {
    return this.remaining > 0;
  }
  begin(side = 1) {
    if (this.active) return false;
    this.remaining = Math.PI;
    this.side = side < 0 ? -1 : 1;
    return true;
  }
  cancel() {
    this.remaining = 0;
  }
  // The yaw step for this frame in radians; positive turns right.
  update(dt) {
    if (!this.active) return 0;
    const step = Math.min(this.remaining, this.rate * Math.max(0, dt));
    this.remaining -= step;
    return step * this.side;
  }
}
