// A written store as one archive. NGFF 0.5 (Zarr v3) becomes an RFC-9 .ozx through ngff-zarr's
// storeToZip: zarr.json files first, entries stored, the version in the zip comment. NGFF 0.4
// (Zarr v2) becomes a stored zip of the store root, which zarr-python's ZipStore reads.
import { storeToZip } from "@fideus-labs/ngff-zarr";
import { zipSync } from "fflate";

const metadataFirst = (a, b) => {
  const meta = (key) => (/(^|\/)\.z(group|attrs|array)$/.test(key) ? 0 : 1);
  return meta(a) - meta(b) || a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0);
};

/** The archive bytes of a store held in a Map (relative keys). */
export function zipStore(store, version) {
  if (version === "0.5") return storeToZip(store);
  const files = {};
  for (const key of [...store.keys()].sort(metadataFirst)) files[key] = store.get(key);
  return zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) });
}

/** The archive's file name: `<stem>.ozx` for 0.5, `<stem>.ome.zarr.zip` for 0.4. */
export function archiveName(stem, version) {
  return version === "0.5" ? `${stem}.ozx` : `${stem}.ome.zarr.zip`;
}
