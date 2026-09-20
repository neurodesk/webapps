import * as THREE from "three";
import { lumenRadius } from "./chase.js";
import { Steering, UTurn, combineDemand } from "./controls.js";
import { assistDemand, probeLumen, throttle } from "./assist.js";
import { level, steer, swim } from "./swim.js";

// Shared by the animation loop and deterministic movement replays.
export class Flight {
  constructor() {
    this.steering = new Steering();
    this.uturn = new UTurn();
    this.uturnAxis = new THREE.Vector3();
    this.blocked = false;
    this.stalledFor = 0;
    this.anchor = null;
    this.escape = null;
  }
  reset() {
    this.steering.reset();
    this.uturn.cancel();
    this.blocked = false;
    this.stalledFor = 0;
    this.anchor = null;
    this.escape = null;
  }
  step(volume, player, direction, swimUp, {
    dt,
    cruise = 0.5,
    rate = 6,
    braking = false,
    reversing = false,
    playerDemand = { yaw: 0, pitch: 0 },
    turnRequest = false,
  }) {
    const unit = Math.min(...volume.scale);
    const radius = lumenRadius(volume, player);
    const probe = probeLumen(
      volume,
      player,
      direction,
      swimUp,
      Math.max(unit * 4, radius * 6),
    );
    if (turnRequest) {
      // Turn toward whichever side has more room.
      if (this.uturn.begin(probe.left > probe.right ? -1 : 1)) {
        this.steering.reset();
        // Sweep about the up axis as it is now, so the turn ends facing
        // exactly backwards even from a pitched or rolled heading.
        this.uturnAxis.copy(swimUp);
      }
    }
    const turning = this.uturn.active;
    const manual = braking || reversing || turning ||
      Math.hypot(playerDemand.yaw, playerDemand.pitch) >= 0.25;
    if (!this.anchor || manual || player.distanceTo(this.anchor) > unit * 0.15) {
      this.anchor = player.clone();
      this.stalledFor = 0;
    } else {
      this.stalledFor += dt;
    }
    if (manual) this.escape = null;
    if (!manual && !this.escape && this.stalledFor >= 2) {
      this.escape = escapeRoute(volume, player, direction, probe.reach);
      this.stalledFor = 0;
      this.steering.reset();
    }
    const recovering = this.escape !== null;
    let turn;
    if (recovering) {
      // Keep one escape direction until clear of the wall. Re-selecting every
      // frame can alternate between equally open directions and never turn.
      const angle = direction.angleTo(this.escape.direction);
      const rotation = new THREE.Quaternion().setFromUnitVectors(direction, this.escape.direction);
      rotation.slerp(new THREE.Quaternion(), angle > 0 ? 1 - Math.min(1, 1.7 * dt / angle) : 0);
      direction.applyQuaternion(rotation).normalize();
      swimUp.applyQuaternion(rotation).normalize();
      turn = { yaw: 0, pitch: 0 };
    } else if (turning) turn = { yaw: this.uturn.update(dt), pitch: 0 };
    else {
      // Pinned on a wall (stopped by the throttle or blocked last frame),
      // the assist looks further round (60 degrees) and steers toward the
      // open side with full strength; only a deliberate input overrides it.
      const pinned = this.blocked || throttle(probe) === 0;
      const assist =
        braking || reversing
          ? { yaw: 0, pitch: 0 }
          : assistDemand(
              pinned
                ? probeLumen(volume, player, direction, swimUp, probe.reach, 1.05)
                : probe,
            );
      const demand = pinned
        ? combineDemand(playerDemand, assist, 1, 0.25)
        : combineDemand(playerDemand, assist, 0.6);
      turn = this.steering.update(demand.yaw, demand.pitch, dt);
    }
    if (turning) {
      direction.applyAxisAngle(this.uturnAxis, -turn.yaw).normalize();
      swimUp.copy(this.uturnAxis);
    } else {
      steer(direction, swimUp, turn.yaw, turn.pitch);
      level(direction, swimUp, dt);
    }
    // Cruise at six voxels per second so thin, high-resolution vessels are
    // as navigable as coarse ones.
    let speed = cruise * unit * rate;
    if (reversing) speed *= -0.7;
    else if (recovering) {
      speed *= direction.dot(this.escape.direction) > 0.995 ? 0.3 : 0;
    } else speed *= throttle(probe);
    if (braking || turning) speed = 0;
    const next = swim(
      volume,
      player,
      direction.clone().multiplyScalar(dt * speed),
    );
    const moved = player.distanceTo(next);
    player.copy(next);
    if (recovering) {
      this.escape.remaining -= moved;
      if (this.escape.remaining <= 0 || (speed > 0 && moved < speed * dt * 0.1)) {
        this.escape = null;
        this.anchor = player.clone();
        this.stalledFor = 0;
      }
    }
    this.blocked = !braking && !turning && (
      recovering ||
      (!reversing && throttle(probe) === 0) ||
      (Math.abs(speed) > 0 && moved < Math.abs(speed * dt) * 0.1)
    );
    return { moved, speed, radius, turning, recovering, blocked: this.blocked };
  }
}

// Score swept, eye-clearance-safe movement, not just centre rays. Include the
// rear hemisphere: the way out of an end wall may be behind the swimmer.
function escapeRoute(volume, position, heading, reach) {
  const unit = Math.min(...volume.scale);
  let best = null;
  let bestScore = 0;
  const directions = [heading.clone().negate()];
  for (let i = 0; i < 64; i++) {
    const y = 1 - 2 * (i + 0.5) / 64;
    const radius = Math.sqrt(1 - y * y);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    directions.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }
  for (const direction of directions) {
    const destination = swim(volume, position, direction.clone().multiplyScalar(reach));
    const distance = destination.distanceTo(position);
    const score = distance * (1 + 0.05 * direction.dot(heading));
    if (distance > unit * 0.2 && score > bestScore) {
      bestScore = score;
      best = { direction, remaining: Math.min(unit * 2, distance * 0.5) };
    }
  }
  return best;
}
