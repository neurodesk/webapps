// Stage the licence notices of the code this app bundles into public/licenses/, so dev,
// preview and the deployed site serve them beside the WebAssembly module they cover.
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(app, "package.json"));
const out = join(app, "public", "licenses");
await mkdir(out, { recursive: true });
const deconvolution = dirname(require.resolve("@neurodesk/deconvolution/package.json"));
const tiff = dirname(require.resolve("@neurodesk/microscopy-tiff/package.json"));
// geotiff exports no package.json; its directory sits in the TIFF package's node_modules.
const geotiff = join(tiff, "node_modules", "geotiff");
const files = [
  [join(deconvolution, "LICENSE"), "deconvolution-LICENSE.txt"],
  [join(deconvolution, "NOTICE"), "deconvolution-NOTICE.txt"],
  [join(tiff, "LICENSE"), "microscopy-tiff-LICENSE.txt"],
  [join(geotiff, "LICENSE"), "geotiff-LICENSE.txt"],
];
for (const [from, name] of files) await copyFile(from, join(out, name));
console.log(`staged ${files.length} licence files in public/licenses/`);
