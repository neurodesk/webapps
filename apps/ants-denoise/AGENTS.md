# ants-denoise instructions

- The app runs `@neurodesk/ants-denoise`'s own module worker (`?worker&url`; Vite emits the kernel beside it), one worker per run, terminated on cancel. Change the filter in the package, so the app and BISON stay identical.
- `e2e/expected.json` pins native ANTs 2.6.5 `DenoiseImage` on the example with one ITK thread (`scripts/native-reference.mjs`, Docker), and the browser tests must reproduce it byte for byte. Rerecord it after a module rebuild or an example change.
- The radii stop at the largest pair checked against native (patch 2, search 3), and the shrink factor stays 1. The app has no command line of its own: the Standalone dialog lists the ANTs container (`registry/standalone-exceptions.json`).
