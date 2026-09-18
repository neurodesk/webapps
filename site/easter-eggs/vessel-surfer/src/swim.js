import * as THREE from "three";
import { clearSight } from "./chase.js";
import { insideMask } from "./mask.js";

// Rotate in the screen's transported frame: no world-axis yaw or polar lock.
export function steer(heading, up, horizontal, vertical) {
  heading.applyAxisAngle(up, -horizontal);
  const right = heading.clone().cross(up).normalize();
  heading.applyAxisAngle(right, vertical).normalize();
  up.copy(right).cross(heading).normalize();
}

// Gently roll the camera back toward world-up so the map and the view agree.
// Near-vertical headings are left alone because "up" is ambiguous there.
export function level(heading, up, dt, rate = 1.2) {
  const world = new THREE.Vector3(0, 1, 0);
  const desired = world.addScaledVector(heading, -heading.y);
  if (desired.lengthSq() < 0.15) return up;
  desired.normalize();
  const right = heading.clone().cross(up).normalize();
  const angle = Math.atan2(desired.dot(right), desired.dot(up));
  const step = Math.sign(angle) * Math.min(Math.abs(angle), rate * dt);
  up.applyAxisAngle(heading, step).normalize();
  return up;
}

// Swept movement prevents tunnelling even at low frame rates. A small six-axis
// clearance keeps the eye away from the wall, and binary search permits safe
// partial movement instead of alternating between a whole step and a stop.
export function swim(volume, position, displacement) {
  if (displacement.lengthSq() < 1e-16) return position.clone();
  const radius = Math.min(...volume.scale) * 0.1;
  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  const safe = (p) =>
    insideMask(volume, p.toArray()) &&
    clearSight(volume, position, p, 0.54) &&
    axes.every((axis) =>
      [-1, 1].every((sign) =>
        clearSight(
          volume,
          p,
          p.clone().addScaledVector(axis, radius * sign),
          0.53,
        ),
      ),
    );
  const target = position.clone().add(displacement);
  if (safe(target)) return target;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (safe(position.clone().addScaledVector(displacement, mid))) lo = mid;
    else hi = mid;
  }
  return position.clone().addScaledVector(displacement, lo);
}
