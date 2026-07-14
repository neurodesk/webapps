// Group DICOM headers into series and rank them, gridsift-style but rule-based
// and fully client-side (no LLM). Grouping is by SeriesInstanceUID. Each series
// is classified with MR physics tags first, then SeriesDescription keywords,
// producing a label and a confidence. Ambiguous series are flagged, not hidden.
//
// The default selection prefers the most likely structural T1 scan.

const KEYWORDS = {
  localizer: /(localizer|localiser|scout|survey|\bloc\b|aahead|plane_?loc)/i,
  color: /(colfa|col_?fa|color[_ ]?fa|\bfa\b|tensor|_dec\b|directional)/i,
  flair: /(flair|dark[_ ]?fluid)/i,
  dwi: /(\bdwi\b|\bdti\b|diff|\btrace\b|\badc\b|tensor|ep2d_diff|\bep_?b\d)/i,
  t2: /(\bt2\b|t2w|t2[_ ]?tse|t2[_ ]?spc|spc[_ ]?t2|\btse\b|space)/i,
  t1: /(\bt1\b|t1w|mprage|mp2rage|mp[_ ]?rage|\btfl\b|bravo|spgr|fspgr|flash3d|t1[_ ]?vibe|vibe)/i,
};

const LABELS = ['t1', 't2', 'flair', 'dwi', 'color', 'localizer', 'other'];

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Classify one grouped series. Returns { label, confidence (0..1), reasons[] }.
export function classifySeries(series) {
  const desc = series.seriesDescription || '';
  const tr = num(series.physics.repetitionTime);
  const te = num(series.physics.echoTime);
  const ti = num(series.physics.inversionTime);
  const acq3d = /3D/i.test(series.physics.mrAcquisitionType || '');
  const reasons = [];

  // Color is decided by the pixel format, which is unambiguous.
  if (series.isColor) {
    reasons.push('RGB pixel data');
    return { label: 'color', confidence: 0.95, reasons };
  }

  // Keyword votes.
  const kw = {};
  for (const [label, re] of Object.entries(KEYWORDS)) {
    if (re.test(desc)) { kw[label] = true; reasons.push(`description matches ${label}`); }
  }

  // Physics votes (secondary), only when tags are present.
  let physicsLabel = null;
  if (ti !== null && ti > 1500 && (te === null || te > 60)) physicsLabel = 'flair';
  else if (te !== null && te > 80 && (tr === null || tr > 2000) && (ti === null || ti < 50)) physicsLabel = 't2';
  else if (te !== null && te < 30 && (tr === null || tr < 3000)) physicsLabel = 't1';
  if (physicsLabel) reasons.push(`physics suggests ${physicsLabel}`);

  // Localizer: explicit keyword, or a very small stack with no strong contrast cue.
  if (kw.localizer || (series.sliceCount > 0 && series.sliceCount <= 3 && !kw.t1 && !kw.t2 && !kw.flair)) {
    return { label: 'localizer', confidence: kw.localizer ? 0.9 : 0.5, reasons };
  }

  // Priority: keyword agreement with physics is highest confidence.
  for (const label of ['flair', 'dwi', 't2', 't1']) {
    if (kw[label]) {
      const agree = physicsLabel === label;
      return { label, confidence: agree ? 0.9 : 0.7, reasons };
    }
  }
  if (physicsLabel) return { label: physicsLabel, confidence: 0.55, reasons };

  return { label: 'other', confidence: 0.3, reasons };
}

// Higher pickScore = more likely to be the default structural pick.
function pickScore(series, classification) {
  let score = 0;
  const labelBonus = { t1: 100, t2: 60, flair: 55, other: 30, dwi: 20, color: 15, localizer: 0 };
  score += labelBonus[classification.label] ?? 0;
  score += classification.confidence * 20;
  if (/3D/i.test(series.physics.mrAcquisitionType || '')) score += 15;
  score += Math.min(series.sliceCount, 400) / 20; // favor larger stacks, capped
  return score;
}

// Group parsed DICOM headers (from readDicomHeader) into ranked series.
// headers: [{ name, seriesInstanceUID, seriesDescription, seriesNumber,
//   repetitionTime, echoTime, inversionTime, flipAngle, mrAcquisitionType,
//   samplesPerPixel, photometric, numberOfFrames, rows, cols }]
export function groupSeries(headers) {
  const byUid = new Map();
  for (const h of headers) {
    const uid = h.seriesInstanceUID || `__nouid__${h.name}`;
    if (!byUid.has(uid)) {
      byUid.set(uid, {
        seriesInstanceUID: uid,
        seriesDescription: h.seriesDescription || '',
        seriesNumber: h.seriesNumber,
        files: [],
        sliceCount: 0,
        isColor: (h.samplesPerPixel === 3) || /RGB|YBR/i.test(h.photometric || ''),
        isMultiframe: (h.numberOfFrames || 1) > 1,
        rows: h.rows,
        cols: h.cols,
        physics: {
          repetitionTime: h.repetitionTime,
          echoTime: h.echoTime,
          inversionTime: h.inversionTime,
          flipAngle: h.flipAngle,
          mrAcquisitionType: h.mrAcquisitionType,
        },
      });
    }
    const s = byUid.get(uid);
    s.files.push(h.name);
    s.sliceCount += (h.numberOfFrames || 1);
  }

  const series = [...byUid.values()].map((s) => {
    const classification = classifySeries(s);
    return { ...s, classification, pickScore: pickScore(s, classification) };
  });

  // Sort by series number when available, else description, for a stable list.
  series.sort((a, b) => {
    if (a.seriesNumber != null && b.seriesNumber != null && a.seriesNumber !== b.seriesNumber) {
      return a.seriesNumber - b.seriesNumber;
    }
    return String(a.seriesDescription).localeCompare(String(b.seriesDescription));
  });

  // Default pick: highest pickScore.
  let defaultIndex = 0;
  let best = -Infinity;
  series.forEach((s, i) => { if (s.pickScore > best) { best = s.pickScore; defaultIndex = i; } });

  return { series, defaultIndex, labels: LABELS };
}
