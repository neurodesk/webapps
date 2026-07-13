#!/bin/bash
# Run tests for QSMbly Rust/WASM components
#
# Usage:
#   ./test.sh           # Run all tests
#   ./test.sh medi      # Run only tests matching "medi"
#   ./test.sh --simd    # Run tests with SIMD feature enabled

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR/rust-wasm"

# Parse arguments
FILTER=""
FEATURES=""
for arg in "$@"; do
    if [[ "$arg" == "--simd" ]]; then
        FEATURES="--features simd"
    else
        FILTER="$arg"
    fi
done

cd "$RUST_DIR"

if [[ -n "$FILTER" ]]; then
    echo "=== QSMbly Tests (filter: $FILTER) ==="
    cargo test --release $FEATURES "$FILTER"
else
    echo "=== QSMbly Tests ==="
    cargo test --release $FEATURES
fi
