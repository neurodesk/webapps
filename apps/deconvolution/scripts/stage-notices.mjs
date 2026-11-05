// Stage the licence notices of the code this app bundles into public/licenses/, so dev,
// preview and the deployed site serve them beside the WebAssembly module they cover.
import { copyFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(app, "package.json"));

/** Copies the notices into `out` and returns their file names there. */
export async function stageNotices(out = join(app, "public", "licenses")) {
  await mkdir(out, { recursive: true });
  const deconvolution = dirname(require.resolve("@neurodesk/deconvolution/package.json"));
  // The components package exports no package.json either; it is linked into the app's node_modules.
  const components = await realpath(join(app, "node_modules", "@neurodesk", "webapp-components"));
  // geotiff (the shared TIFF reader's decoder) exports no package.json; its directory sits in the
  // components package's node_modules.
  const geotiff = join(components, "node_modules", "geotiff");
  const files = [
    [join(deconvolution, "LICENSE"), "deconvolution-LICENSE.txt"],
    [join(deconvolution, "NOTICE"), "deconvolution-NOTICE.txt"],
    [join(deconvolution, "THIRD_PARTY_NOTICES.md"), "deconvolution-THIRD_PARTY_NOTICES.md"],
    [join(geotiff, "LICENSE"), "geotiff-LICENSE.txt"],
  ];
  for (const [from, name] of files) await copyFile(from, join(out, name));
  return files.map(([, name]) => name);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const names = await stageNotices();
  console.log(`staged ${names.length} licence files in public/licenses/`);
}
