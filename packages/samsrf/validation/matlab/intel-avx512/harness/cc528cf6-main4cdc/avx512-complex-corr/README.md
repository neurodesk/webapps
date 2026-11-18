# avx512-complex-corr: integrated runner replay

The candidate and its prediction freeze are unchanged from reviewed head `86937c35241eb8fad277406f2754b48dab1cb0ba`.
The fresh build at `8c4b3a2c6c14ecad49c0f867ca3867cbcb54fa73` uses the merged runner and records module
`53fb607ee538bd47d902ada1fbf31827555051c7dd86ed291594d93e735f6f52`. Historical `cc528cf6-2` reports remain immutable.

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
