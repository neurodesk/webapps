import { clamp } from "./controls.js";

// Phone steering by tilting. Orientation angles are compared with a neutral
// pose captured when the run starts (or when the player taps to recentre), so
// any comfortable holding angle works. A small dead zone keeps a steady hand
// straight and full authority arrives at `range` degrees of tilt. Screen
// rotation is handled by mapping the device axes into the screen frame.
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
    // Roll (left/right) and lean (forward/back) in the screen frame.
    let roll, lean;
    if (angle === 90) {
      roll = beta;
      lean = -gamma;
    } else if (angle === 270 || angle === -90) {
      roll = -beta;
      lean = gamma;
    } else if (angle === 180) {
      roll = -gamma;
      lean = -beta;
    } else {
      roll = gamma;
      lean = beta;
    }
    if (!this.neutral) this.neutral = { roll, lean };
    const shape = (delta) => {
      const magnitude = Math.abs(delta);
      if (magnitude < this.dead) return 0;
      const scaled = Math.min(1, (magnitude - this.dead) / (this.range - this.dead));
      return Math.sign(delta) * scaled * scaled;
    };
    this.yaw = clamp(shape(roll - this.neutral.roll));
    // Leaning the top of the phone away pitches the nose down.
    this.pitch = clamp(shape(-(lean - this.neutral.lean)));
    return this;
  }
}
