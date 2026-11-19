# avx512-complex-qr: integrated runner replay

The candidate and its prediction freeze are unchanged from reviewed head `89f7f04b08a49217b1a61e94f4de9964bf633275`.
The fresh build at `21806ee85ce9b5a5243ee8cb8037f23ae1ca32cc` uses the merged runner and records module
`dcaa83df2fcda6b57af10d7ea2ced2d84dff4eb4ff9cd9ed8b99b90a839bd23f`. Historical `cc528cf6-3` reports remain immutable.

Both full 24-run Node matrices were executed anew. Every historical output hash, both-host
count and lost-value list is unchanged. The integration’s fresh shipped/null-control runs
remain bound to unchanged production sources and the same hook patch; every null-control
file matches on both bundles. Native pipeline dumps were reused and re-accounted, not rerun.

`binding.json` enumerates copied-source equality and any nonnumerical differences between
the original frozen build and this build. It records section-level binary comparisons;
no unproven binary-equivalence claim is implied by equal outputs on the recorded matrix.
`integration.json` separates fresh executions, retained evidence and pending review.

Source MATLAB inputs remain unattested and all recordings exposed. No canonical shipping
rebuild or browser/container acceptance is claimed. The known losses and scope limits
remain those of the original study; this replay does not waive #876’s production blocker.
