// STAR files as RELION 5 writes them, and the FSC that postprocess.star holds.
// Pure, so the tests run it under Node.

function tokens(line) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/**
 * Blocks `{ name, pairs, columns, rows }`: `pairs` is a Map for key-value
 * blocks, `columns` and `rows` hold a loop. Values stay strings.
 */
export function parseStar(text) {
  const blocks = [];
  let block = null;
  let inLoop = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('data_')) {
      block = { name: line.slice(5), pairs: new Map(), columns: [], rows: [] };
      blocks.push(block);
      inLoop = false;
      continue;
    }
    if (!block) throw new Error('STAR text has content before its first data_ block');
    if (line === 'loop_' || line.startsWith('loop_ ')) {
      inLoop = true;
      continue;
    }
    if (line.startsWith('_')) {
      const [label, value] = tokens(line.slice(1));
      if (inLoop && !block.rows.length) block.columns.push(label);
      else block.pairs.set(label, value ?? '');
      continue;
    }
    if (!inLoop) throw new Error(`Unexpected STAR line in data_${block.name}: ${line}`);
    const row = tokens(line);
    if (row.length !== block.columns.length) throw new Error(`A row of data_${block.name} has ${row.length} values for ${block.columns.length} columns`);
    block.rows.push(row);
  }
  return blocks;
}

function column(block, label) {
  const index = block.columns.indexOf(label);
  if (index < 0) throw new Error(`data_${block.name} has no ${label} column`);
  return block.rows.map(row => Number(row[index]));
}

/**
 * The gold-standard FSC of a PostProcess job: the final resolution (Å), the
 * sharpening B-factor and, per shell, the resolution (1/Å), the corrected FSC
 * and the phase-randomised masked FSC.
 */
export function postprocessFsc(text) {
  const blocks = parseStar(text);
  const general = blocks.find(block => block.name === 'general');
  const fsc = blocks.find(block => block.name === 'fsc');
  if (!general || !fsc) throw new Error('postprocess.star needs data_general and data_fsc');
  const resolution = column(fsc, 'rlnResolution');
  const corrected = column(fsc, 'rlnFourierShellCorrelationCorrected');
  const randomised = fsc.columns.includes('rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps')
    ? column(fsc, 'rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps')
    : null;
  return {
    finalResolution: Number(general.pairs.get('rlnFinalResolution')),
    bfactor: Number(general.pairs.get('rlnBfactorUsedForSharpening')),
    shells: resolution.map((value, index) => ({
      resolution: value,
      fsc: corrected[index],
      randomised: randomised ? randomised[index] : null,
    })),
  };
}

/** `sha256  path` lines of a SHA256SUMS file as `{ path: sha256 }`. */
export function parseChecksums(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (match) sums[match[2]] = match[1];
  }
  return sums;
}
