// Basis-set selection. LCModel needs basis spectra simulated for the data's
// field strength, sequence and echo time: J-coupled metabolites (Glu, Gln,
// GABA, NAA's aspartyl group, mI, Lac) change shape with TE and with the
// timing of the refocusing pulses, so a mismatched basis biases their
// concentrations even when the fit looks good. This module ranks the
// available basis sets for a dataset and explains each mismatch.

// LCModel (MYBASI) warns when HZPPPM differs by 5% and stops at 20%.
const FIELD_WARN = 0.05;
const FIELD_FATAL = 0.2;
// Echo-time differences, ms.
const TE_CLOSE = 2;
const TE_OK = 5;
const TE_POOR = 15;

const SEQUENCE_ALIASES = [
  [/special/i, "SPECIAL"],
  [/s(emi)?[-_ ]?laser|slaser/i, "sLASER"],
  [/laser/i, "LASER"],
  [/steam|svs_st(?![a-z])/i, "STEAM"],
  [/mega/i, "MEGA-PRESS"],
  [/press|svs_se(?![a-z])|probe/i, "PRESS"],
];

// A sequence name as a scanner or a basis file writes it, reduced to a family.
export function sequenceFamily(name) {
  if (!name) return null;
  const text = String(name);
  for (const [pattern, family] of SEQUENCE_ALIASES) {
    if (pattern.test(text)) return family;
  }
  return null;
}

// Families with similar J-evolution at short TE: an acceptable substitute
// with a warning rather than a mismatch.
function similarFamilies(a, b) {
  const pairs = [["sLASER", "LASER"], ["PRESS", "sLASER"], ["SPECIAL", "STEAM"]];
  return pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

// Rate one basis set for one dataset.
// data: { hzpppm, teMs, sequence }  (any may be missing)
// basis: { id, label, hzpppm, teMs, sequence }
export function assessBasis(data, basis) {
  const notes = [];
  let score = 100;
  let usable = true;
  if (data.hzpppm > 0 && basis.hzpppm > 0) {
    const mismatch = Math.abs(basis.hzpppm / data.hzpppm - 1);
    if (mismatch >= FIELD_FATAL) {
      usable = false;
      score -= 100;
      notes.push({ level: "error", text: `Simulated at ${fieldLabel(basis.hzpppm)}; the data are ${fieldLabel(data.hzpppm)}.` });
    } else if (mismatch >= FIELD_WARN) {
      score -= 40;
      notes.push({ level: "warning", text: `Field strength differs by ${Math.round(mismatch * 100)}%.` });
    }
  } else {
    score -= 10;
    notes.push({ level: "info", text: "The data do not record the field strength." });
  }
  const dataSeq = sequenceFamily(data.sequence);
  const basisSeq = sequenceFamily(basis.sequence);
  // An edited difference spectrum and an unedited spectrum need different
  // basis sets; one never stands in for the other.
  const dataEdited = dataSeq === "MEGA-PRESS";
  const basisEdited = basisSeq === "MEGA-PRESS";
  if (dataEdited && !basisEdited && basisSeq === null) {
    // A user's own file that does not name its sequence.
    score -= 30;
    notes.push({ level: "warning", text: "Check that this is a MEGA-PRESS difference basis: its header names no sequence." });
  } else if (dataEdited && !basisEdited) {
    usable = false;
    score -= 100;
    notes.push({ level: "error", text: "Edited data are fitted as a difference spectrum and need a MEGA-PRESS basis." });
  } else if (!dataEdited && basisEdited) {
    usable = dataSeq === null;
    score -= dataSeq === null ? 60 : 100;
    notes.push({ level: dataSeq === null ? "warning" : "error", text: "This basis set is for edited (MEGA-PRESS) difference spectra." });
  } else if (dataSeq && basisSeq) {
    if (dataSeq !== basisSeq) {
      const similar = similarFamilies(dataSeq, basisSeq);
      score -= similar ? 15 : 35;
      notes.push({ level: "warning", text: `Basis is ${basisSeq}; the data are ${dataSeq}.` });
    }
  } else if (!dataSeq) {
    score -= 10;
    notes.push({ level: "info", text: "The sequence type could not be read from the data." });
  }
  if (data.teMs > 0 && basis.teMs > 0) {
    const dte = Math.abs(data.teMs - basis.teMs);
    if (dte > TE_POOR) {
      score -= 45;
      notes.push({ level: "warning", text: `TE ${fmt(basis.teMs)} ms vs ${fmt(data.teMs)} ms: coupled metabolites will be biased.` });
    } else if (dte > TE_OK) {
      score -= 25;
      notes.push({ level: "warning", text: `TE ${fmt(basis.teMs)} ms vs ${fmt(data.teMs)} ms.` });
    } else if (dte > TE_CLOSE) {
      score -= 8;
      notes.push({ level: "info", text: `TE differs by ${fmt(dte)} ms.` });
    }
  } else {
    score -= 10;
    notes.push({ level: "info", text: "The echo time could not be read from the data." });
  }
  const level = !usable ? "error" : notes.some((n) => n.level === "warning") ? "warning" : "match";
  return { id: basis.id, usable, score, level, notes };
}

// Rank all basis sets; best first. Unusable ones stay in the list, last.
export function rankBases(data, bases) {
  return bases
    .map((basis) => ({ basis, ...assessBasis(data, basis) }))
    .sort((a, b) => (b.usable - a.usable) || (b.score - a.score) || a.basis.id.localeCompare(b.basis.id));
}

// The basis to preselect, or null when none is usable.
export function recommendBasis(data, bases) {
  const [best] = rankBases(data, bases);
  return best?.usable ? best : null;
}

// Header of a user-supplied .BASIS file: HZPPPM, ECHOT and SEQ from
// NAMELIST SEQPAR, and the metabolite names.
export function parseBasisHeader(text) {
  const head = text.slice(0, 1 << 16);
  const num = (name) => {
    const m = head.match(new RegExp(`\\b${name}\\s*=\\s*([-+0-9.eEdD]+)`, "i"));
    return m ? Number(m[1].replace(/[dD]/, "e")) : null;
  };
  const str = (name) => {
    const m = head.match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`, "i"));
    return m ? m[1].trim() : null;
  };
  const metabolites = [...text.matchAll(/\bMETABO\s*=\s*['"]([^'"]+)['"]/gi)].map((m) => m[1].trim());
  return {
    hzpppm: num("HZPPPM"),
    teMs: num("ECHOT"),
    sequence: str("SEQ"),
    id: str("IDBASI"),
    metabolites,
  };
}

function fieldLabel(hzpppm) {
  return `${(hzpppm / 42.577).toFixed(1)} T`;
}

function fmt(x) {
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}
