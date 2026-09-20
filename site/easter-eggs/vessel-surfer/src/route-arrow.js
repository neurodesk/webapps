import * as THREE from "three";

export function createRouteArrowGeometry() {
  // A flat chevron in the XZ plane pointing along +Z, lying
  // on the vessel wall with its face toward the lumen.
  const chevron = new THREE.Shape();
  chevron.moveTo(0, 0.55);
  chevron.lineTo(0.5, -0.15);
  chevron.lineTo(0.22, -0.15);
  chevron.lineTo(0, 0.12);
  chevron.lineTo(-0.22, -0.15);
  chevron.lineTo(-0.5, -0.15);
  chevron.closePath();
  const geometry = new THREE.ShapeGeometry(chevron);
  // Laying XY flat around -X maps the +Y tip to -Z and the face to +Y.
  // Turn it around in the wall plane to point +Z, preserving that face normal.
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI);
  return geometry;
}
