// Stage the ITK-Wasm pipelines the app calls into public/pipelines/, so the
// build ships them and nothing is fetched from the jsDelivr default. The
// loader fetches <name>.wasm.zst and imports <name>.js; plain .wasm is unused.
// image-io is staged whole: readImage tries every format when an extension
// is unknown, and one missing pipeline would end that search.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
const target = new URL("../public/pipelines/", import.meta.url);
const packages = {
  "@itk-wasm/elastix": ["default-parameter-map", "elastix", "read-parameter-files", "write-parameter-files"],
  "@itk-wasm/image-io": null,
  "@itk-wasm/transform-io": ["hdf5-write-transform"],
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const [name, pipelines] of Object.entries(packages)) {
  // The packages export no package.json; every entry point sits in dist/.
  const source = new URL("pipelines/", import.meta.resolve(name));
  for (const file of await readdir(source)) {
    if (!/\.(js|wasm\.zst)$/.test(file)) continue;
    if (pipelines && !pipelines.includes(file.replace(/\.(js|wasm\.zst)$/, ""))) continue;
    await cp(new URL(file, source), new URL(file, target));
  }
}
