import { rm } from "node:fs/promises";
// The source NIfTI is pinned for provenance only; the game reads derived assets.
await rm(new URL("../dist/data/source.nii.gz", import.meta.url), {
  force: true,
});
