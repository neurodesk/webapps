/**
 * MuscleMap label definitions.
 *
 * Per-model label arrays keyed by ONNX filename.
 * Wholebody uses sparse anatomical values; regional models use sequential values.
 */

// ==================== Wholebody Labels (99 muscles) ====================

export const LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1101, region: 'neck', name: 'Levator Scapulae L', color: null },
  { index: 2, value: 1102, region: 'neck', name: 'Levator Scapulae R', color: null },
  { index: 3, value: 1111, region: 'neck', name: 'Semispinalis Cervicis & Multifidus L', color: null },
  { index: 4, value: 1112, region: 'neck', name: 'Semispinalis Cervicis & Multifidus R', color: null },
  { index: 5, value: 1121, region: 'neck', name: 'Semispinalis Capitis L', color: null },
  { index: 6, value: 1122, region: 'neck', name: 'Semispinalis Capitis R', color: null },
  { index: 7, value: 1131, region: 'neck', name: 'Splenius Capitis L', color: null },
  { index: 8, value: 1132, region: 'neck', name: 'Splenius Capitis R', color: null },
  { index: 9, value: 1141, region: 'neck', name: 'Sternocleidomastoid L', color: null },
  { index: 10, value: 1142, region: 'neck', name: 'Sternocleidomastoid R', color: null },
  { index: 11, value: 1151, region: 'neck', name: 'Longus Colli L', color: null },
  { index: 12, value: 1152, region: 'neck', name: 'Longus Colli R', color: null },
  { index: 13, value: 1161, region: 'neck', name: 'Trapezius L', color: null },
  { index: 14, value: 1162, region: 'neck', name: 'Trapezius R', color: null },
  { index: 15, value: 2101, region: 'shoulder', name: 'Supraspinatus L', color: null },
  { index: 16, value: 2102, region: 'shoulder', name: 'Supraspinatus R', color: null },
  { index: 17, value: 2111, region: 'shoulder', name: 'Subscapularis L', color: null },
  { index: 18, value: 2112, region: 'shoulder', name: 'Subscapularis R', color: null },
  { index: 19, value: 2121, region: 'shoulder', name: 'Infraspinatus L', color: null },
  { index: 20, value: 2122, region: 'shoulder', name: 'Infraspinatus R', color: null },
  { index: 21, value: 2141, region: 'shoulder', name: 'Deltoid L', color: null },
  { index: 22, value: 2142, region: 'shoulder', name: 'Deltoid R', color: null },
  { index: 23, value: 4101, region: 'thorax', name: 'Rhomboid L', color: null },
  { index: 24, value: 4102, region: 'thorax', name: 'Rhomboid R', color: null },
  { index: 25, value: 5101, region: 'abdomen', name: 'Thoracolumbar Multifidus L', color: null },
  { index: 26, value: 5102, region: 'abdomen', name: 'Thoracolumbar Multifidus R', color: null },
  { index: 27, value: 5111, region: 'abdomen', name: 'Erector Spinae L', color: null },
  { index: 28, value: 5112, region: 'abdomen', name: 'Erector Spinae R', color: null },
  { index: 29, value: 5121, region: 'abdomen', name: 'Psoas Major L', color: null },
  { index: 30, value: 5122, region: 'abdomen', name: 'Psoas Major R', color: null },
  { index: 31, value: 5131, region: 'abdomen', name: 'Quadratus Lumborum L', color: null },
  { index: 32, value: 5132, region: 'abdomen', name: 'Quadratus Lumborum R', color: null },
  { index: 33, value: 5141, region: 'abdomen', name: 'Latissimus Dorsi L', color: null },
  { index: 34, value: 5142, region: 'abdomen', name: 'Latissimus Dorsi R', color: null },
  { index: 35, value: 6101, region: 'pelvis', name: 'Gluteus Minimus L', color: null },
  { index: 36, value: 6102, region: 'pelvis', name: 'Gluteus Minimus R', color: null },
  { index: 37, value: 6111, region: 'pelvis', name: 'Gluteus Medius L', color: null },
  { index: 38, value: 6112, region: 'pelvis', name: 'Gluteus Medius R', color: null },
  { index: 39, value: 6121, region: 'pelvis', name: 'Gluteus Maximus L', color: null },
  { index: 40, value: 6122, region: 'pelvis', name: 'Gluteus Maximus R', color: null },
  { index: 41, value: 6131, region: 'pelvis', name: 'Tensor Fascia Latae L', color: null },
  { index: 42, value: 6132, region: 'pelvis', name: 'Tensor Fascia Latae R', color: null },
  { index: 43, value: 6141, region: 'pelvis', name: 'Iliacus L', color: null },
  { index: 44, value: 6142, region: 'pelvis', name: 'Iliacus R', color: null },
  { index: 45, value: 6151, region: 'pelvis', name: 'Ilium L', color: null },
  { index: 46, value: 6152, region: 'pelvis', name: 'Ilium R', color: null },
  { index: 47, value: 6160, region: 'pelvis', name: 'Sacrum', color: null },
  { index: 48, value: 6171, region: 'pelvis', name: 'Femur L', color: null },
  { index: 49, value: 6172, region: 'pelvis', name: 'Femur R', color: null },
  { index: 50, value: 6181, region: 'pelvis', name: 'Piriformis L', color: null },
  { index: 51, value: 6182, region: 'pelvis', name: 'Piriformis R', color: null },
  { index: 52, value: 6191, region: 'pelvis', name: 'Pectineus L', color: null },
  { index: 53, value: 6192, region: 'pelvis', name: 'Pectineus R', color: null },
  { index: 54, value: 6201, region: 'pelvis', name: 'Obturator Internus L', color: null },
  { index: 55, value: 6202, region: 'pelvis', name: 'Obturator Internus R', color: null },
  { index: 56, value: 6211, region: 'pelvis', name: 'Obturator Externus L', color: null },
  { index: 57, value: 6212, region: 'pelvis', name: 'Obturator Externus R', color: null },
  { index: 58, value: 6221, region: 'pelvis', name: 'Gemelli & Quadratus Femoris L', color: null },
  { index: 59, value: 6222, region: 'pelvis', name: 'Gemelli & Quadratus Femoris R', color: null },
  { index: 60, value: 7101, region: 'thigh', name: 'Vastus Lateralis L', color: null },
  { index: 61, value: 7102, region: 'thigh', name: 'Vastus Lateralis R', color: null },
  { index: 62, value: 7111, region: 'thigh', name: 'Vastus Intermedius L', color: null },
  { index: 63, value: 7112, region: 'thigh', name: 'Vastus Intermedius R', color: null },
  { index: 64, value: 7121, region: 'thigh', name: 'Vastus Medialis L', color: null },
  { index: 65, value: 7122, region: 'thigh', name: 'Vastus Medialis R', color: null },
  { index: 66, value: 7131, region: 'thigh', name: 'Rectus Femoris L', color: null },
  { index: 67, value: 7132, region: 'thigh', name: 'Rectus Femoris R', color: null },
  { index: 68, value: 7141, region: 'thigh', name: 'Sartorius L', color: null },
  { index: 69, value: 7142, region: 'thigh', name: 'Sartorius R', color: null },
  { index: 70, value: 7151, region: 'thigh', name: 'Gracilis L', color: null },
  { index: 71, value: 7152, region: 'thigh', name: 'Gracilis R', color: null },
  { index: 72, value: 7161, region: 'thigh', name: 'Semimembranosus L', color: null },
  { index: 73, value: 7162, region: 'thigh', name: 'Semimembranosus R', color: null },
  { index: 74, value: 7171, region: 'thigh', name: 'Semitendinosus L', color: null },
  { index: 75, value: 7172, region: 'thigh', name: 'Semitendinosus R', color: null },
  { index: 76, value: 7181, region: 'thigh', name: 'Biceps Femoris Long Head L', color: null },
  { index: 77, value: 7182, region: 'thigh', name: 'Biceps Femoris Long Head R', color: null },
  { index: 78, value: 7191, region: 'thigh', name: 'Biceps Femoris Short Head L', color: null },
  { index: 79, value: 7192, region: 'thigh', name: 'Biceps Femoris Short Head R', color: null },
  { index: 80, value: 7201, region: 'thigh', name: 'Adductor Magnus L', color: null },
  { index: 81, value: 7202, region: 'thigh', name: 'Adductor Magnus R', color: null },
  { index: 82, value: 7211, region: 'thigh', name: 'Adductor Longus L', color: null },
  { index: 83, value: 7212, region: 'thigh', name: 'Adductor Longus R', color: null },
  { index: 84, value: 7221, region: 'thigh', name: 'Adductor Brevis L', color: null },
  { index: 85, value: 7222, region: 'thigh', name: 'Adductor Brevis R', color: null },
  { index: 86, value: 8101, region: 'leg', name: 'Anterior Compartment L', color: null },
  { index: 87, value: 8102, region: 'leg', name: 'Anterior Compartment R', color: null },
  { index: 88, value: 8111, region: 'leg', name: 'Deep Posterior Compartment L', color: null },
  { index: 89, value: 8112, region: 'leg', name: 'Deep Posterior Compartment R', color: null },
  { index: 90, value: 8121, region: 'leg', name: 'Lateral Compartment L', color: null },
  { index: 91, value: 8122, region: 'leg', name: 'Lateral Compartment R', color: null },
  { index: 92, value: 8131, region: 'leg', name: 'Soleus L', color: null },
  { index: 93, value: 8132, region: 'leg', name: 'Soleus R', color: null },
  { index: 94, value: 8141, region: 'leg', name: 'Gastrocnemius L', color: null },
  { index: 95, value: 8142, region: 'leg', name: 'Gastrocnemius R', color: null },
  { index: 96, value: 8151, region: 'leg', name: 'Tibia L', color: null },
  { index: 97, value: 8152, region: 'leg', name: 'Tibia R', color: null },
  { index: 98, value: 8161, region: 'leg', name: 'Fibula L', color: null },
  { index: 99, value: 8162, region: 'leg', name: 'Fibula R', color: null },
];

// ==================== Regional Model Labels ====================

const ABDOMEN_LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1, region: 'abdomen', name: 'Multifidus R', color: null },
  { index: 2, value: 2, region: 'abdomen', name: 'Multifidus L', color: null },
  { index: 3, value: 3, region: 'abdomen', name: 'Erector Spinae R', color: null },
  { index: 4, value: 4, region: 'abdomen', name: 'Erector Spinae L', color: null },
  { index: 5, value: 5, region: 'abdomen', name: 'Psoas Major R', color: null },
  { index: 6, value: 6, region: 'abdomen', name: 'Psoas Major L', color: null },
  { index: 7, value: 7, region: 'abdomen', name: 'Quadratus Lumborum R', color: null },
  { index: 8, value: 8, region: 'abdomen', name: 'Quadratus Lumborum L', color: null },
];

const FOREARM_LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1, region: 'forearm', name: 'Other Muscles', color: null },
  { index: 2, value: 2, region: 'forearm', name: 'Radius', color: null },
  { index: 3, value: 3, region: 'forearm', name: 'Ulna', color: null },
  { index: 4, value: 4, region: 'forearm', name: 'Extensor Compartment', color: null },
  { index: 5, value: 5, region: 'forearm', name: 'Flexor Compartment', color: null },
];

const LEG_LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1, region: 'leg', name: 'Anterior Compartment L', color: null },
  { index: 2, value: 2, region: 'leg', name: 'Anterior Compartment R', color: null },
  { index: 3, value: 3, region: 'leg', name: 'Deep Posterior Compartment L', color: null },
  { index: 4, value: 4, region: 'leg', name: 'Deep Posterior Compartment R', color: null },
  { index: 5, value: 5, region: 'leg', name: 'Lateral Compartment L', color: null },
  { index: 6, value: 6, region: 'leg', name: 'Lateral Compartment R', color: null },
  { index: 7, value: 7, region: 'leg', name: 'Soleus L', color: null },
  { index: 8, value: 8, region: 'leg', name: 'Soleus R', color: null },
  { index: 9, value: 9, region: 'leg', name: 'Gastrocnemius L', color: null },
  { index: 10, value: 10, region: 'leg', name: 'Gastrocnemius R', color: null },
  { index: 11, value: 11, region: 'leg', name: 'Tibia L', color: null },
  { index: 12, value: 12, region: 'leg', name: 'Tibia R', color: null },
  { index: 13, value: 13, region: 'leg', name: 'Fibula L', color: null },
  { index: 14, value: 14, region: 'leg', name: 'Fibula R', color: null },
];

const PELVIS_LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1, region: 'pelvis', name: 'Gluteus Minimus L', color: null },
  { index: 2, value: 2, region: 'pelvis', name: 'Gluteus Minimus R', color: null },
  { index: 3, value: 3, region: 'pelvis', name: 'Gluteus Medius L', color: null },
  { index: 4, value: 4, region: 'pelvis', name: 'Gluteus Medius R', color: null },
  { index: 5, value: 5, region: 'pelvis', name: 'Gluteus Maximus L', color: null },
  { index: 6, value: 6, region: 'pelvis', name: 'Gluteus Maximus R', color: null },
  { index: 7, value: 7, region: 'pelvis', name: 'Tensor Fasciae Latae L', color: null },
  { index: 8, value: 8, region: 'pelvis', name: 'Tensor Fasciae Latae R', color: null },
  { index: 9, value: 9, region: 'pelvis', name: 'Femur L', color: null },
  { index: 10, value: 10, region: 'pelvis', name: 'Femur R', color: null },
  { index: 11, value: 11, region: 'pelvis', name: 'Pelvic Girdle L', color: null },
  { index: 12, value: 12, region: 'pelvis', name: 'Pelvic Girdle R', color: null },
  { index: 13, value: 13, region: 'pelvis', name: 'Sacrum', color: null },
];

const THIGH_LABELS = [
  { index: 0, value: 0, region: '', name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, value: 1, region: 'thigh', name: 'Vastus Lateralis L', color: null },
  { index: 2, value: 2, region: 'thigh', name: 'Vastus Lateralis R', color: null },
  { index: 3, value: 3, region: 'thigh', name: 'Vastus Intermedius L', color: null },
  { index: 4, value: 4, region: 'thigh', name: 'Vastus Intermedius R', color: null },
  { index: 5, value: 5, region: 'thigh', name: 'Vastus Medialis L', color: null },
  { index: 6, value: 6, region: 'thigh', name: 'Vastus Medialis R', color: null },
  { index: 7, value: 7, region: 'thigh', name: 'Rectus Femoris L', color: null },
  { index: 8, value: 8, region: 'thigh', name: 'Rectus Femoris R', color: null },
  { index: 9, value: 9, region: 'thigh', name: 'Sartorius L', color: null },
  { index: 10, value: 10, region: 'thigh', name: 'Sartorius R', color: null },
  { index: 11, value: 11, region: 'thigh', name: 'Gracilis L', color: null },
  { index: 12, value: 12, region: 'thigh', name: 'Gracilis R', color: null },
  { index: 13, value: 13, region: 'thigh', name: 'Semimembranosus L', color: null },
  { index: 14, value: 14, region: 'thigh', name: 'Semimembranosus R', color: null },
  { index: 15, value: 15, region: 'thigh', name: 'Semitendinosus L', color: null },
  { index: 16, value: 16, region: 'thigh', name: 'Semitendinosus R', color: null },
  { index: 17, value: 17, region: 'thigh', name: 'Biceps Femoris Long Head L', color: null },
  { index: 18, value: 18, region: 'thigh', name: 'Biceps Femoris Long Head R', color: null },
  { index: 19, value: 19, region: 'thigh', name: 'Biceps Femoris Short Head L', color: null },
  { index: 20, value: 20, region: 'thigh', name: 'Biceps Femoris Short Head R', color: null },
  { index: 21, value: 21, region: 'thigh', name: 'Adductor Magnus L', color: null },
  { index: 22, value: 22, region: 'thigh', name: 'Adductor Magnus R', color: null },
  { index: 23, value: 23, region: 'thigh', name: 'Adductor Longus L', color: null },
  { index: 24, value: 24, region: 'thigh', name: 'Adductor Longus R', color: null },
  { index: 25, value: 25, region: 'thigh', name: 'Adductor Brevis L', color: null },
  { index: 26, value: 26, region: 'thigh', name: 'Adductor Brevis R', color: null },
  { index: 27, value: 27, region: 'thigh', name: 'Femur L', color: null },
  { index: 28, value: 28, region: 'thigh', name: 'Femur R', color: null },
];

// ==================== Model Labels Map ====================

/**
 * Per-model label arrays keyed by ONNX filename.
 */
export const MODEL_LABELS = {
  'musclemap-wholebody.onnx': LABELS,
  'musclemap-abdomen.onnx': ABDOMEN_LABELS,
  'musclemap-forearm.onnx': FOREARM_LABELS,
  'musclemap-leg.onnx': LEG_LABELS,
  'musclemap-pelvis.onnx': PELVIS_LABELS,
  'musclemap-thigh.onnx': THIGH_LABELS,
};

/**
 * Get label array for a given model. Falls back to wholebody labels.
 */
export function getLabelsForModel(modelName) {
  return MODEL_LABELS[modelName] || LABELS;
}

// ==================== Index/Value Mappings (wholebody) ====================

/**
 * Mapping from contiguous model output index to sparse anatomical label value.
 * Used when creating downloadable NIfTI files for compatibility with MuscleMap.
 */
export const INDEX_TO_VALUE = new Map(LABELS.map(l => [l.index, l.value]));

/**
 * Mapping from sparse anatomical label value to contiguous model output index.
 */
export const VALUE_TO_INDEX = new Map(LABELS.map(l => [l.value, l.index]));

// ==================== Color Generation ====================

function hslToRgba(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
    255
  ];
}

/**
 * Generate distinct colors for a label array using evenly spaced HSL hues.
 */
function generateColors(labels) {
  for (let i = 1; i < labels.length; i++) {
    // Golden angle spacing ensures maximally distinct hues for any subset of labels
    const hue = ((i - 1) * 137.508) % 360;
    const saturation = 65 + (i % 3) * 12; // 65-89%
    const lightness = 40 + (i % 5) * 7;   // 40-68%
    labels[i].color = hslToRgba(hue, saturation, lightness);
  }
}

// Generate colors for all label sets on module load
for (const labels of Object.values(MODEL_LABELS)) {
  generateColors(labels);
}

// ==================== Public API ====================

/**
 * Get label name by index (defaults to wholebody labels).
 */
export function getLabelName(index, labels) {
  const labelArray = labels || LABELS;
  return labelArray[index]?.name || `Label ${index}`;
}

/**
 * Get label color as [R, G, B, A] (0-255) (defaults to wholebody labels).
 */
export function getLabelColor(index, labels) {
  const labelArray = labels || LABELS;
  return labelArray[index]?.color || [128, 128, 128, 255];
}

/**
 * Generate a NiiVue-compatible discrete colormap LUT.
 * Returns an object { R, G, B, A, min, max } for nv.addColormap().
 */
export function generateNiivueColormap(labels) {
  const labelArray = labels || LABELS;
  const size = 256;
  const R = new Array(size).fill(0);
  const G = new Array(size).fill(0);
  const B = new Array(size).fill(0);
  const A = new Array(size).fill(0);

  for (let i = 0; i < labelArray.length && i < size; i++) {
    const c = labelArray[i].color;
    if (c) {
      R[i] = c[0];
      G[i] = c[1];
      B[i] = c[2];
      A[i] = i === 0 ? 0 : 255; // Background transparent
    }
  }

  return { R, G, B, A };
}

/**
 * Get all non-background labels as array of { index, value, name, region, color }.
 */
export function getMuscleLabels(labels) {
  const labelArray = labels || LABELS;
  return labelArray.slice(1);
}
