# Greedy reference fixtures

From the `greedy-rs` directory, run
`./scripts/make_reference.sh /path/to/greedy` to create one-thread reference
outputs for the v1 SSD/NMI workflows in Greedy's `-float` and default double
precision. Affine runs disable Greedy's default jitter (`-jitter 0`), which
also works with the 1.3 reference that predates `-seed`.

The float-versus-double spread is the acceptance tolerance: greedy-rs must be
at least as close to the double result as Greedy's own float build is.
Compare with `scripts/compare_reference.py mat|warp|img RUST_OUTPUT REFERENCE`.

The two 2 mm NMI affine matrices are committed because they are tiny and back
the optional `GREEDY_BENCH_DIR` compatibility test. The 1 mm warp fixtures are
deliberately not committed; CI should fetch a versioned fixture archive or run
this script on a machine with greedy.
