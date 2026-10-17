# JavaScript and TypeScript correctness checks

Run `pnpm lint` for the correctness gate and the existing workspace syntax and
TypeScript checks. `pnpm lint:correctness` runs the source inventory gate alone;
`pnpm test:lint` exercises its canaries. The independent `code-quality` workflow
runs the latter checks without building apps or installing scientific runtimes.

The root ESLint configuration applies correctness rules to every owned JS/TS
source returned by Git, including new untracked files. This includes apps,
shared packages, scripts, tests and the app template. Declarations are checked by
TypeScript instead. Committed third-party distributions and compiler glue are
excluded by exact path with a reason in `scripts/quality/lint-inventory.mjs`.
Imported apps and scientific ports remain covered. A coverage check fails if an
ignore or missing configuration removes required rules from any owned file.
Inline ESLint disable comments cannot bypass the gate.

ESLint's TypeScript parser currently requires the TypeScript 5 compiler API.
The private `scripts/quality` workspace pins that API separately from the
repository's TypeScript 7 command-line compiler. Linting parses TypeScript but
does not replace semantic type checking. JavaScript uses browser and Node
globals because some shared modules run in both environments; worker file names
add an explicit ban on `document` and `window`. The shared cross-origin
isolation script is deliberately dual-purpose and receives the general globals. This check does not infer whether
every browser API is safe in a worker.

The initial findings have been resolved; the baseline is currently empty.
The gate can record reviewed existing diagnostics in
`scripts/quality/lint-baseline.json`. Each entry fingerprints the file path,
rule, message and offending source line, with a count for duplicate occurrences.
Changing the defective line or adding a new occurrence fails. Moving an
unchanged line within its file keeps its identity. Deleting a finding and
adding the identical defective line elsewhere in the same file is also
indistinguishable; the baseline is not a substitute for review. Resolved entries also fail
until their entries are removed, so the baseline cannot silently grow stale.


Fix a finding in the source and delete only its matching baseline entry. Do not
regenerate the baseline to make a new error pass. Fatal parser errors can never
be baselined. The new-app template imports the root configuration; use the root
command for the complete repository gate. Package `pnpm lint` tasks delegate to the same inventory and baseline for their
workspace. Generated assets and other workspaces are outside that scoped check.

The app ESLint wrapper files remain part of the generator contract. Use the
package `pnpm lint` command for scoped inventory and baseline handling; direct
`eslint .` invocation does not implement that repository gate.

## Typed promise handling

`scripts/quality/typed-projects.mjs` lists the TypeScript projects whose
sources are checked against their real strict TypeScript project for
`@typescript-eslint/no-floating-promises` and
`@typescript-eslint/no-misused-promises`. A source is a directory, covering every
`**/*.{ts,tsx,mts,cts}` file below it, or a single file. New source files in
those directories receive both rules; the project's `include` must cover them.
The coverage check fails when either rule is missing, when `void promise`
counts as handled, or when a file is typed by another project.

The lint parser does not report semantic errors: an unresolved import becomes
`any` and hides the promise it returns. Before linting, `scripts/lint.mjs`
therefore compiles each selected project with the pinned TypeScript 5.9.3 in
`scripts/quality`, the compiler that builds the lint program, and fails if it
does not compile. Parser failures cannot be recorded in the lint baseline. The
apps' own `tsc --noEmit` checks still run as before.

Await work whose completion is needed before the next mutation. At synchronous
browser callbacks, attach a rejection handler that reports the failure through
the existing status path. `void promise` alone does not pass. Async functions
passed to callbacks that expect `void` also fail; use a synchronous callback
that invokes the task with explicit rejection reporting.

To add a project, make its tsconfig compile with the pinned compiler, add it to
`typed-projects.mjs`, fix every finding in the same change, and add a behavioral
test showing a failure reaches the app's status bar or caller. Do not record
promise findings in the baseline.

### Inventory

Counted on 2026-10-14 with both rules enabled against each project's program.
JavaScript remains covered by the correctness rules; enabling `checkJs` for the
entire catalog is a separate migration.

| Project | TS sources | Project and TS 5.9.3 check | Findings | State |
| --- | --- | --- | --- | --- |
| Zarro (`apps/zarro/src`) | 29 | `apps/zarro/tsconfig.json` compiles | 0 | Typed since PR #245 |
| Deface (`apps/deface/src`) | 7 | `apps/deface/tsconfig.json` compiles | 2: 1 floating, 1 misused, both in `main.ts` | Typed; findings fixed |
| BrowserQC (`apps/browserqc/src`) | 7 | `apps/browserqc/tsconfig.json` compiles | 3: 2 floating, 1 misused, all in `main.ts` | Typed; findings fixed on 2026-10-17, adaptations in `upstream.json` |
| Root agentic tests (`test/agentic`, `test-utils/agentic-browser.ts`, `e2e.config.ts`) | 3 | `tsconfig.agentic.json` compiles | 0 | Typed; `test:e2e:types` still compiles it with TypeScript 7 |
| DWI2TRX (`apps/dwi2trx/src`) | 21 | `apps/dwi2trx/tsconfig.json` compiles | 10 floating, all in `main.ts` | Typed; findings fixed |
| Dicompare (`apps/dicompare/src`) | 142 | `apps/dicompare/tsconfig.json` compiles | 85: 38 floating, 47 misused, in 30 files | Deferred; upstream-owned, record adaptations in `upstream.json` |

The root agentic tests had no findings: their promises are already awaited.
Their project now includes `test/agentic/**/*.ts` so a new file in a
subdirectory is typed rather than rejected by the parser.

BrowserQC's opacity callback now uses the existing serial queue, which reports
failures to the status bar and technical log and continues with the next task.
Its teardown only calls synchronous APIs, including niimath `dispose` and
NiiVue `destroy`, so it returns `void` to both `pagehide` and Vite HMR.
Every release step runs even if another fails; teardown then reports any errors.
The production browser tests cover teardown failure, a failed load followed by
a valid load, and queued opacity and display changes. Its seven sources compile
with the pinned TS 5.9.3. The 2026-10-17 audit confirms Dicompare still has
38 floating and 47 misused promise findings in 30 files; it remains a separate
upstream adaptation stage.

Deface's findings were both teardown paths. `pagehide` discarded the
`cleanup()` promise, so a teardown failure became an unhandled rejection; it
now reports through the status bar and technical log like a failed task.
Vite's HMR client awaits a dispose callback's promise before importing the
updated module, although its type says `void`. `src/vite-hot.d.ts` declares
the promise overload so the callback keeps that ordering and handles its
rejection. `e2e/automation.spec.js` makes teardown fail and checks the status
bar, the technical log and the absence of page errors.

DWI2TRX's strict project uses the same flags as Zarro's, plus Node types for
the `src/dwi2trx/*.test.ts` files run by `node --experimental-strip-types`.
Its errors were missing declarations, not unsound code: `@neurodesk/dwi2trx`
now ships `tensor.d.ts` and `gradients.d.ts`, and the shared package types the
`./file-io/nifti` export and a new `./file-io/download` export, which the app
imports instead of the untyped `./file-io` index. Automation operations take
the shared `OperationContext`. Eight findings were event callbacks that
discarded a task's promise and two were `updateGLVolume` calls that are now
awaited. Each callback attaches a rejection handler that writes to the status
bar and technical log (`src/dwi2trx/failures.ts`). A tensor fit or tracking run
marks the failure it already showed, so the handler does not overwrite it, and
logs a run superseded by a newer input without changing that input's status.
`e2e/automation.spec.js` fails a fit started from the button and checks one
status error, one log entry and no page errors. That test also exposed a
startup race: the view queue was declared after the viewer's startup `await`,
so files chosen during startup failed with a temporal dead zone error.

Zarro's stream buffer annotations require ArrayBuffer storage, normalizing the
encoded bytes once before streaming; compressed contents are unchanged. NiiVue 1.0.0-rc.14's `setFocus` and `setBudget`
return its `refocus` barrier, which resolves on supersede, failed swaps and
disposal. Awaiting these methods does not turn cancelled chunk reads into
viewer action errors.

Intentional constructs have exact-file policies in the root configuration:
`packages/topofit/src/conform.js` preserves the reference cubic-spline pole
literal, including its existing IEEE-754 rounding; the scientific arithmetic is
unchanged. The spinalcordtoolbox failure summarizer must match ANSI escape
characters to strip terminal colours. SynthSeg's Playwright hook requires an
object fixture parameter even when it uses only the second `testInfo` argument;
its policy permits empty object parameters, while still rejecting other empty
patterns. These files retain all other correctness rules.

Best-effort catches describe their concrete fallback or cleanup purpose.
Unavailable browser persistence does not prevent verified model downloads or
in-memory theme selection. GPU error scopes always drain after an operation;
cleanup errors cannot replace its original failure. A NeSVoR scope failure also
poisons the engine so later calls cannot use invalid GPU state.
