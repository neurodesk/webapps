#!/usr/bin/env node
import { parseArgs } from "node:util";
import { correctFiles, prepareModels, checkInstallation } from "../src/node.js";
import metadata from "../package.json" with { type: "json" };

const HELP = `hmc DWI.nii.gz DWI.bval DWI.bvec OUTPUT [options]

  --method gp|trivial  Estimator (default: gp)
  --mask FILE         Brain mask on the DWI grid (default: MindGrab CPU mean-b0)
  --sidecar FILE      Input JSON metadata to preserve
  --seed INTEGER      Registration and visit-order seed (default: 1234)
  --workers INTEGER   Concurrent registration workers (default: 1)
  --version           Print package version
  --help              Print this help

hmc self-check         Verify the bundled registration resampler
hmc download-models    Initialize the bundled CPU mask runtime

Validated scope and known differences: packages/hmc/README.md.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    method: { type: "string", default: "gp" }, mask: { type: "string" }, sidecar: { type: "string" },
    seed: { type: "string", default: "1234" }, workers: { type: "string", default: "1" },
    help: { type: "boolean" }, version: { type: "boolean" },
    "cache-dir": { type: "string" },
  } });
  if (values["cache-dir"] && positionals[0] !== "download-models") throw new Error("--cache-dir applies to download-models only.");
  if (values.help) process.stdout.write(HELP);
  else if (values.version) console.log(metadata.version);
  else if (positionals.length === 1 && positionals[0] === "self-check") console.log(JSON.stringify(await checkInstallation()));
  else if (positionals.length === 1 && positionals[0] === "download-models") {
    await prepareModels();
    console.log("Pinned MindGrab CPU runtime ready; models are bundled.");
  }
  else {
    if (positionals.length !== 4) throw new Error(HELP);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const [dwi, bval, bvec, output] = positionals;
      const result = await correctFiles({ dwi, bval, bvec, output, maskFile: values.mask, sidecarFile: values.sidecar,
        method: values.method, seed: Number(values.seed), workers: Number(values.workers), signal: controller.signal,
        onProgress: ({ stage, done, total }) => console.error(`${stage}: ${done}/${total}`),
      });
      console.log(result.output);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.name === "AbortError" ? 130 : 1;
}
