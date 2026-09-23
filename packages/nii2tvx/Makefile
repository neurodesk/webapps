# The 21 KB module is committed because no CI runner has emscripten; this target rebuilds it
# from exes/nii2tvx and is the only way wasm/ should ever change. test/parity.test.js fails if
# the committed artifact stops matching the C sources.
.PHONY: wasm test
wasm:
	$(MAKE) -C ../../exes/nii2tvx wasm
	cp ../../exes/nii2tvx/nii2tvx.mjs ../../exes/nii2tvx/nii2tvx.wasm wasm/
	@ls -l wasm/nii2tvx.wasm

test:
	node --test test/*.test.js
