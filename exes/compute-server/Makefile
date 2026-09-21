# compute-server: build, test and lint the neurodesk-compute server.
# `make help` lists targets.
VERSION ?= $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml)
BIN = target/release/neurodesk-compute

.PHONY: help build test lint fmt run-simulated clean

help:
	@echo "build          release build -> $(BIN)"
	@echo "test           cargo test (unit + integration, simulate runner only)"
	@echo "lint           cargo clippy --all-targets -- -D warnings"
	@echo "fmt            cargo fmt --check"
	@echo "run-simulated  serve the placeholder tool on http://127.0.0.1:8765 with token 'dev'"
	@echo "clean          remove target/ and dist/"

build:
	cargo build --release
	@echo "built $(BIN) ($(VERSION))"

test:
	cargo test

lint:
	cargo clippy --all-targets -- -D warnings

fmt:
	cargo fmt --check

run-simulated:
	cargo run -- serve --runner simulate --insecure-http --listen 127.0.0.1:8765 --token dev

clean:
	cargo clean
	rm -rf dist
