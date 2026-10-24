# NODDI toolbox port prerequisites

This directory prepares the independent toolbox reference for #425. It contains no fitted model or toolbox source, and is not a Cargo workspace member yet.

The reference is NODDI toolbox 1.05 in Octave 11.3.0, pinned at Hugging Face commit `8b1220274f297646b2d3366ef6836290a1d0a830`. Download its 21 files, including the provenance README and original checksums, onto the storage volume:

```bash
python3 exes/dwi/noddi-toolbox/validation/fetch_reference.py \
  "$TMPDIR/noddi-toolbox-reference"
```

The manifest records byte counts and SHA-256 values. The provisioner verifies cached files too. It does not run a fit or establish the scientific acceptance gate.

The source archive used for that reference has SHA-256 `d4f8a1fe5c5e038a29174c40c4f6de0c868728e4d4cdf59c1d7f6dd399ca8143`. NITRC requires authenticated access; the published reference intentionally excludes toolbox source. The maintainer requires a download through the developer's own account and does not redistribute the archive. This worker has no NITRC login, so implementation awaits an authorized local copy; no public archive mirror or credentials are requested.

The maintainer supplied the WM selection at HF commit `295e32650e9e28397909caff4b9741ee95a422c0`: MindGrab brain mask AND FA ≥ 0.4. The provisioner verifies the mask's SHA-256 and byte count. It contains 13,332 voxels; excluding the 5 WM voxels with toolbox error code 2 leaves 13,327 gate voxels. The mask and reference error map reproduce those counts on the same affine.

The port must follow the source's starting grid and two-stage Rician fit. The reference uses `WatsonSHStickTortIsoV_B0`, fixed diffusivities 1.7e-3 and 3.0e-3 mm²/s, voxelwise sigma, and the documented Octave optimizer patches. Exclude the 14 reference voxels with error code 2. Their fits retain grid-search values; they are not successful optimizer results.

Ported toolbox files require Artistic License 2.0 notices and the corresponding licence file. Do not port the unlicensed bundled `NODDI_erfi.m`. The existing `amico/src/special.rs` implements `erfi` independently by its positive power series; assess sharing that implementation and extend independent high-precision tests over the toolbox's concentration range before adding another implementation. Reusing its mathematical helper does not make AMICO output a toolbox oracle.

No current AMICO runtime, NODDI app control or default method is changed by this preparation.
