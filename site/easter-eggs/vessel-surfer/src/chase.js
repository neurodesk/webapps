import * as THREE from "three";
import { sampleMask, insideMask } from "./mask.js";

export function clearSight(volume, from, to, margin = 0.53) {
  const steps = Math.max(
    1,
    Math.ceil(from.distanceTo(to) / (Math.min(...volume.scale) * 0.15)),
  );
  const p = new THREE.Vector3();
  for (let i = 0; i <= steps; i++)
    if (
      sampleMask(
        volume,
        p
          .copy(from)
          .lerp(to, i / steps)
          .toArray(),
      ) <= margin
    )
      return false;
  return volume.surfaceClear ? volume.surfaceClear(from, to) : true;
}
export function lumenRadius(volume, position) {
  const unit = Math.min(...volume.scale);
  let radius = unit * 4;
  for (const axis of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ])
    for (const sign of [-1, 1]) {
      for (let d = unit * 0.1; d <= radius; d += unit * 0.1) {
        if (
          sampleMask(
            volume,
            position
              .clone()
              .addScaledVector(axis, d * sign)
              .toArray(),
          ) <= 0.53
        ) {
          radius = Math.min(radius, Math.max(unit * 0.08, d - unit * 0.1));
          break;
        }
      }
    }
  return radius;
}
// The eye is the navigation point itself. No offsets, wall clipping or cutaways.
// Only orientation is smoothed, and only when that orientation has a clear view.
export class TunnelCamera {
  constructor() {
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
  }
  update(position, ahead, volume, dt, snap = false) {
    if (!insideMask(volume, position.toArray()))
      throw new Error("Camera route left the vessel lumen.");
    this.position.copy(position);
    const desired = ahead.clone().sub(position);
    const distance = desired.length();
    if (distance < 1e-6) return this;
    desired.normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(
      this.heading,
      desired,
    );
    rotation.slerp(new THREE.Quaternion(), snap ? 0 : Math.exp(-dt * 8));
    const candidate = this.heading
      .clone()
      .applyQuaternion(rotation)
      .normalize();
    const candidateTarget = position
      .clone()
      .addScaledVector(candidate, distance);
    this.heading.copy(
      clearSight(volume, position, candidateTarget) ? candidate : desired,
    );
    this.up.addScaledVector(this.heading, -this.up.dot(this.heading));
    if (this.up.lengthSq() < 0.01) {
      this.up.set(0, 1, 0).addScaledVector(this.heading, -this.heading.y);
      if (this.up.lengthSq() < 0.01)
        this.up.set(0, 0, 1).addScaledVector(this.heading, -this.heading.z);
    }
    this.up.normalize();
    this.target.copy(position).addScaledVector(this.heading, distance);
    return this;
  }
}
