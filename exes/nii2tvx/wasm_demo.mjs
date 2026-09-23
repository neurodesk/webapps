// node wasm_demo.mjs lesion.nii[.gz] atlas.tvx   (build first: make wasm)
// Prints the same TSV as the native tool. Shows the whole WASM surface.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename } from "node:path";
import createModule from "./nii2tvx.mjs";

// C's printf("%g") for a float, default precision 6. Number(f.toPrecision(6)) is not the
// same function: it prints NaN as "NaN", keeps 3.24086e-05 as 0.0000324086, and writes
// exponents as 1e-7 rather than 1e-07, so its TSV would not match the native tool's.
function formatG(x) {
	if (Number.isNaN(x)) return "nan";
	if (x === 0) return "0";
	if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
	const exponent = Number(x.toExponential(5).split("e")[1]);
	const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
	if (exponent < -4 || exponent >= 6) {
		const [mantissa, e] = x.toExponential(5).split("e");
		return `${strip(mantissa)}e${e.startsWith("-") ? "-" : "+"}${e.replace(/^[-+]/, "").padStart(2, "0")}`;
	}
	return strip(x.toFixed(Math.max(0, 5 - exponent)));
}

const [lesionPath, tvxPath] = process.argv.slice(2);
const M = await createModule();

function toHeap(bytes) { // copy a Node buffer into WASM memory; caller frees
	const ptr = M._malloc(bytes.length);
	if (!ptr) throw new Error(`Out of memory allocating ${bytes.length} bytes.`);
	M.HEAPU8.set(bytes, ptr);
	return ptr;
}

const tvxBytes = readFileSync(tvxPath);
const tvx = M._tvx_open(toHeap(tvxBytes), tvxBytes.length); // tvx_open owns the buffer
if (!tvx) process.exit(1);
const ntract = M._tvx_ntract(tvx);
const names = Array.from({ length: ntract }, (_, k) => M.UTF8ToString(M._tvx_name(tvx, k)));

let nii = readFileSync(lesionPath);
if (nii[0] === 0x1f && nii[1] === 0x8b) nii = gunzipSync(nii); // mask_open wants uncompressed NIfTI
const niiPtr = toHeap(nii);
const mask = M._mask_open(niiPtr, nii.length);
M._free(niiPtr);
if (!mask) process.exit(1);

const fracs = [];
for (let k = 0; k < ntract; k++) {
	const f = M._tvx_query(tvx, k, mask);
	if (f < 0) process.exit(1); // grid mismatch or corrupt file; reason was printed to stderr
	fracs.push(f);
}
M._mask_close(mask);
M._tvx_close(tvx);

console.log(["id", ...names].join("\t"));
console.log([basename(lesionPath).replace(/\.nii(\.gz)?$/, ""), ...fracs.map(formatG)].join("\t"));
