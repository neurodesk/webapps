// Pure input handling (no DOM): pair echo images with BIDS sidecars, order them by echo time,
// pick an external-regressors TSV and read the echo-time field. Unit-tested in test/inputs.test.js.

const NIFTI = /\.nii(\.gz)?$/i;
const stem = (name) => name.replace(NIFTI, "").replace(/\.json$/i, "");
const natural = new Intl.Collator(undefined, { numeric: true }).compare;

/** Milliseconds as typed, without binary noise (0.03532 s → 35.32). */
export const formatMs = (seconds) => String(Number((seconds * 1000).toPrecision(12)));

/** fMRIPrep/BIDS confounds, the regressors file tedana's --external usually gets. */
const CONFOUNDS = /_desc-confounds_timeseries\.tsv$/i;

/**
 * Echo images and their EchoTime from same-named JSON sidecars. `readText(file)` resolves to the
 * sidecar text. Echoes are sorted by echo time when every sidecar gives one, else by name. The
 * regressors are a `*_desc-confounds_timeseries.tsv`, else the only TSV that is not `*_events.tsv`.
 */
export async function groupEchoes(files, readText = (f) => f.text()) {
  const images = files.filter((f) => NIFTI.test(f.name));
  const sidecars = new Map(files.filter((f) => /\.json$/i.test(f.name)).map((f) => [stem(f.name), f]));
  const tables = files.filter((f) => /\.tsv$/i.test(f.name) && !/(^|_)events\.tsv$/i.test(f.name));
  const regressors = tables.find((f) => CONFOUNDS.test(f.name)) ?? (tables.length === 1 ? tables[0] : null);
  const ignored = files.filter((f) => !NIFTI.test(f.name) && !/\.json$/i.test(f.name) && f !== regressors).map((f) => f.name);
  const echoes = [];
  for (const file of images) {
    const sidecar = sidecars.get(stem(file.name));
    let te = null;
    if (sidecar) {
      const meta = JSON.parse(await readText(sidecar));
      if (typeof meta.EchoTime === "number" && meta.EchoTime > 0) te = meta.EchoTime;
    }
    echoes.push({ file, te });
  }
  const known = echoes.length > 0 && echoes.every((e) => e.te !== null);
  echoes.sort(known ? (a, b) => a.te - b.te : (a, b) => natural(a.file.name, b.file.name));
  return { echoes, echoTimes: known ? echoes.map((e) => formatMs(e.te)).join(" ") : "", regressors, ignored };
}

/** Echo times from the field: numbers separated by spaces or commas, ascending. */
export function parseEchoTimes(text, count) {
  const values = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error("Echo times must be positive numbers.");
  if (values.length !== count) throw new Error(`Give ${count} echo times, one per echo (${values.length} given).`);
  if (values.some((v, i) => i > 0 && v <= values[i - 1])) throw new Error("Echo times must increase in echo order.");
  return values;
}
