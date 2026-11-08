// The reference compute server for the browser tests: single-owner mode, the
// simulated relion tool and a placeholder tutorial in its `examples` data root.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startReferenceServer } from "../../../test-utils/compute-reference-server.mjs";
import { writeTutorialRoot } from "./fixtures.mjs";

const { values } = parseArgs({ options: { port: { type: "string" }, token: { type: "string" }, root: { type: "string" } } });
rmSync(values.root, { recursive: true, force: true });
const server = await startReferenceServer({
  port: Number(values.port),
  token: values.token,
  stageDelayMs: 300,
  singleOwner: true,
  dataRoots: { examples: writeTutorialRoot(values.root) },
  dataDir: join(values.root, "data"),
  localProfile: { cpus: 4, gpus: 0 },
});
console.log(`cryo-em test compute server at ${server.origin}`);
