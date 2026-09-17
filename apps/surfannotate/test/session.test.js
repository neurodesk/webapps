import test from 'node:test';
import assert from 'node:assert/strict';

import {
  writeSession, readSession, sessionFits, sessionFromGiftiMetadata, SESSION_FORMAT,
  SESSION_METADATA_KEY
} from '../src/io/session.js';
import { writeGiftiLabel } from '../src/io/gifti.js';

const MESH = { structure: 'CortexLeft', numVertices: 1681, numTriangles: 3200, triangleHash: 'sha256:abc' };
const KEY = '1681:sha256:abc';
const ROIS = [
  { id: 7, name: 'V1', clicks: [42, 80, 120], closure: 'loop', regionIndex: 0, includeBoundary: false,
    anchor: 90, colorIndex: 0, visible: true, mask: new Uint8Array(3), chain: new Int32Array(2), error: null },
  { id: 9, name: 'V2 dorsal', clicks: [200, 240], closure: 'edge', regionIndex: 1, includeBoundary: true,
    anchor: -1, colorIndex: 3, visible: false, mask: null, chain: new Int32Array(0), error: 'BROKEN_BOUNDARY' }
];
const POINTS = [{ vertex: 5, name: 'MT' }, { vertex: 6 }];

test('a session round-trips every definition field and nothing derived', () => {
  const text = writeSession({ rois: ROIS, points: POINTS, mesh: MESH, topologyKey: KEY, created: '2026-09-16T00:00:00Z' });
  const session = readSession(text);
  assert.equal(session.format, SESSION_FORMAT);
  assert.equal(session.topologyKey, KEY);
  assert.deepEqual(session.mesh, MESH);
  assert.deepEqual(session.rois, [
    { name: 'V1', clicks: [42, 80, 120], closure: 'loop', regionIndex: 0, includeBoundary: false, anchor: 90, colorIndex: 0, visible: true },
    { name: 'V2 dorsal', clicks: [200, 240], closure: 'edge', regionIndex: 1, includeBoundary: true, colorIndex: 3, visible: false }
  ]);
  assert.deepEqual(session.points, POINTS);
  // Masks, chains and errors are outputs of resolving the list; a stale copy in
  // the file would be wrong the moment a neighbour moved.
  assert.ok(!text.includes('"mask"') && !text.includes('"chain"') && !text.includes('"error"'));
  assert.ok(!text.includes('"id"'), 'ids are assigned on load, not carried');
});

test('the traced border travels with the definition, and is validated', () => {
  const rois = [{ ...ROIS[0], border: [42, 43, 44, 80, 120, 42] }];
  const session = readSession(writeSession({ rois, mesh: MESH, topologyKey: KEY }));
  assert.deepEqual(session.rois[0].border, [42, 43, 44, 80, 120, 42]);
  // An old file without one still reads; the ROI is re-traced from its clicks.
  const bare = readSession(writeSession({ rois: [ROIS[0]], mesh: MESH, topologyKey: KEY }));
  assert.equal(bare.rois[0].border, undefined);
  assert.throws(() => readSession(JSON.stringify({ format: SESSION_FORMAT, rois: [{ name: 'V1', clicks: [1], closure: 'loop', border: [1, 'x'] }] })), /invalid border/);
  // Border vertices count against the surface too.
  const stray = readSession(writeSession({ rois: [{ ...ROIS[0], border: [1, 9999] }], mesh: MESH, topologyKey: KEY }));
  assert.match(sessionFits(stray, { vertexCount: 1681, topologyKey: KEY }).reason, /vertices this surface lacks/);
});

test('reading refuses what is not a session, naming the problem', () => {
  assert.throws(() => readSession('not json'), /not a JSON file/);
  assert.throws(() => readSession('{"format":"surf-roi-points/1"}'), /not a SurfAnnotate session/);
  assert.throws(() => readSession(JSON.stringify({ format: SESSION_FORMAT })), /no ROI list/);
  assert.throws(() => readSession(JSON.stringify({ format: SESSION_FORMAT, rois: [{ name: 'V1', clicks: [1, -2], closure: 'loop' }] })), /V1.*border points/);
  assert.throws(() => readSession(JSON.stringify({ format: SESSION_FORMAT, rois: [{ name: 'V1', clicks: [1], closure: 'spiral' }] })), /closure/);
});

test('a session fits only the surface it was drawn on', () => {
  const session = readSession(writeSession({ rois: ROIS, points: POINTS, mesh: MESH, topologyKey: KEY }));
  assert.deepEqual(sessionFits(session, { vertexCount: 1681, topologyKey: KEY }), { ok: true });
  assert.match(sessionFits(session, { vertexCount: 163842, topologyKey: '163842:sha256:zzz' }).reason, /1,681 vertices; this one has 163,842/);
  assert.match(sessionFits(session, { vertexCount: 1681, topologyKey: '1681:sha256:other' }).reason, /different triangulation/);
  // A vertex count alone is enough to say no.
  const stray = readSession(writeSession({ rois: [{ ...ROIS[0], clicks: [5000] }], mesh: MESH, topologyKey: KEY }));
  assert.match(sessionFits(stray, { vertexCount: 1681, topologyKey: KEY }).reason, /vertices this surface lacks/);
});

test('invalid palette indices are rejected before a session can change the ROI list', () => {
  for (const colorIndex of [-1, 0.5, 'blue', null]) {
    const text = JSON.stringify({ format: SESSION_FORMAT, rois: [{ ...ROIS[0], colorIndex }] });
    assert.throws(() => readSession(text), /V1.*invalid colour index/);
  }
});

test('the session survives a trip through .label.gii metadata, including "]]>" in a name', async () => {
  const rois = [{ ...ROIS[0], name: 'odd]]>name' }];
  const text = writeSession({ rois, mesh: MESH, topologyKey: KEY });
  const xml = await writeGiftiLabel(new Int32Array(4), [{ key: 1, name: 'odd]]>name', rgba: [1, 0, 0, 1] }],
    { metadata: { [SESSION_METADATA_KEY]: text, Other: 'x' } });
  const back = sessionFromGiftiMetadata(xml);
  assert.equal(back, text);
  assert.equal(readSession(back).rois[0].name, 'odd]]>name');
});

test('a .label.gii without the entry yields null, not a throw', async () => {
  const xml = await writeGiftiLabel(new Int32Array(2), [{ key: 1, name: 'V1', rgba: [1, 0, 0, 1] }]);
  assert.equal(sessionFromGiftiMetadata(xml), null);
  assert.equal(sessionFromGiftiMetadata('<GIFTI/>'), null);
});
