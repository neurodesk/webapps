# Runner integration with main 4cdc38d2

These reports bind unchanged research arithmetic to the runner merged from main
`4cdc38d2074bd221ed60f21e95351c28d3e7c7c9` through #876 `f444a7abc` and #880 `23c59cb21`.
They do not replace any historical report or numerical prediction freeze.

The runner changed its subject-HRF browser expectation and provenance wording. Fresh
research builds and full Node matrices therefore use that runner, and the accounting
uses the merged comparator. `integration.json` distinguishes actual executions from
reused evidence. The shipping module remains `cc528cf6`; this is not a new canonical
shipping rebuild or browser/container acceptance run.

`build-*.json` records each fresh compilation at the clean source merge `f04a24e8`.
`binding-*.json` compares each copied Rust/runtime tree, patch, native test and compiler
with its historical build. All those inputs are identical. Hooks and avx512 differ only
in custom WASM name/producer metadata. The real-corr intervention also differs in code
and data bytes, with static data reordered; no binary-equivalence claim is made for it.
Every fresh matrix output hash and scientific count equals its historical counterpart.

The full 24-run matrix ran on both bundles for shipped, hooks, avx512 and the real-corr
intervention. Both expected refusals remain in each run; all comparator exits are zero.
The fresh hooks control reproduces 236 committed files on each bundle, and all builds
produce identical files between bundles. `comparison-*.json` records equality to the
historical output hashes, both host counts, and every loss. Module/runner bindings change;
scientific results do not.

Native pipeline dumps were reused, then recounted with the unchanged Rust/patch/native
source bindings shown in the receipts. They were not rerun. Their values, gains and losses
remain exactly the historical ones. The six Intel mixed-complex pipeline losses and four
CLI losses at this stack level remain disclosed. Later complex-corr and complex-QR studies
remain separate research units. #876's production regression remains blocked.

All recording inputs are previously seen and source MATLAB bundle attestations remain
absent. Prior independent reviews apply to their original heads; parent integration review
and full affected CI remain required for this merged stack.
