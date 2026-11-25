# Node drivers instructions (MindGrab, niimath)

- A portable command line that needs MindGrab or niimath uses `@neurodesk/node-drivers/mindgrab`
  (`loadMindgrabCpu`) or `/niimath` (`runNiimath`), not the browser wrappers and not shimmed browser
  globals. Both take the build the caller pins (`import.meta.resolve('@brainchop/core/package.json')`,
  the `@niivue/niimath/niimath.js` factory), so pin the app's own version in the command line's package.
  The MindGrab result has the wrapper's shape, so pass `mindgrab.segment` where code takes a `segmenter`.
- One MindGrab call peaks at 2.6 GB (mindgrab) to 3.9 GB (mindmap tissues) and uses one thread per core.
  The driver runs each call in its own worker thread, so memory is freed when it ends, and queues calls
  within a process; do not start MindGrab in two processes at once.
- `packages/node-drivers/bin/brainchop-mindgrab.js` is the native brainchop-core command line on the CPU
  driver, for Linux containers (meica-rs `--moco`, fastprep). Its parser (`src/mindgrab-cli.js`) mirrors
  the native one, which the CPU module prints with `--help`; a MindGrab bump that adds a native option
  fails its tests until the option is accepted or refused.
- `packages/node-drivers/validation/reference.json` pins the browser outputs both drivers reproduce byte
  for byte. After bumping either devDependency there, rerun `pnpm --filter @neurodesk/node-drivers
  exec node validation/browser-reference.mjs` and commit the new references; `node-drivers.yml` checks
  them on Linux, Windows and macOS. A command line's own release check still needs its own independent
  reference.
