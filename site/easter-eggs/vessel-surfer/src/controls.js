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
  constructor({ maxRate = 2.4, response = 12 } = {}) {
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
export function combineDemand(player, assist, strength) {
  const yaw = clamp(player.yaw);
  const pitch = clamp(player.pitch);
  const authority = Math.max(0, 1 - Math.min(1, Math.hypot(yaw, pitch)));
  const agree = (input, help) => (input * help < 0 ? 0 : help);
  return {
    yaw: clamp(yaw + agree(yaw, assist.yaw) * strength * authority),
    pitch: clamp(pitch + agree(pitch, assist.pitch) * strength * authority),
  };
}
