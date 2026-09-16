// A software demonstration, not a simulated patient or model-validation case.
// Idealized tissue compartments use spoiled gradient-echo T1 signal. Three
// cylindrical zero-signal inclusions have a smooth surrounding signal loss.
// The surrounding loss illustrates susceptibility blooming; it is not a field
// simulation and does not model gold's susceptibility or acquisition readout.
export const SYNTHETIC_MARKERS = [
  { center: [-9, -4, -7], axis: [0, 0, 1] },
  { center: [8, -3, 6], axis: [0.6, 0, 0.8] },
  { center: [0, 8, -1], axis: [0, 0.6, 0.8] },
];

function signal(t1, density) {
  const recovery = Math.exp(-7 / t1);
  const angle = 15 * Math.PI / 180;
  return 12000 * density * (1 - recovery) * Math.sin(angle) / (1 - recovery * Math.cos(angle));
}

export function createProstateSignalVoidPhantom() {
  const dims = [96, 96, 64];
  const spacing = 0.75;
  const origin = dims.map(size => -(size - 1) * spacing / 2);
  const image = new Float32Array(dims[0] * dims[1] * dims[2]);
  const muscle = signal(950, 0.85);
  const fat = signal(350, 0.9);
  const peripheral = signal(1400, 1);
  const central = signal(1100, 0.9);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        const px = origin[0] + x * spacing;
        const py = origin[1] + y * spacing;
        const pz = origin[2] + z * spacing;
        const body = (px / 34) ** 2 + (py / 33) ** 2;
        const gland = (px / 19) ** 2 + (py / 15) ** 2 + (pz / 18) ** 2;
        const inner = (px / 11) ** 2 + (py / 9) ** 2 + (pz / 12) ** 2;
        let value = body > 1 ? 0 : muscle;
        if (body > 0.72 && body <= 1) value = fat;
        if (gland <= 1) value = inner <= 1 ? central : peripheral;
        for (const { center, axis } of SYNTHETIC_MARKERS) {
          const relative = [px - center[0], py - center[1], pz - center[2]];
          const axial = relative.reduce((sum, coordinate, i) => sum + coordinate * axis[i], 0);
          const radial2 = relative.reduce((sum, coordinate) => sum + coordinate ** 2, 0) - axial ** 2;
          const beyondEnd = Math.max(0, Math.abs(axial) - 1.5);
          const core = radial2 <= 0.5 ** 2 && Math.abs(axial) <= 1.5;
          value *= core ? 0.015 : 1 - 0.95 * Math.exp(-radial2 / 1.2 ** 2 - beyondEnd ** 2 / 1.2 ** 2);
        }
        // Fixed, low-amplitude texture keeps repeated selections identical.
        const texture = 1 + 0.025 * Math.sin(x * 1.7 + y * 2.3 + z * 0.9);
        image[x + dims[0] * (y + dims[1] * z)] = value * texture;
      }
    }
  }
  return {
    dims,
    img: image,
    hdr: {
      pixDims: [1, spacing, spacing, spacing, 1, 1, 1, 1],
      affine: [
        [spacing, 0, 0, origin[0]],
        [0, spacing, 0, origin[1]],
        [0, 0, spacing, origin[2]],
        [0, 0, 0, 1],
      ],
    },
  };
}
