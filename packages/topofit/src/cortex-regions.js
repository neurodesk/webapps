import manifest from '../cortex-regions.manifest.json' with { type: 'json' };

export const REGION_ATLASES = Object.freeze(Object.fromEntries(manifest.atlases.map((atlas) => [atlas.id, atlas])));

const WANG_GROUP = 'Visual areas · Wang 2015';
const HALF_GROUP = 'Visual area halves · Wang 2015';
const LOBE_GROUP = 'Lobes · Desikan-Killiany';
const DK_GROUP = 'Regions · Desikan-Killiany';

// FEF is a Wang 2015 topographic area but frontal, so it is not part of the visual cortex union.
const VISUAL_AREAS = [
  ['V1', ['V1v', 'V1d']],
  ['V2', ['V2v', 'V2d']],
  ['V3', ['V3v', 'V3d']],
  ...['hV4', 'VO1', 'VO2', 'PHC1', 'PHC2', 'TO1', 'TO2', 'LO1', 'LO2', 'V3A', 'V3B'].map((name) => [name, [name]]),
  ...['IPS0', 'IPS1', 'IPS2', 'IPS3', 'IPS4', 'IPS5', 'SPL1'].map((name) => [name, [name]]),
];
const HALVES = [
  ['V1v', 'V1 ventral (V1v)'],
  ['V1d', 'V1 dorsal (V1d)'],
  ['V2v', 'V2 ventral (V2v)'],
  ['V2d', 'V2 dorsal (V2d)'],
  ['V3v', 'V3 ventral (V3v)'],
  ['V3d', 'V3 dorsal (V3d)'],
];

// FreeSurfer's mri_annotation2label --lobesStrict (MRISaparc2lobes); insula stays its own lobe.
export const LOBES = Object.freeze({
  frontal: ['caudalmiddlefrontal', 'superiorfrontal', 'rostralmiddlefrontal', 'parsopercularis', 'parstriangularis', 'parsorbitalis', 'lateralorbitofrontal', 'medialorbitofrontal', 'paracentral', 'frontalpole', 'precentral'],
  parietal: ['supramarginal', 'inferiorparietal', 'superiorparietal', 'precuneus', 'postcentral'],
  temporal: ['superiortemporal', 'entorhinal', 'temporalpole', 'fusiform', 'inferiortemporal', 'middletemporal', 'parahippocampal', 'bankssts', 'transversetemporal'],
  occipital: ['pericalcarine', 'cuneus', 'lingual', 'lateraloccipital'],
  cingulate: ['isthmuscingulate', 'posteriorcingulate', 'caudalanteriorcingulate', 'rostralanteriorcingulate'],
  insula: ['insula'],
});
const LOBE_NAMES = {
  frontal: 'Frontal lobe',
  parietal: 'Parietal lobe',
  temporal: 'Temporal lobe',
  occipital: 'Occipital lobe',
  cingulate: 'Cingulate cortex',
  insula: 'Insula',
};
const DK_NAMES = {
  bankssts: 'Banks of the superior temporal sulcus',
  caudalanteriorcingulate: 'Caudal anterior cingulate',
  caudalmiddlefrontal: 'Caudal middle frontal',
  cuneus: 'Cuneus',
  entorhinal: 'Entorhinal',
  frontalpole: 'Frontal pole',
  fusiform: 'Fusiform',
  inferiorparietal: 'Inferior parietal',
  inferiortemporal: 'Inferior temporal',
  insula: 'Insula',
  isthmuscingulate: 'Isthmus cingulate',
  lateraloccipital: 'Lateral occipital',
  lateralorbitofrontal: 'Lateral orbitofrontal',
  lingual: 'Lingual',
  medialorbitofrontal: 'Medial orbitofrontal',
  middletemporal: 'Middle temporal',
  paracentral: 'Paracentral',
  parahippocampal: 'Parahippocampal',
  parsopercularis: 'Pars opercularis',
  parsorbitalis: 'Pars orbitalis',
  parstriangularis: 'Pars triangularis',
  pericalcarine: 'Pericalcarine',
  postcentral: 'Postcentral',
  posteriorcingulate: 'Posterior cingulate',
  precentral: 'Precentral',
  precuneus: 'Precuneus',
  rostralanteriorcingulate: 'Rostral anterior cingulate',
  rostralmiddlefrontal: 'Rostral middle frontal',
  superiorfrontal: 'Superior frontal',
  superiorparietal: 'Superior parietal',
  superiortemporal: 'Superior temporal',
  supramarginal: 'Supramarginal',
  temporalpole: 'Temporal pole',
  transversetemporal: 'Transverse temporal',
};

function labelValues(atlas, names) {
  return names.map((name) => {
    const label = REGION_ATLASES[atlas].labels.find((entry) => entry.name === name);
    if (!label) throw new Error(`${atlas} has no label ${name}.`);
    return label.value;
  });
}

const region = (id, name, group, atlas, names) => Object.freeze({ id: `${atlas}:${id}`, name, group, atlas, labels: Object.freeze(labelValues(atlas, names)) });

// The selectable regions, in menu order. A region id never changes once released.
export const REGIONS = Object.freeze([
  region('visual', 'Visual cortex (all mapped areas)', WANG_GROUP, 'wang2015', VISUAL_AREAS.flatMap(([, names]) => names)),
  ...VISUAL_AREAS.map(([name, names]) => region(name, name, WANG_GROUP, 'wang2015', names)),
  region('FEF', 'FEF', WANG_GROUP, 'wang2015', ['FEF']),
  ...HALVES.map(([name, label]) => region(name, label, HALF_GROUP, 'wang2015', [name])),
  ...Object.entries(LOBES).map(([lobe, names]) => region(`lobe-${lobe}`, LOBE_NAMES[lobe], LOBE_GROUP, 'aparc', names)),
  ...Object.entries(DK_NAMES)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([label, name]) => region(label, name, DK_GROUP, 'aparc', [label])),
]);

// A named region, or null for the whole eligible cortex. Rejects unknown ids, a region
// without the patch search, and a region combined with an ROI mask.
export function selectRegion(id = 'cortex', { patches, roi }) {
  if (id === 'cortex') return null;
  const selected = REGIONS.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`Unknown cortical region "${id}".`);
  if (!patches) throw new Error('A named cortical region requires the flat-patch search.');
  if (roi) throw new Error('Choose a named cortical region or an ROI mask, not both.');
  return selected;
}

export function readRegionAtlas(buffer, vertexCount) {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  if (count !== vertexCount || buffer.byteLength !== 4 + count * 2 * manifest.atlases.length) {
    throw new Error('Invalid cortical region atlas.');
  }
  return Object.fromEntries(manifest.atlases.map(({ id }, index) => [id, {
    lh: new Uint8Array(buffer, 4 + count * 2 * index, count),
    rh: new Uint8Array(buffer, 4 + count * (2 * index + 1), count),
  }]));
}
