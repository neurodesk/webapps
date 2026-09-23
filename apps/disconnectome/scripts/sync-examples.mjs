#!/usr/bin/env node
// Rebuild examples.json from the pinned manifest and the command-line tool's own output, so a
// re-upload never leaves the catalog quoting a stale revision or an invented result.
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('models/disconnectome.manifest.json', root)));
// The announcement is what a user sees before pressing Generate, so it has to describe the
// atlas they will actually get: the goldens differ, and so do the totals.
const goldens = { enigma: 'expected-examples-enigma.tsv', hcp1065: 'expected-examples.tsv' };
const preselected = manifest.atlases.find((entry) => entry.default) ?? manifest.atlases[0];
const tsv = (await readFile(new URL(`exes/nii2tvx/test/${goldens[preselected.id]}`, root), 'utf8'))
  .trim().split('\n');
const tracts = tsv[0].split('\t').slice(1);

// Geometry measured from the lesion masks themselves; the CLI does not report it. The
// modality differs per subject, and the file names on the dataset carry it.
const lesions = {
  wM2017: { modality: 'T1w', geometry: '163 cc, centred at MNI -45 -14 24' },
  wM2018: { modality: 'T2w', geometry: '45 cc, centred at MNI -41 -54 11' },
  wM2201: { modality: 'T2w', geometry: '0.3 cc, centred at MNI -8 -9 0' },
  wM2208: { modality: 'T2w', geometry: '13 cc, centred at MNI -23 -9 7' },
};

const asset = (filename) => {
  const entry = manifest.examples.find((item) => item.filename === filename);
  if (!entry) throw new Error(`Not in the manifest: ${filename}`);
  return { url: manifest.base_url + filename, sha256: entry.sha256 };
};

const examples = Object.entries(lesions).map(([subject, { modality, geometry }]) => {
  const row = tsv.find((line) => line.startsWith(`${subject}_${modality}_lesion\t`));
  if (!row) throw new Error(`No command-line result for ${subject}`);
  const fractions = row.split('\t').slice(1).map(Number);
  const damaged = fractions.filter((value) => value > 0).length;
  const severed = tracts.filter((_, index) => fractions[index] >= 0.999);
  return {
    id: subject.toLowerCase(),
    label: `${subject} lesion and ${modality.replace(/w$/, '')}`,
    description: `A left-hemisphere stroke lesion of ${geometry}, with the spatially normalized ${modality.replace(/w$/, '')} it was drawn on.`,
    // The selector announces this before the run, so it reads as what to expect, not a result.
    expectedResult: `With the ${preselected.label} atlas, ${damaged} score as damaged and `
      + `${severed.length} as severed completely.`,
    files: [
      { role: 'image', name: `${subject}_${modality}_lesion.nii.gz`, ...asset(`examples/${subject}_${modality}_lesion.nii.gz`) },
      { role: 'anatomical', name: `${subject}_${modality}.nii.gz`, ...asset(`examples/${subject}_${modality}.nii.gz`) },
    ],
  };
});

await writeFile(new URL('apps/disconnectome/examples.json', root), `${JSON.stringify(examples, null, 2)}\n`);
for (const example of examples) console.log(`${example.id}: ${example.expectedResult}`);
