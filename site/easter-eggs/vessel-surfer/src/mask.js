export function sampleMask(mask, point) {
  const shape = mask.shape || [mask.n, mask.n, mask.n];
  const origin = mask.origin || mask.scale.map((v) => (-mask.n / 2) * v);
  const c = point.map((v, i) => (v - origin[i]) / mask.scale[i]);
  const low = c.map(Math.floor),
    fraction = c.map((v, i) => v - low[i]);
  if (low.some((v, i) => v < 0 || v + 1 >= shape[i])) return 0;
  let value = 0;
  for (let z = 0; z <= 1; z++)
    for (let y = 0; y <= 1; y++)
      for (let x = 0; x <= 1; x++) {
        const weight =
          (x ? fraction[0] : 1 - fraction[0]) *
          (y ? fraction[1] : 1 - fraction[1]) *
          (z ? fraction[2] : 1 - fraction[2]);
        value +=
          weight *
          mask.field[
            low[0] + x + shape[0] * (low[1] + y + shape[1] * (low[2] + z))
          ];
      }
  return value / (mask.valueScale || 1);
}
export function insideMask(mask, point) {
  return (
    sampleMask(mask, point) > 0.53 &&
    (!mask.surfaceInside || mask.surfaceInside(point))
  );
}
