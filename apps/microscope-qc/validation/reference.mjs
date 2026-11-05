// Records test/fixtures/metroloj-reference.json: ImageJ and MetroloJ_QC numbers for the bead
// example, the small synthetic bead stack and the small synthetic field image, computed in Fiji
// by metroloj_reference.groovy (Docker fiji/fiji with the MetroloJ_QC 1.3.1.2 jar).
//
// usage: node validation/reference.mjs <examples-dir> <MetroloJ_QC.jar> <scratch-dir>
//   <examples-dir> holds evos-40x-na095-tetraspeck-100nm.ome.tif and
//   synthetic-field-illumination.ome.tif from examples.json (checked against their SHA-256).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { analyseBeads } from "../src/core/psf.js";
import { omeOptics, theoreticalResolution } from "../src/core/optics.js";
import { boxHalfWidth } from "../src/config.js";
import { smallBeads, smallField } from "../test/synthetic.js";

const [examplesDir, jar, scratchArg] = process.argv.slice(2);
if (!scratchArg) throw new Error("usage: node validation/reference.mjs <examples-dir> <MetroloJ_QC.jar> <scratch-dir>");
const scratch = resolve(scratchArg);
await mkdir(scratch, { recursive: true });
const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const here = new URL(".", import.meta.url).pathname;

async function example(name) {
  const file = examples.flatMap((e) => e.files).find((f) => f.name === name);
  const bytes = await readFile(join(examplesDir, name));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${name}: SHA-256 differs from examples.json`);
  await copyFile(join(examplesDir, name), join(scratch, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function fiji({ stack, centres, halfBox, prominence, px, pz, field = "none", out }) {
  const args = `stack=/w/${stack},centres=/w/${centres},halfBox=${halfBox},prominence=${prominence},px=${px},pz=${pz},field=${field === "none" ? "none" : `/w/${field}`},out=/w/${out}`;
  execFileSync("docker", [
    "run", "--rm", "-v", `${scratch}:/w`, "-v", `${resolve(jar)}:/opt/fiji/Fiji.app/plugins/MetroloJ_QC.jar:ro`, "-v", `${here}:/v:ro`,
    "fiji/fiji:latest", "ImageJ-linux64", "--headless", "--console", "--run", "/v/metroloj_reference.groovy", `args="${args}"`,
  ], { stdio: "inherit", timeout: 600000 });
}

async function parse(name) {
  const lines = (await readFile(join(scratch, name), "utf8")).trim().split("\n").map((line) => line.split(","));
  const beads = new Map();
  for (const [kind, id, ...rest] of lines) {
    if (kind === "bead") {
      const [x, y, z, fx, rx, fy, ry, fz, rz] = rest.map(Number);
      beads.set(Number(id), { ...beads.get(Number(id)), id: Number(id), x, y, z, fwhm: { x: fx, y: fy, z: fz }, r2: { x: rx, y: ry, z: rz } });
    }
    if (kind === "profile") {
      const bead = beads.get(Number(id)) ?? { id: Number(id), profiles: {} };
      bead.profiles = { ...bead.profiles, [rest[0]]: rest.slice(1).map(Number) };
      beads.set(Number(id), bead);
    }
  }
  const field = lines.find((l) => l[0] === "field");
  return {
    maxima: lines.filter((l) => l[0] === "maximum").map(([, x, y]) => [Number(x), Number(y)]),
    beads: [...beads.values()],
    field: field && { uniformity: Number(field[1]), fieldUniformity: Number(field[2]), centeringAccuracy: Number(field[3]), min: Number(field[4]), max: Number(field[5]), reference: { x: Number(field[6]), y: Number(field[7]) } },
    blurred: lines.find((l) => l[0] === "blurred")?.slice(1).map(Number),
  };
}

async function centresFor(name, beads) {
  await writeFile(join(scratch, name), `id,x,y\n${beads.map((b) => `${b.id},${b.peakX},${b.peakY}`).join("\n")}\n`);
  return name;
}

// The bead example with the app's defaults for its header.
const beadsName = "evos-40x-na095-tetraspeck-100nm.ome.tif";
const stack = await readTiffStack(await example(beadsName));
const optics = omeOptics(stack.metadata.description);
const theory = theoreticalResolution({ type: "widefield", ...optics });
const spacing = stack.metadata.pixelSize;
const halfBox = boxHalfWidth({ theory, pixelX: spacing.x, pixelY: spacing.y, boxRadius: null });
const app = analyseBeads(Float32Array.from(stack.data), { nx: stack.width, ny: stack.height, nz: stack.pages, spacing }, { halfBox, minR2: 0.95, saturation: 255 });
const fieldName = "synthetic-field-illumination.ome.tif";
await example(fieldName);
fiji({ stack: beadsName, centres: await centresFor("example-centres.csv", app.beads.filter((b) => b.fits)), halfBox, prominence: app.prominence, px: spacing.x, pz: spacing.z, field: fieldName, out: "example.csv" });
const exampleRef = await parse("example.csv");

// The small synthetic stack and field image.
const small = smallBeads();
await writeFile(join(scratch, "small-beads.tif"), writeTiffStack({ width: small.nx, height: small.ny, data: small.data }));
const smallApp = analyseBeads(Float32Array.from(small.data), small, { halfBox: 6, prominence: 100, minR2: 0.95, saturation: 65535 });
const field = smallField();
await writeFile(join(scratch, "small-field.tif"), writeTiffStack({ width: field.width, height: field.height, data: field.data }));
fiji({ stack: "small-beads.tif", centres: await centresFor("small-centres.csv", smallApp.beads.filter((b) => b.fits)), halfBox: 6, prominence: 100, px: small.spacing.x, pz: small.spacing.z, field: "small-field.tif", out: "small.csv" });
const smallRef = await parse("small.csv");

const fixture = {
  source: "validation/reference.mjs: Fiji (fiji/fiji:latest, ImageJ 1.53q) headless with MetroloJ_QC 1.3.1.2; profiles and fits from MetroloJ_QC's CurveFitterPlus, maxima from ImageJ's MaximumFinder (strict, edges kept), blur from ImageJ's GaussianBlur",
  example: {
    file: beadsName,
    halfBox,
    prominence: app.prominence,
    theory,
    maxima: exampleRef.maxima,
    beads: exampleRef.beads,
    app: { maximaCount: app.maximaCount, used: app.beads.filter((b) => !b.rejection && b.goodFit).map((b) => b.id) },
    field: { file: fieldName, ...exampleRef.field },
  },
  small: { halfBox: 6, prominence: 100, maxima: smallRef.maxima, beads: smallRef.beads.map(({ profiles: _p, ...b }) => b), field: smallRef.field, blurred: smallRef.blurred },
};
await writeFile(new URL("../test/fixtures/metroloj-reference.json", import.meta.url), `${JSON.stringify(fixture)}\n`);
console.log(`example: ${exampleRef.maxima.length} ImageJ maxima, ${exampleRef.beads.length} beads; small: ${smallRef.maxima.length} maxima`);
