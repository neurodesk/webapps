// Unit test for web/js/bids.js — the BIDS indexer used by the browser app.
// Feeds it a synthetic entry list mirroring the real dataset's naming and
// asserts role selection, b1kind, compliance states, runnable flags, and that a
// TB1TFL anatomical reference is never chosen as the B1 source.
//
// run:  node web/test/bids_test.mjs
import assert from 'assert';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const { parseEntities, indexBids } = await import(resolve(here, '../js/bids.js'));

// Opaque "file" objects — must be passed through unchanged.
const F = (tag) => ({ tag });
const entry = (path) => ({ path, file: F(path) });

const entries = [
  // sub-001 / ses-01 : UNI is a nonstandard _T1w; famp + anat TB1TFL both present
  entry('sub-001/ses-01/anat/sub-001_ses-01_acq-MP2RAGEuq0p75mm_inv-1_MP2RAGE.nii.gz'),
  entry('sub-001/ses-01/anat/sub-001_ses-01_acq-MP2RAGEuq0p75mm_inv-2_MP2RAGE.nii.gz'),
  entry('sub-001/ses-01/anat/sub-001_ses-01_acq-MP2RAGEuq0p75mmUNIDEN_T1w.nii.gz'),
  entry('sub-001/ses-01/anat/sub-001_ses-01_acq-MP2RAGEuq0p75mmUNIDEN_T1w.json'),
  entry('sub-001/ses-01/fmap/sub-001_ses-01_acq-famp_TB1TFL.nii.gz'),
  entry('sub-001/ses-01/fmap/sub-001_ses-01_acq-anat_TB1TFL.nii.gz'),

  // sub-001 / ses-02 : clean UNIT1 + SA2RAGE
  entry('sub-001/ses-02/anat/sub-001_ses-02_inv-1_MP2RAGE.nii.gz'),
  entry('sub-001/ses-02/anat/sub-001_ses-02_inv-2_MP2RAGE.nii.gz'),
  entry('sub-001/ses-02/anat/sub-001_ses-02_UNIT1.nii.gz'),
  entry('sub-001/ses-02/fmap/sub-001_ses-02_acq-sa2rage_TB1SRGE.nii.gz'),

  // sub-002 : no session, missing B1 source
  entry('sub-002/anat/sub-002_inv-1_MP2RAGE.nii.gz'),
  entry('sub-002/anat/sub-002_inv-2_MP2RAGE.nii.gz'),
  entry('sub-002/anat/sub-002_UNIT1.nii.gz'),

  // sub-003 / ses-01 : two INV2 → ambiguous; UNI + B1 present, INV1 absent
  entry('sub-003/ses-01/anat/sub-003_ses-01_acq-aaa_inv-2_MP2RAGE.nii.gz'),
  entry('sub-003/ses-01/anat/sub-003_ses-01_acq-bbb_inv-2_MP2RAGE.nii.gz'),
  entry('sub-003/ses-01/anat/sub-003_ses-01_UNIT1.nii.gz'),
  entry('sub-003/ses-01/fmap/sub-003_ses-01_TB1map.nii.gz'),
];

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = (a, b, msg) => {
  assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  checks++;
};

// ---------------------------------------------------------------------------
// parseEntities
// ---------------------------------------------------------------------------
const pe = parseEntities('sub-001/ses-01/anat/sub-001_ses-01_acq-MP2RAGEuq0p75mm_inv-1_MP2RAGE.nii.gz');
eq(pe.sub, 'sub-001', 'parse.sub');
eq(pe.ses, 'ses-01', 'parse.ses');
eq(pe.datatype, 'anat', 'parse.datatype');
eq(pe.suffix, 'MP2RAGE', 'parse.suffix');
eq(pe.ext, '.nii.gz', 'parse.ext');
eq(pe.entities.acq, 'MP2RAGEuq0p75mm', 'parse.entities.acq');
eq(pe.entities.inv, 1, 'parse.entities.inv is Number');
ok(typeof pe.entities.inv === 'number', 'parse.entities.inv typeof number');
eq(pe.base, 'sub-001_ses-01_acq-MP2RAGEuq0p75mm_inv-1_MP2RAGE', 'parse.base');

// no-session file: ses null, datatype from folder
const pe2 = parseEntities('sub-002/anat/sub-002_UNIT1.nii.gz');
eq(pe2.ses, null, 'parse.ses null when absent');
eq(pe2.suffix, 'UNIT1', 'parse.suffix UNIT1');
eq(pe2.datatype, 'anat', 'parse.datatype no-ses');

// json sidecar ext detection
eq(parseEntities('sub-002/anat/sub-002_UNIT1.json').ext, '.json', 'parse.ext json');

// ---------------------------------------------------------------------------
// indexBids
// ---------------------------------------------------------------------------
const idx = indexBids(entries);
eq(idx.nSubjects, 3, 'nSubjects');
eq(idx.nSessions, 4, 'nSessions');
eq(idx.subjects.map((s) => s.id).join(','), 'sub-001,sub-002,sub-003', 'subject order');

const subj = (id) => idx.subjects.find((s) => s.id === id);
const sess = (id, ses) => subj(id).sessions.find((s) => s.id === ses);

// ---- sub-001 / ses-01 : nonstandard UNI + famp B1 + anat ref -----------------
{
  const s = sess('sub-001', 'ses-01');
  ok(s.roles.INV1 && /inv-1_MP2RAGE/.test(s.roles.INV1.path), 'ses01 INV1 chosen');
  ok(s.roles.INV2 && /inv-2_MP2RAGE/.test(s.roles.INV2.path), 'ses01 INV2 chosen');

  // UNI is the _T1w file, flagged nonstandard.
  ok(s.roles.UNI && /_T1w\.nii\.gz$/.test(s.roles.UNI.path), 'ses01 UNI is the _T1w');
  eq(s.status.UNI.state, 'nonstandard', 'ses01 UNI state nonstandard');
  ok(/UNIT1/.test(s.status.UNI.reason), 'ses01 UNI reason mentions UNIT1');

  // B1: famp is chosen, kind b1map; anat ref present but never chosen.
  ok(s.roles.B1SOURCE && /acq-famp/.test(s.roles.B1SOURCE.path), 'ses01 B1 is the famp TB1TFL');
  ok(!/acq-anat/.test(s.roles.B1SOURCE.path), 'ses01 anat TB1TFL NOT chosen as B1');
  eq(s.b1kind, 'b1map', 'ses01 b1kind b1map');
  eq(s.status.B1SOURCE.state, 'ok', 'ses01 B1 state ok');

  // anat ref is a candidate but has no assigned role.
  eq(s.candidates.B1SOURCE.length, 2, 'ses01 two B1 candidates (famp + anat)');
  const anatRef = s.candidates.B1SOURCE.find((f) => /acq-anat/.test(f.path));
  ok(anatRef && anatRef.role === null, 'ses01 anat ref role is null');
  ok(
    s.warnings.some((w) => /anatomical reference/i.test(w) && /acq-anat/.test(w)),
    'ses01 warns about anat TB1TFL reference'
  );

  eq(s.runnable.t1, true, 'ses01 runnable.t1');
  eq(s.runnable.denoise, true, 'ses01 runnable.denoise');

  // sidecar collected and pairs to the image base
  ok(s.sidecars.some((j) => j.base === 'sub-001_ses-01_acq-MP2RAGEuq0p75mmUNIDEN_T1w'), 'ses01 sidecar base');

  // opaque file passthrough
  ok(s.roles.UNI.file && s.roles.UNI.file.tag === s.roles.UNI.path, 'ses01 file passthrough intact');
}

// ---- sub-001 / ses-02 : clean UNIT1 + SA2RAGE -------------------------------
{
  const s = sess('sub-001', 'ses-02');
  ok(s.roles.UNI && /_UNIT1\.nii\.gz$/.test(s.roles.UNI.path), 'ses02 UNI is UNIT1');
  eq(s.status.UNI.state, 'ok', 'ses02 UNI state ok');
  ok(s.roles.B1SOURCE && /TB1SRGE/.test(s.roles.B1SOURCE.path), 'ses02 B1 is TB1SRGE');
  eq(s.b1kind, 'sa2rage', 'ses02 b1kind sa2rage');
  eq(s.status.B1SOURCE.state, 'ok', 'ses02 B1 state ok');
  eq(s.runnable.t1, true, 'ses02 runnable.t1');
  eq(s.runnable.denoise, true, 'ses02 runnable.denoise');
}

// ---- sub-002 : no session, missing B1 --------------------------------------
{
  const s = sess('sub-002', null);
  eq(s.id, null, 'sub-002 session id null');
  eq(s.roles.B1SOURCE, null, 'sub-002 no B1 chosen');
  eq(s.status.B1SOURCE.state, 'missing', 'sub-002 B1 missing');
  eq(s.status.UNI.state, 'ok', 'sub-002 UNI ok');
  eq(s.runnable.t1, false, 'sub-002 not runnable.t1 (no B1)');
  eq(s.runnable.denoise, true, 'sub-002 runnable.denoise');
  ok(s.warnings.some((w) => /no B1 source found/.test(w) && /assign it manually/.test(w)), 'sub-002 warns missing B1');
}

// ---- sub-003 / ses-01 : ambiguous INV2, missing INV1 ------------------------
{
  const s = sess('sub-003', 'ses-01');
  eq(s.status.INV2.state, 'ambiguous', 'sub-003 INV2 ambiguous');
  eq(s.candidates.INV2.length, 2, 'sub-003 two INV2 candidates');
  ok(/acq-aaa/.test(s.roles.INV2.path), 'sub-003 INV2 chooses first by path (aaa)');
  eq(s.status.INV1.state, 'missing', 'sub-003 INV1 missing');
  eq(s.b1kind, 'b1map', 'sub-003 b1kind b1map (TB1map)');
  eq(s.status.B1SOURCE.state, 'ok', 'sub-003 B1 ok');
  eq(s.runnable.t1, true, 'sub-003 runnable.t1 (UNI+INV2+B1)');
  eq(s.runnable.denoise, false, 'sub-003 not runnable.denoise (no INV1)');
  ok(s.warnings.some((w) => /INV2 candidates/.test(w)), 'sub-003 warns ambiguous INV2');
}

console.log(`bids.js: ${checks} assertions`);
console.log('PASS ✅');
process.exit(0);
