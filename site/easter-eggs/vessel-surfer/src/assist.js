import * as THREE from "three";
import { sampleMask } from "./mask.js";

// Free travel along a ray before the vessel wall, in world units.
export function freeDistance(volume, from, direction, max) {
  if (volume.surfaceDistance)
    return volume.surfaceDistance(from, direction, max);
  const step = Math.min(...volume.scale) * 0.25;
  const point = new THREE.Vector3();
  for (let d = step; d <= max; d += step) {
    point.copy(from).addScaledVector(direction, d);
    if (sampleMask(volume, point.toArray()) <= 0.53) return d - step;
  }
  return max;
}

// Probe a cone around the heading: straight ahead and about 30 degrees to each
// side and up and down in the camera frame.
export function probeLumen(volume, position, heading, up, reach) {
  const right = heading.clone().cross(up).normalize();
  const spread = Math.tan(0.52);
  const ray = (h, v) =>
    heading
      .clone()
      .addScaledVector(right, spread * h)
      .addScaledVector(up, spread * v)
      .normalize();
  return {
    reach,
    ahead: freeDistance(volume, position, heading, reach),
    left: freeDistance(volume, position, ray(-1, 0), reach),
    right: freeDistance(volume, position, ray(1, 0), reach),
    up: freeDistance(volume, position, ray(0, 1), reach),
    down: freeDistance(volume, position, ray(0, -1), reach),
  };
}

// Steering demand toward the more open side of the lumen. Positive yaw turns
// right and positive pitch turns up, matching the player controls.
export function assistDemand(probe) {
  const yaw = (probe.right - probe.left) / probe.reach;
  const pitch = (probe.up - probe.down) / probe.reach;
  return {
    yaw: Math.min(1, Math.max(-1, yaw * 1.5)),
    pitch: Math.min(1, Math.max(-1, pitch * 1.5)),
  };
}

// Ease off when the wall ahead is close so there is time to take the bend, and
// stop altogether once the nose is on the wall: grinding into it only pins the
// eye against the surface, so turning away is free instead.
export function throttle(probe) {
  if (probe.ahead <= probe.reach * 0.06) return 0;
  return Math.min(1, Math.max(0.3, probe.ahead / (probe.reach * 0.45)));
}
