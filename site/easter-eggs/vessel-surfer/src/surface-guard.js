import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

// Check the rendered triangles as well as the source field. Marching cubes is a
// planar approximation and can obstruct rays that pass a trilinear-only test.
export function surfaceGuard(geometry, inwardNormals = false) {
  const bvh = new MeshBVH(geometry, { indirect: true });
  const ray = new THREE.Ray();
  return {
    bvh,
    ...(inwardNormals
      ? {
          surfaceInside(point) {
            // Nearest-face normals are ambiguous at concave triangle edges.
            // Count crossings of the closed segmentation surface instead.
            const probe = new THREE.Ray(
              new THREE.Vector3(...point),
              new THREE.Vector3(0.81317, 0.37191, 0.44723).normalize(),
            );
            const hits = bvh
              .raycast(probe, THREE.DoubleSide)
              .sort((a, b) => a.distance - b.distance);
            let crossings = 0,
              previous = -Infinity;
            for (const hit of hits) {
              if (hit.distance - previous > 1e-6) crossings++;
              previous = hit.distance;
            }
            return crossings % 2 === 1;
          },
        }
      : {}),
    surfaceDistance(from, direction, max) {
      ray.origin.copy(from);
      ray.direction.copy(direction);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, max);
      return hit ? hit.distance : max;
    },
    surfaceClear(from, to) {
      const distance = from.distanceTo(to);
      if (distance < 1e-7) return true;
      ray.origin.copy(from);
      ray.direction
        .copy(to)
        .sub(from)
        .multiplyScalar(1 / distance);
      return (
        bvh.raycastFirst(
          ray,
          THREE.DoubleSide,
          0,
          Math.max(0, distance - 1e-6),
        ) === null
      );
    },
  };
}
