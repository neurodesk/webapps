# Vendored niimath (BSD-only, unreleased fast-deface build)

These are the built artifacts of a **BSD-2-only** WASM build of niimath, vendored
directly into the app (not an npm dependency) and imported from `src/main.ts` as
`import { Niimath } from './niimath'`.

Vendored because this build carries niimath's new fast affine `-deface` engine
(`-cost fast` default with Hellinger fallback; `-cost hel` for the exhaustive engine),
which is **newer than the npm release** (`@niivue/niimath@1.3.2`, no fast deface).
**Delete this directory and depend on `@niivue/niimath` from npm once `1.4.0` publishes.**

## Files

- `index.js` / `index.d.ts` — the `Niimath` wrapper (esbuild bundle). `index.js` spawns
  `new Worker(new URL('./worker.js', import.meta.url))`; Vite/Rollup emit `worker.js`
  and `niimath.wasm` as hashed assets from these `new URL(..., import.meta.url)` sites.
- `worker.js` — the WASM worker; `import Module from './niimath.js'`.
- `niimath.js` / `niimath.wasm` — the Emscripten glue + BSD WASM (`niimath.js` locates
  `niimath.wasm` via `new URL('niimath.wasm', import.meta.url)`).
- `core.d.ts` / `types.d.ts` / `worker.d.ts` / `workerImpl.d.ts` / `niimathOperators.json`
  — types + operator table pulled in by the above.

## Provenance

- **Source repo:** `rordenlab/niimath` (local: `/Users/chris/src/niimath`)
- **Built from commit:** `cf2ef5bc46114c1b8350cda8663ab92ffbd6d7c5`
- **License:** BSD-2-Clause. The GPL `spm_coreg`/`spm_deface` module is **not** built or
  shipped (no `index-gpl`/`niimath-gpl`/`worker-gpl`/`./gpl`).

## Rebuild recipe

```sh
cd /Users/chris/src/niimath/js
bun run makeWasm                                                 # BSD wasm → src/niimath.{js,wasm}
bun run scripts/pre-build.ts -i src/niimath.js -o src/niimath.js
bun run build                                                    # esbuild → dist/
# then copy the BSD dist files here:
cp dist/{index.js,index.d.ts,core.d.ts,types.d.ts,worker.js,worker.d.ts,\
workerImpl.d.ts,niimath.js,niimath.wasm,niimathOperators.json} <deface>/src/niimath/
```

A JS-wrapper-only change (e.g. `js/src/core.ts`) needs just `bun run build` — the `.wasm`
is unchanged, so `makeWasm` can be skipped.
