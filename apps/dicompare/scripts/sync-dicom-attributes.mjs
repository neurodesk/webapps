// Regenerate src/data/dicomAttributes.json — the DICOM attribute dictionary used
// for field search — from Innolitics' machine-readable DICOM standard.
//
// The source is pinned to a commit so the bundled list only changes when this
// script is deliberately re-run with a new SHA. Retired attributes are dropped
// and only the keys the app reads are kept.
//
// Usage: npm run sync:dicom-attributes

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const COMMIT = '90571bcc4e46b08bc815bd683e6c466308bcff9a'; // innolitics/dicom-standard master, 2026-04-17
const SOURCE = `https://raw.githubusercontent.com/innolitics/dicom-standard/${COMMIT}/standard/attributes.json`;
const OUT = fileURLToPath(new URL('../src/data/dicomAttributes.json', import.meta.url));

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Failed to fetch ${SOURCE}: HTTP ${response.status}`);
const attributes = await response.json();

const kept = attributes
  .filter(a => a.retired !== 'Y')
  .map(({ tag, name, keyword, valueRepresentation, valueMultiplicity, id }) =>
    ({ tag, name, keyword, valueRepresentation, valueMultiplicity, id }));

// One attribute per line: compact, but still diffs line-by-line on update.
writeFileSync(OUT, '[\n' + kept.map(a => JSON.stringify(a)).join(',\n') + '\n]\n');
console.log(`Wrote ${kept.length} of ${attributes.length} attributes to ${OUT}`);
