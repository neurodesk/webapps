# max-memory: 33 posterior channels of a 1 mm head are ~0.9 GB, and the flip pass holds two sets.
CRATE = wasm/target/wasm32-unknown-unknown/release/synthseg_wasm.wasm

.PHONY: wasm test
wasm:
	cd wasm && RUSTFLAGS="-C link-arg=--max-memory=4294967296" cargo build --locked --release --target wasm32-unknown-unknown
	wasm-opt -O3 $(CRATE) -o src/synthseg.wasm
	@ls -l src/synthseg.wasm

test:
	node --test test/*.test.js
