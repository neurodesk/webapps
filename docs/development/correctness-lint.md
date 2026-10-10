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

The initial inventory records existing diagnostics in
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

Zarro's `src/**/*.{ts,tsx,mts,cts}` is checked against its real strict TypeScript
project for `@typescript-eslint/no-floating-promises` and
`@typescript-eslint/no-misused-promises`. New source files in that directory
receive both rules. Missing type information fails the parser; it cannot be
recorded in the lint baseline. The CI gate installs Zarro's dependencies and
runs its type checker before lint so an unresolved import cannot silently turn
a library's promise types into `any`.

Await work whose completion is needed before the next mutation. At synchronous
browser callbacks, attach a rejection handler that reports the failure through
the existing status path. `void promise` alone does not pass. Async functions
passed to callbacks that expect `void` also fail; use a synchronous callback
that invokes the task with explicit rejection reporting.

Typed promise checking currently covers Zarro only. BrowserQC, Deface,
Dicompare, DWI2TRX and root agentic tests still need their own project audit and
promise policy. JavaScript remains covered by the correctness rules; enabling
`checkJs` for the entire catalog is a separate migration.

CI checks Zarro with the same pinned TypeScript 5.9.3 compiler that builds the
lint program, so unresolved imports cannot silently weaken promise analysis.
Its stream buffer annotations require ArrayBuffer storage, normalizing the
encoded bytes once before streaming; compressed contents are unchanged. NiiVue 1.0.0-rc.14's `setFocus` and `setBudget`
return its `refocus` barrier, which resolves on supersede, failed swaps and
disposal. Awaiting these methods does not turn cancelled chunk reads into
viewer action errors.
