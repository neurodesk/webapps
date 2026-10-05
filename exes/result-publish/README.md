# Native result publication

This std-only crate owns filesystem staging and publication for native SynthSR
and SynthSeg. Callers supply bytes in their existing order: SynthSR image first,
SynthSeg JSON first. It does not read images or change scientific processing.

A temporary belongs to the call only after `create_new` succeeds. Registering it
before writing ensures that a partial-write error cannot bypass cleanup, while
a collision never authorizes deletion of an existing temporary.

Each destination is published atomically. The batch is not a transaction:
non-force failures roll back newly published destinations, while force failures
retain earlier replacements. Temporary cleanup remains best effort.

Run without models, inference libraries, or downloaded crates:

```sh
cargo test --locked --offline --manifest-path exes/result-publish/Cargo.toml
cargo test --locked --offline --release --manifest-path exes/result-publish/Cargo.toml
cargo clippy --locked --offline --manifest-path exes/result-publish/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path exes/result-publish/Cargo.toml --check
```

Tests inject a write error after writing 64 bytes to a real staged file. They
cover first and later failures, existing-file ownership, publication order,
rollback, forced partial replacement, and native paths. These filesystem tests
do not replace the applications' scientific parity suites.
