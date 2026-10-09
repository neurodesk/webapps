// Pure mesh checks, unit-tested under Node (test/mesh.test.js).

/** Edge census + signed volume. Vertices are world mm (right-handed RAS), so a closed,
 *  consistently wound surface with outward normals has a positive signed volume.
 *  Edges are keyed numerically (min * n + max); n * n stays below 2^53 for any mesh
 *  a browser can hold, and there is no per-edge object or string. */
export function inspectMesh({ positions, indices }) {
  const n = positions.length / 3
  const count = new Map()
  const direction = new Map()
  let signedVolume = 0
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2]
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2]
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2]
    signedVolume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = from < to ? from * n + to : to * n + from
      count.set(key, (count.get(key) ?? 0) + 1)
      direction.set(key, (direction.get(key) ?? 0) + (from < to ? 1 : -1))
    }
  }
  let manifold = true, consistent = true
  for (const value of count.values()) if (value !== 2) { manifold = false; break }
  for (const value of direction.values()) if (value !== 0) { consistent = false; break }
  return { manifold, consistent, signedVolume: signedVolume / 6 }
}

export function flipWinding(indices) {
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = indices[i + 1]
    indices[i + 1] = indices[i + 2]
    indices[i + 2] = t
  }
  return indices
}
