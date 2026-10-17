.PHONY: build test lint

build:
	cargo build --release -p glm

test:
	cargo test --workspace

lint:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all --check
