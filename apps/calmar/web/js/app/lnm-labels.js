const YEO7_LABELS = [
  { index: 0, name: 'Background', color: '#000000', alpha: 0 },
  { index: 1, name: 'Visual', color: '#781286', alpha: 255 },
  { index: 2, name: 'Somatomotor', color: '#4682b4', alpha: 255 },
  { index: 3, name: 'DorsalAttention', color: '#00760e', alpha: 255 },
  { index: 4, name: 'VentralAttention', color: '#c43afa', alpha: 255 },
  { index: 5, name: 'Limbic', color: '#dcf8a4', alpha: 255 },
  { index: 6, name: 'Frontoparietal', color: '#e69422', alpha: 255 },
  { index: 7, name: 'Default', color: '#cd3e4e', alpha: 255 }
];

function hexToRgb(hex) {
  const raw = hex.replace('#', '');
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16)
  ];
}

export const YEO7_COLORMAP = {
  R: YEO7_LABELS.map(label => hexToRgb(label.color)[0]),
  G: YEO7_LABELS.map(label => hexToRgb(label.color)[1]),
  B: YEO7_LABELS.map(label => hexToRgb(label.color)[2]),
  A: YEO7_LABELS.map(label => label.alpha),
  I: YEO7_LABELS.map(label => label.index),
  labels: YEO7_LABELS.map(label => label.name)
};

const LESION_MASK_LABELS = [
  { index: 0, name: 'Background', color: '#000000', alpha: 0 },
  { index: 1, name: 'Lesion mask', color: '#008cff', alpha: 255 }
];

export const LESION_MASK_COLORMAP_ID = 'lnm-lesion-blue';

export const LESION_MASK_COLORMAP = {
  R: LESION_MASK_LABELS.map(label => hexToRgb(label.color)[0]),
  G: LESION_MASK_LABELS.map(label => hexToRgb(label.color)[1]),
  B: LESION_MASK_LABELS.map(label => hexToRgb(label.color)[2]),
  A: LESION_MASK_LABELS.map(label => label.alpha),
  I: LESION_MASK_LABELS.map(label => label.index),
  labels: LESION_MASK_LABELS.map(label => label.name)
};

export const YEO7_NETWORK_LABELS = Object.fromEntries(
  YEO7_LABELS
    .filter(label => label.index > 0)
    .map(label => [label.index, label.name])
);

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

function buildSchaeferColormap() {
  const labels = ['Background'];
  const R = [0], G = [0], B = [0], A = [0], I = [0];
  for (let label = 1; label <= 400; label++) {
    const hue = (label * 137.508) % 360;
    const [r, g, b] = hsvToRgb(hue, 0.62, 0.88);
    labels.push(`Parcel ${label}`);
    R.push(r);
    G.push(g);
    B.push(b);
    A.push(255);
    I.push(label);
  }
  return { R, G, B, A, I, labels };
}

export const SCHAEFER400_COLORMAP = buildSchaeferColormap();
