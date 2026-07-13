#!/usr/bin/env node
// Contract test for web/js/modules/overlap-export.js: the CSV serializer.
// Written before the implementation per the project's TDD policy.
//
// Output schema (locked):
//   header: network,voxelsInLesion,fractionOfLesion,voxelsInNetwork,fractionOfNetwork,parcels
//   rows:   one per network in summary.networks, in the order summary lists
//           them, EXCEPT 'Unassigned' is always last regardless of voxel count.
//   numeric formatting:
//     voxelsInLesion / voxelsInNetwork -> integers
//     fractionOfLesion / fractionOfNetwork -> 4 decimal places
//     voxelsInNetwork / fractionOfNetwork -> empty cell if the network has no
//       entry in the supplied networkSizes map (e.g. 'Unassigned')
//   parcels -> integer labels joined by ';' (no quoting needed; survives one
//     Excel column).
//   empty summary -> header line + a single trailing '\n'.
//   non-empty summary -> rows + a single trailing '\n' (so the file is a
//     well-formed text file under POSIX conventions).

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/overlap-export.js')
  );
  const { serializeOverlapCsv } = await import(moduleUrl);

  const HEADER = 'network,voxelsInLesion,fractionOfLesion,voxelsInNetwork,fractionOfNetwork,parcels';

  // ---- Case 1: empty summary -> header only ----
  const empty = serializeOverlapCsv(
    { totalLesionVoxels: 0, networks: [] },
    { networkSizes: {} }
  );
  assert.equal(empty, HEADER + '\n', 'empty summary must yield header-only CSV');

  // ---- Case 2: typical case with two networks + Unassigned at the bottom ----
  // summary.networks already arrives in 'descending voxelsInLesion' order from
  // summarizeNetworkOverlap. The serializer's only reordering rule is to push
  // 'Unassigned' to the end.
  const summary = {
    totalLesionVoxels: 10,
    networks: [
      { network: 'Visual',      voxelsInLesion: 6, fractionOfLesion: 0.6, parcels: [1, 2] },
      { network: 'Unassigned',  voxelsInLesion: 3, fractionOfLesion: 0.3, parcels: [99] },
      { network: 'Default',     voxelsInLesion: 1, fractionOfLesion: 0.1, parcels: [7] }
    ]
  };
  const networkSizes = { Visual: 200, Default: 400, Somatomotor: 1000 };
  // Note: 'Unassigned' deliberately missing from networkSizes — it's not a
  // canonical network so its size is undefined.

  const csv = serializeOverlapCsv(summary, { networkSizes });
  const lines = csv.split('\n');
  assert.equal(lines[0], HEADER, 'first line must be the header');
  assert.equal(lines.length, 5,
    'expect 4 content lines (header + Visual + Default + Unassigned) + trailing empty');
  assert.equal(lines[lines.length - 1], '',
    'CSV must end with a single trailing newline');

  // Visual: voxels=6, fracLesion=0.6000, netSize=200, fracNet=6/200=0.0300, parcels=1;2
  assert.equal(lines[1], 'Visual,6,0.6000,200,0.0300,1;2');
  // Default: voxels=1, fracLesion=0.1000, netSize=400, fracNet=1/400=0.0025, parcels=7
  assert.equal(lines[2], 'Default,1,0.1000,400,0.0025,7');
  // Unassigned moved to last; netSize unknown -> empty cells.
  assert.equal(lines[3], 'Unassigned,3,0.3000,,,99');

  // ---- Case 3: 'Unassigned' is the only network -> still appears, with
  // empty network-size columns. ----
  const onlyUn = serializeOverlapCsv(
    { totalLesionVoxels: 2, networks: [
      { network: 'Unassigned', voxelsInLesion: 2, fractionOfLesion: 1.0, parcels: [50] }
    ] },
    { networkSizes }
  );
  assert.equal(onlyUn, HEADER + '\nUnassigned,2,1.0000,,,50\n');

  // ---- Case 4: Unassigned in source order is moved last even when its
  // voxelsInLesion is the largest. ----
  const summary4 = {
    totalLesionVoxels: 100,
    networks: [
      { network: 'Unassigned', voxelsInLesion: 90, fractionOfLesion: 0.9, parcels: [42, 43] },
      { network: 'Default',    voxelsInLesion: 10, fractionOfLesion: 0.1, parcels: [7] }
    ]
  };
  const csv4 = serializeOverlapCsv(summary4, { networkSizes });
  const lines4 = csv4.split('\n');
  assert.equal(lines4[1], 'Default,10,0.1000,400,0.0250,7',
    'Default appears before Unassigned even though Unassigned has more voxels');
  assert.equal(lines4[2], 'Unassigned,90,0.9000,,,42;43',
    'Unassigned is always last');

  // ---- Case 5: parcels list of 0 -> empty string in column (no '0') ----
  // (Implementation detail: an empty parcels[] is unusual but defensible.)
  const summary5 = {
    totalLesionVoxels: 0,
    networks: [
      { network: 'Visual', voxelsInLesion: 0, fractionOfLesion: 0, parcels: [] }
    ]
  };
  const csv5 = serializeOverlapCsv(summary5, { networkSizes });
  const lines5 = csv5.split('\n');
  assert.equal(lines5[1], 'Visual,0,0.0000,200,0.0000,');

  // ---- Case 6: networkSizes argument optional (should default to {}). ----
  const csv6 = serializeOverlapCsv(summary);   // no second argument
  const lines6 = csv6.split('\n');
  // Without networkSizes, voxelsInNetwork + fractionOfNetwork columns must
  // be empty for every row (no implicit guesses).
  assert.match(lines6[1], /^Visual,6,0\.6000,,,1;2$/);
  assert.match(lines6[2], /^Default,1,0\.1000,,,7$/);
  assert.match(lines6[3], /^Unassigned,3,0\.3000,,,99$/);

  console.log('overlap-export OK: 6 cases (header, ordering, Unassigned-last, missing sizes).');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
