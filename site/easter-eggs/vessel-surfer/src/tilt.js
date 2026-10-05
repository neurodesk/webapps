import { clamp } from "./controls.js";

// Phone steering by tilting. Orientation angles are compared with a neutral
// pose captured when the run starts (or when the player taps to recentre), so
// any comfortable holding angle works. A small dead zone keeps a steady hand
// straight and full authority arrives at `range` degrees of tilt.
//
// Beta and gamma are Euler angles: gamma only measures a sideways tilt while
// the phone lies flat, swings ever harder for the same twist as the phone is
// raised, and jumps by 180 degrees when a landscape phone passes vertical.
// Steering therefore reads the up vector in the screen frame instead: roll is
// how far it leans sideways, lean is its angle about the screen's x axis.
export class Tilt {
  constructor({ dead = 3, range = 22 } = {}) {
    this.dead = dead;
    this.range = range;
    this.neutral = null;
    this.yaw = 0;
    this.pitch = 0;
    this.samples = 0;
  }
  reset() {
    this.neutral = null;
    this.yaw = this.pitch = 0;
  }
  // `angle` is screen.orientation.angle: 0 portrait, 90 or 270 landscape.
  update({ beta, gamma }, angle = 0) {
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return this;
    this.samples++;
    const rad = Math.PI / 180;
    const b = beta * rad;
    const g = gamma * rad;
    // World up in the device frame (W3C ZXY Euler order).
    const ux = -Math.cos(b) * Math.sin(g);
    const uy = Math.sin(b);
    const uz = Math.cos(b) * Math.cos(g);
    // Into the screen frame; at 90 the device top points to screen left.
    const a = angle * rad;
    const sx = ux * Math.cos(a) - uy * Math.sin(a);
    const sy = ux * Math.sin(a) + uy * Math.cos(a);
    const roll = Math.asin(clamp(-sx)) / rad;
    const lean = Math.atan2(sy, uz) / rad;
    if (!this.neutral) this.neutral = { roll, lean };
    const shape = (delta) => {
      const magnitude = Math.abs(delta);
      if (magnitude < this.dead) return 0;
      const scaled = Math.min(1, (magnitude - this.dead) / (this.range - this.dead));
      return Math.sign(delta) * scaled * scaled;
    };
    this.yaw = clamp(shape(roll - this.neutral.roll));
    // Lean grows as the top of the phone rises toward you, so tipping the top
    // away pitches the nose down and tipping it back pitches up.
    this.pitch = clamp(shape(((lean - this.neutral.lean + 540) % 360) - 180));
    return this;
  }
}
