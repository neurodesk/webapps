.PHONY: build test lint wasm

build:
	cargo build --release -p greedy-rs

test:
	cargo test --workspace

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all --check

wasm:
	cd ../.. && pnpm --filter @neurodesk/greedy build:wasm
