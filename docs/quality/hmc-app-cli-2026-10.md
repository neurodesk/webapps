# HMC browser and command-line integration

The browser workspace and `hmc` command line run the shared `correctNiFreeze`
pipeline, with GP as the default and a b0-template option. Registration uses one
worker by default. The worker-count benchmark remains a separate gate; these
workflow runs do not establish performance, memory limits or through-plane
accuracy on a full acquisition.

## Completed checks

The production Chromium build completed both methods on the immutable ds005134
example: 67×92×10 voxels, all 137 volumes, automatic MindGrab CPU masking. Each run
downloaded the corrected float32 NIfTI, b-values, rotated b-vectors, motion TSV,
sidecar and a ZIP containing all 137 ITK transforms. The corrected images were
finite and retained every frame. The input pins and output hashes are in
`packages/hmc/validation/browser-reference.json`. Image hashes cover decompressed
NIfTI bytes; transform hashes cover each extracted file rather than ZIP metadata.

The sidecar records the effective estimator mask after GP eligibility reduction:
SHA-256, byte count and included-voxel count. It also identifies a supplied mask
or the default MindGrab model, version and actual backend. It contains no local
input paths. The dedicated mask worker terminates before registration starts;
the earlier masking peak and the viewer remain outside the supplied-mask pipeline benchmark.

On a separate synthetic 32³, ten-frame series, both command-line modes wrote
every file byte for byte as an independent invocation of the low-level Node
pipeline. Both production-browser modes also matched that Node invocation:
decompressed image, gradients, motion, sidecar and every transform.

Browser recovery coverage checks a failed pinned-example download followed by a
successful retry, supplied-mask selection, cancellation while registration is
queued, and a successful retry using the retained input and supplied mask. The
downloaded sidecar confirms that the supplied mask was used. Clearing it returns
to automatic masking. This caught and fixed an integration defect: shared
`createFileField` consumers must use `onFiles`, because the component consumes
and clears its native input's file list.

A malformed BIDS run selection also retains the previous successful run, its mask, completed outputs and downloaded provenance. A production regression caught and fixed the selector changing even when the new load failed.

The fresh production reference/parity run passed five tests. The final recovery,
mask-clear and retry run passed two tests. The shared source, catalog, version,
workflow-trigger and immutable-pin checks passed 96 tests. These are correctness
results; wall times observed during concurrent work are not benchmark evidence.

## Reproduce

```bash
pnpm --filter hmc build
pnpm --filter hmc test:e2e
node --test packages/hmc/test/node-files.test.js packages/hmc/test/nifreeze.test.js
node packages/hmc/validation/cli-check.mjs
```

The example browser tests obtain checksummed bytes from the offline asset lock
and route those exact bytes to the example URLs. Playwright blocks service
workers so the COI fallback worker does not bypass its routes; the production
preview supplies the actual COOP/COEP headers. CPU masking and registration run
normally. No simulated scientific output is used.

`HMC_BROWSER_REFERENCE=write` intentionally rerecords the browser reference.
Preserve exported screenshots outside Playwright's default results directory
when running additional tests, since a later invocation clears that directory.

## Portable verification

`packages/hmc/release.json` declares Linux x64, Windows x64 and macOS arm64
packages. `hmc-native.yml` verifies the production browser reference before the
shared portable workflow builds its target matrix. The command's self-check
executes the pinned registration resampler and verifies an identity phantom.

The actual Linux x64 archive at version `0.4.20261024` passed extraction,
manifest verification, its embedded Node 22.22.0 self-check and both complete
pinned-example comparisons. Every GP and trivial derivative matched the
production browser reference. The 54 MB archive's SHA-256 is
`216f133b06e85cd6ed084ca88ba0b413393c59793e0b719472164c30a63c530e`.
The packager wrote its actual receipt to
`exes/node-cli/dist/hmc-0.4.20261024-linux-x64.tar.gz.validation.txt`.

The final released production bundle also reran the trivial pinned example
successfully against the recorded output hashes. Desktop and phone output
screenshots were preserved under `$TMPDIR/hmc-final-trivial-reference` and
reviewed: the corrected slab and all six output controls are visible on desktop;
the phone layout retains readable controls with the viewer below them.

Windows and macOS archive execution requires the remote target jobs; no local
result establishes those platforms. The final catalog interface audits and
whole-app automatic-mask memory observations are reported separately. The
supplied-mask pipeline benchmark excludes automatic masking and the viewer, so it
cannot establish a whole-app input-size limit.

## Repeated full-volume lifecycle

The first whole-app observations completed and verified the full ds005577
acquisition with one and two registration workers. Automatic CPU masking produced
the same effective mask as the pinned reference (161,668 eligible voxels), and
all scientific outputs matched the accepted full-GP result. These pre-fix fresh
observations are retained in validation storage; they do not establish rerun safety.

The four-worker direct rerun exposed a trap before its first registration. Dropping
the model left small owned text/transform result buffers inside the freed arena;
the next full-series split could not obtain a contiguous allocation under the
unchanged 1 GiB core heap limit. Releasing those scratch buffers at model teardown
allows the arena to be reused. JavaScript has already copied their results.

A test reduces only the module's declared maximum to 32 MiB and runs the unchanged
model code on a proportionally smaller synthetic series. It reproduced the
second-run trap before the fix and now completes three model/prediction/output
cycles with the original first-prediction hash. The actual production 1 GiB module
also completed three consecutive full-size initialization, prediction and result
serialization cycles. Its rebuilt SHA-256 is
`9ab321e70b7533264e80b5a5fbd4343fd0cfa19e232c56d550cbb2243f3c8f22`.

Full production GP, retained-output/replacement memory observations and final
portable verification repeat after this lifecycle fix. The archive checksum
above records the earlier verified artifact, before this final kernel rebuild.
