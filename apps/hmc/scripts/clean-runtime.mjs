import { rm } from "node:fs/promises";

// Older builds staged a second kernel here. Vite now bundles the worker's own URLs.
await rm(new URL("../public/registration/", import.meta.url), { recursive: true, force: true });
