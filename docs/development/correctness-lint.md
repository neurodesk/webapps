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
unchanged line within its file keeps its identity. Resolved entries also fail
until their entries are removed, so the baseline cannot silently grow stale.
Some existing undefined names are browser globals injected by automation or
classic scripts; confirm their declaration before treating a diagnostic as a
runtime defect. Explicit environment declarations can replace those entries in
later focused changes.

Fix a finding in the source and delete only its matching baseline entry. Do not
regenerate the baseline to make a new error pass. Fatal parser errors can never
be baselined. The new-app template imports the root configuration; use the root
command for the complete repository gate. Individual `eslint .` tasks report
all diagnostics in their app, including existing debt.
