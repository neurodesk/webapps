// Stage ANTs WebAssembly kernel from packages/registration into public/registration/ (gitignored).
import { cp, mkdir, rm } from 'node:fs/promises';

const registrationSource = new URL('../../../packages/registration/wasm/', import.meta.url);
const registrationTarget = new URL('../public/registration/', import.meta.url);

await rm(registrationTarget, { recursive: true, force: true });
await mkdir(registrationTarget, { recursive: true });
for (const name of ['syncro-registration.mjs', 'syncro-registration.wasm']) {
  await cp(new URL(name, registrationSource), new URL(name, registrationTarget));
}
