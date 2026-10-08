// The web app's results on its examples, which the command line must reproduce
// byte for byte. apps/lcmodel/e2e/reference.spec.js runs each case through the
// built app (automation, worker, served WebAssembly and basis sets) and records
// a digest of every download in browser-reference.json; cli-check.mjs runs the
// packaged command line on the same files and compares.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const examples = JSON.parse(await readFile(new URL("../../../apps/lcmodel/examples.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../../../registry/offline-assets.lock.json", import.meta.url), "utf8"));
const referenceUrl = new URL("./browser-reference.json", import.meta.url);

/**
 * Every bundled example with the app's defaults, and the options a user can
 * set, each on an example where it changes the result. `parameters` are the
 * automation parameters; the command line gets them as options.
 */
export const CASES = Object.freeze([
  { id: "ge-press-phantom", example: "ge-press-phantom", operation: "fit", parameters: {} },
  {
    id: "ge-press-phantom-options",
    example: "ge-press-phantom",
    operation: "fit",
    parameters: { basisSet: "press-3t-te35", removeBadAverages: false, driftCorrection: false, waterScaling: false, ppmStart: 3.9, ppmEnd: 0.4 },
  },
  {
    id: "ge-press-phantom-preprocessing",
    example: "ge-press-phantom",
    operation: "fit",
    parameters: { badAverageSd: 2, phaseAndReference: false, eddyCurrentCorrection: false, lineBroadening: "lcmodel" },
  },
  { id: "philips-press-tissue", example: "philips-press-t1", operation: "fit", parameters: { fractionGM: 0.6, fractionWM: 0.27, fractionCSF: 0.13 } },
  { id: "philips-press-tissue-water-only", example: "philips-press-t1", operation: "fit", parameters: { fractionGM: 0.6, fractionWM: 0.27, fractionCSF: 0.13, metaboliteRelaxation: false } },
  { id: "siemens-special", example: "siemens-special", operation: "fit", parameters: {} },
  { id: "siemens-megapress", example: "siemens-megapress", operation: "fit", parameters: {} },
  { id: "philips-megapress", example: "philips-megapress", operation: "fit", parameters: {} },
  { id: "philips-megapress-none", example: "philips-megapress", operation: "fit", parameters: { macromoleculeModel: "none" } },
  { id: "philips-megapress-unedited", example: "philips-megapress", operation: "fit", parameters: { edited: false } },
  { id: "philips-press-group", example: "philips-press-group", operation: "fit-group", parameters: {} },
  { id: "nifti-mrs-press", example: "nifti-mrs-press", operation: "fit", parameters: {} },
  { id: "lcmodel-test", example: "lcmodel-test", operation: "fit", parameters: { lineBroadening: "lcmodel" } },
  { id: "lcmodel-test-widened", example: "lcmodel-test", operation: "fit", parameters: { frequencyMHz: 127.786142, dwellTimeMs: 0.5 } },
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The example's files a case uses (the T1 is left out: the command line takes
 * entered fractions), downloaded once into the system temporary directory and
 * checked against registry/offline-assets.lock.json.
 * @returns {Promise<{role: string, name: string, path: string}[]>}
 */
export async function exampleFiles(exampleId) {
  const example = examples.find((e) => e.id === exampleId);
  if (!example) throw new Error(`No example ${exampleId} in apps/lcmodel/examples.json`);
  const files = [];
  for (const file of example.files.filter((f) => f.role !== "t1")) {
    const pin = lock.assets[file.url];
    if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
    const path = join(tmpdir(), "neurodesk-lcmodel-validation", pin.sha256, file.name);
    const cached = await readFile(path).catch(() => null);
    if (!cached || sha256(cached) !== pin.sha256) {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(`${path}.partial`, bytes);
      await rename(`${path}.partial`, path);
    }
    files.push({ role: file.role, name: file.name, path });
  }
  return files;
}

/** The command line's arguments for a case's parameters, one option per automation parameter. */
export function cliArguments(parameters) {
  const option = (key) => `--${key.replace(/[A-Z]+/g, (letters) => `-${letters.toLowerCase()}`)}`;
  return Object.entries(parameters).flatMap(([key, value]) => {
    if (value === true) return [option(key)];
    if (value === false) return [`--no-${option(key).slice(2)}`];
    return [option(key), String(value)];
  });
}

// The report's one line that names the program and when it ran.
const REPORT_META = /^<p class="meta">.*<\/p>$/m;

/**
 * Digests of a run's files: SHA-256 of each file's bytes, except that a
 * report's program-and-time line is left out.
 * @param {Map<string, Buffer>} files
 */
export function summarize(files) {
  const digests = {};
  for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    digests[name] = /_report\.html$/.test(name) ? sha256(bytes.toString("utf8").replace(REPORT_META, "")) : sha256(bytes);
  }
  return digests;
}

// The tissue correction's inputs print every double in full, and Chromium's and
// Node's JavaScript engines differ in the last bit of a few exp() results
// (PE's corrected concentration in philips-press-tissue differs by 1.2e-16
// relative). These files are kept whole and compared number by number.
const FULL_PRECISION = /_tissue_correction\.json$/;
const RELATIVE_TOLERANCE = 1e-12;

/** The full-precision JSON files of a run, parsed. */
export function documents(files) {
  return Object.fromEntries([...files].filter(([name]) => FULL_PRECISION.test(name)).map(([name, bytes]) => [name, JSON.parse(bytes.toString("utf8"))]));
}

/** The largest relative difference between two JSON values, or Infinity when they differ in anything but rounding. */
function largestDifference(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? 0 : Infinity;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (Array.isArray(a) !== Array.isArray(b) || Object.keys(a).length !== keys.size || Object.keys(b).length !== keys.size) return Infinity;
  return Math.max(0, ...[...keys].map((key) => largestDifference(a[key], b[key])));
}

/** Every file in a directory. */
export async function readOutputs(directory) {
  const files = new Map();
  for (const name of (await readdir(directory)).sort()) files.set(name, await readFile(join(directory, name)));
  return files;
}

/** The lines of the concentration tables that name a primary metabolite, to show what differs. */
export function headline(files) {
  const primary = /^(?:[^,]*,)?(?:[^,]*,){0,1}(NAA\+NAAG|Cr\+PCr|GPC\+PCh|Ins|Glu\+Gln|GABA\+MM3co|GABA|MM3co),/;
  const lines = {};
  for (const [name, bytes] of files) {
    if (!/(_concentrations|_group)\.csv$/.test(name)) continue;
    lines[name] = bytes.toString("utf8").split("\n").filter((line) => primary.test(line));
  }
  return lines;
}

/**
 * Checks of a run against the browser's, as [passed, line] pairs. A group run
 * of the command line also writes each dataset's own files, which the app's
 * fit-group operation does not return; those are listed, not compared.
 */
export function compare(caseId, actual, expected) {
  const checks = [];
  for (const [name, digest] of Object.entries(expected.files)) {
    if (!(name in actual.files)) {
      checks.push([false, `${caseId}: ${name} missing (the web app wrote it)`]);
    } else if (actual.files[name] === digest) {
      checks.push([true, `${caseId}: ${name} identical to the web app's`]);
    } else if (expected.documents?.[name] && actual.documents?.[name]) {
      const largest = largestDifference(actual.documents[name], expected.documents[name]);
      checks.push([largest <= RELATIVE_TOLERANCE, `${caseId}: ${name} equal to the web app's to ${largest.toPrecision(2)} relative (limit ${RELATIVE_TOLERANCE}, the last bit of a double)`]);
    } else {
      checks.push([false, `${caseId}: ${name} differs from the web app's`]);
    }
  }
  const extra = Object.keys(actual.files).filter((name) => !(name in expected.files));
  const group = CASES.find((c) => c.id === caseId)?.operation === "fit-group";
  if (extra.length) checks.push([group, `${caseId}: ${group ? "per-dataset files the group operation does not return" : "files the web app did not write"}: ${extra.join(", ")}`]);
  for (const [name, lines] of Object.entries(expected.headline ?? {})) {
    if (JSON.stringify(actual.headline?.[name]) === JSON.stringify(lines)) continue;
    checks.push([false, `${caseId}: ${name} web app ${JSON.stringify(lines)}, command line ${JSON.stringify(actual.headline?.[name] ?? null)}`]);
  }
  return checks;
}

export async function readReference() {
  return JSON.parse(await readFile(referenceUrl, "utf8"));
}

export async function writeReference(reference) {
  await writeFile(referenceUrl, `${JSON.stringify(reference, null, 2)}\n`);
}
