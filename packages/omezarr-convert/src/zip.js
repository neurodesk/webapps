// A written store as one archive, assembled entry by entry into Blob parts with fflate's
// streaming Zip, so no second contiguous copy of the store is made and the page thread is
// handed back between entries. Entries are stored (no ZIP compression) with a fixed 1980-01-01
// time. NGFF 0.5 (Zarr v3) is an RFC-9 .ozx: zarr.json files first, breadth first (ngff-zarr's
// orderFilesForRfc9), and the OME version in the zip comment. NGFF 0.4 (Zarr v2) is a zip of
// the store root, metadata first, which zarr-python's ZipStore reads.
// fflate writes no ZIP64 records, so an archive holds at most 65 535 entries and 4 GiB.
import { orderFilesForRfc9 } from "@fideus-labs/ngff-zarr";
import { Zip, ZipPassThrough } from "fflate";
import { pacer } from "./pacing.js";

export const ZIP_MAX_ENTRIES = 65535;
const MTIME = new Date(1980, 0, 1);
const RFC9_COMMENT = JSON.stringify({ ome: { version: "0.5", zipFile: { centralDirectory: { jsonFirst: true } } } });

const metadataFirst = (a, b) => {
  const meta = (key) => (/(^|\/)\.z(group|attrs|array)$/.test(key) ? 0 : 1);
  return meta(a) - meta(b) || a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0);
};

// fflate ends the archive with the central directory and a comment-less end record (22 bytes).
function withComment(end, comment) {
  const text = new TextEncoder().encode(comment);
  const out = new Uint8Array(end.length + text.length);
  out.set(end);
  out.set(text, end.length);
  new DataView(out.buffer).setUint16(end.length - 2, text.length, true);
  return out;
}

/** The archive of a store held in a Map (relative keys), as a Blob. */
export async function zipStore(store, version, { signal } = {}) {
  const keys = version === "0.5" ? orderFilesForRfc9([...store.keys()]) : [...store.keys()].sort(metadataFirst);
  if (keys.length > ZIP_MAX_ENTRIES) throw new Error(`The store has ${keys.length} files; a zip archive holds at most ${ZIP_MAX_ENTRIES}. Write it to a folder instead.`);
  const parts = [];
  let failure = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else parts.push(chunk);
  });
  const pace = pacer(signal);
  for (const key of keys) {
    const entry = new ZipPassThrough(key);
    entry.mtime = MTIME;
    zip.add(entry);
    entry.push(store.get(key), true);
    if (failure) throw failure;
    await pace();
  }
  zip.end();
  if (failure) throw failure;
  if (version === "0.5") parts.push(withComment(parts.pop(), RFC9_COMMENT));
  return new Blob(parts, { type: "application/zip" });
}

/** The archive's file name: `<stem>.ozx` for 0.5, `<stem>.ome.zarr.zip` for 0.4. */
export function archiveName(stem, version) {
  return version === "0.5" ? `${stem}.ozx` : `${stem}.ome.zarr.zip`;
}
