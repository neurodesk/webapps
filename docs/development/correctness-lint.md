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
