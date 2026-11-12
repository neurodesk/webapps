/**
 * The 3D tract preview's size limit.
 *
 * NiiVue draws each streamline point as a ring of 7 vertices: 196 bytes of
 * vertex buffer and 168 of index buffer per point, and about 0.9 kB of page
 * memory while it builds them. At one million points the vertex buffer stays
 * under WebGPU's default 256 MiB buffer limit and the build under 1 GB; the 33
 * million points of a full-size series at default settings need 6 GB for the
 * vertex buffer alone, which no browser allocates.
 */
export const PREVIEW_POINT_BUDGET = 1_000_000

/** Show every Nth streamline so the preview holds about `budget` points; 1 shows all. */
export function previewStride(points: number, budget = PREVIEW_POINT_BUDGET): number {
  return Math.max(1, Math.ceil(points / budget))
}
