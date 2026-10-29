// Records e2e/expected.json: native ANTs DenoiseImage on the pinned example, one ITK thread, in
// the Neurodesk ANTs container the Standalone dialog lists. e2e/smoke.spec.js holds the web
// app's downloads to these bytes. Rerun after a change to the module, the example or a case.
//
//   node apps/ants-denoise/scripts/native-reference.mjs   (needs Docker)
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denoiseArguments } from "@neurodesk/ants-denoise";
import { exampleBytes, exampleFile, nonzeroMask, sha256 } from "../e2e/fixtures.mjs";

const containers = JSON.parse(await readFile(new URL("../../../registry/neurocontainers.json", import.meta.url), "utf8"));
const IMAGE = containers.containers.ants.image;
const DENOISE_IMAGE = "/opt/ants-2.6.5/bin/DenoiseImage";

const CASES = [
  { id: "default", settings: { noiseModel: "Gaussian", patchRadius: 1, searchRadius: 2 }, mask: null },
  { id: "rician-nonzero-mask", settings: { noiseModel: "Rician", patchRadius: 1, searchRadius: 2 }, mask: "nonzero" },
];

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "ants-denoise-native-"));
try {
  await writeFile(join(work, exampleFile.name), await exampleBytes());
  await writeFile(join(work, "mask.nii.gz"), nonzeroMask(await readFile(join(work, exampleFile.name))));
  const cases = [];
  for (const { id, settings, mask } of CASES) {
    const output = `${id}.nii`;
    const argv = denoiseArguments({ input: `/w/${exampleFile.name}`, output: `/w/${output}`, mask: mask ? "/w/mask.nii.gz" : null, ...settings });
    execFileSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid()}:${process.getgid()}`,
      "-e", "ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1", "-v", `${work}:/w`, "--entrypoint", DENOISE_IMAGE, IMAGE, ...argv], { stdio: "inherit" });
    cases.push({ id, settings, mask, sha256: sha256(await readFile(join(work, output))) });
  }
  const reference = {
    note: "SHA-256 of the uncompressed NIfTI that native ANTs 2.6.5 DenoiseImage writes on the example with one ITK thread; recorded by scripts/native-reference.mjs.",
    container: IMAGE,
    example: { name: exampleFile.name, sha256: exampleFile.sha256 },
    cases,
  };
  await writeFile(new URL("../e2e/expected.json", import.meta.url), `${JSON.stringify(reference, null, 2)}\n`);
  console.log(JSON.stringify(cases, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
