.PHONY: build test lint wasm

build:
	cargo build --release -p fastprep

test:
	cargo test --workspace

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all --check

wasm:
	cd ../.. && pnpm --filter @neurodesk/fastprep build:wasm
