// Sorting dropped files. LCModel's own text files are recognised here:
// .RAW/.H2O spectra (already preprocessed: they go straight to LCModel),
// .BASIS basis sets and LCMODL control files (acquisition numbers). Every
// other file goes to the FID-A readers. Pure, Node-tested.

const TEXT_SNIFF = 4096;

/** What an LCModel text file is, from its first few kilobytes. */
export function classifyText(head) {
  const text = head.toUpperCase();
  if (/[$&]BASIS1\b/.test(text)) return "basis";
  if (/[$&]LCMODL\b/.test(text)) return "control";
  if (/[$&]NMID\b/.test(text)) return "raw";
  return null;
}

function namelistNumber(text, name) {
  const m = text.match(new RegExp(`\\b${name}\\s*=\\s*([-+0-9.eEdD]+)`, "i"));
  if (!m) return null;
  const value = Number(m[1].replace(/[dD]/, "e"));
  return Number.isFinite(value) ? value : null;
}

/** Acquisition numbers an LCMODL control file sets. */
export function parseControl(text) {
  return {
    hzpppm: namelistNumber(text, "hzpppm"),
    deltat: namelistNumber(text, "deltat"),
    nunfil: namelistNumber(text, "nunfil"),
    teMs: namelistNumber(text, "echot"),
  };
}

/** The numbers after a .RAW/.H2O file's $NMID block: real and imaginary parts, interleaved. */
export function rawValues(text) {
  const nmid = text.search(/[$&]NMID\b/i);
  if (nmid < 0) throw new Error("Not an LCModel .RAW file (no $NMID).");
  const after = text.slice(nmid);
  const close = after.search(/[$&]END\b/i);
  if (close < 0) throw new Error("The $NMID block of this .RAW file is not closed.");
  const body = after.slice(close).split(/\r?\n/).slice(1).join("\n");
  return body.trim().split(/\s+/).map((t) => Number(t.replace(/[dD]/, "e"))).filter(Number.isFinite);
}

/**
 * An LCModel .RAW/.H2O file: its point count (values after $NMID ... $END),
 * and any acquisition numbers in an optional $SEQPAR block (FID-A and spec2nii
 * write hzpppm, echot and dwellTime there).
 */
export function parseRaw(text) {
  const values = rawValues(text);
  const head = text.slice(0, text.search(/[$&]NMID\b/i));
  const seqpar = /[$&]SEQPAR\b/i.test(head) ? head : "";
  const dwell = namelistNumber(seqpar, "dwellTime") ?? namelistNumber(seqpar, "deltat");
  return {
    points: Math.floor(values.length / 2),
    hzpppm: namelistNumber(seqpar, "hzpppm"),
    teMs: namelistNumber(seqpar, "echot"),
    deltat: dwell,
    sequence: (seqpar.match(/\bseq\s*=\s*['"]([^'"]*)['"]/i) ?? [])[1] ?? null,
  };
}

/** True when `name` looks like the water half of a .RAW/.H2O pair. */
function isWaterName(name) {
  return /\.h2o$/i.test(name) || /(^|[_.-])(w|water|h2o|ref|unsup)([_.-]|$)/i.test(name.replace(/\.raw$/i, ""));
}

/**
 * Split files into LCModel text inputs and files for FID-A.
 * @param {{name: string, head: string}[]} files  `head` is the first 4 kB as text
 *   (empty for binary files).
 */
export function sortInputs(files) {
  const out = { raw: [], water: [], basis: [], control: [], other: [] };
  for (const file of files) {
    const kind = classifyText(file.head.slice(0, TEXT_SNIFF));
    if (kind === "raw") (isWaterName(file.name) ? out.water : out.raw).push(file);
    else if (kind === "basis") out.basis.push(file);
    else if (kind === "control") out.control.push(file);
    else out.other.push(file);
  }
  return out;
}

/** The first 4 kB of a file as text, or "" if it is binary. */
export function textHead(bytes) {
  const slice = bytes.subarray(0, TEXT_SNIFF);
  let control = 0;
  for (const b of slice) if (b === 0 || (b < 9)) control += 1;
  if (control > 4) return "";
  return new TextDecoder("latin1").decode(slice);
}
