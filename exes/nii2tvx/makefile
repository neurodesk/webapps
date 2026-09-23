CC = gcc
CFLAGS = -O3 -Wall -Wextra
LIBS = -lz -lm
WASM_EXPORTS = _tvx_open,_tvx_close,_tvx_ntract,_tvx_name,_tvx_query,_mask_open,_mask_close,_malloc,_free

NII2TVX_REFERENCE_DIR ?= $(HOME)/src/nii2tvx

.PHONY: all sanitize wasm test test-real clean

all: nii2tvx

nii2tvx: nii2tvx.c nifti1.h
	$(CC) $(CFLAGS) nii2tvx.c -o nii2tvx $(LIBS)

sanitize:
	$(CC) -O1 -g -Wall -Wextra -fsanitize=address,undefined -fno-omit-frame-pointer nii2tvx.c -o nii2tvx_asan $(LIBS)

wasm:
	emcc -O3 nii2tvx.c -o nii2tvx.mjs -sMODULARIZE=1 -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_FUNCTIONS=$(WASM_EXPORTS) -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString

# Committed fixtures: TRK -> TVX -> pack -> query, plus WASM parity when nii2tvx.mjs exists.
test: nii2tvx
	sh test/run-tests.sh
	python3 test/conversion.test.py
	@work=$$(mktemp -d); trap 'rm -rf "$$work"' EXIT; \
	$(CC) $(CFLAGS) test/allocation.test.c -o "$$work/allocation-test" $(LIBS) && "$$work/allocation-test"

# The two real atlases and the four example lesions, which live outside the repository.
# Both engines must reproduce each atlas's expected-examples*.tsv exactly.
test-real: nii2tvx
	sh test/run-real.sh "$(NII2TVX_REFERENCE_DIR)"

clean:
	rm -f nii2tvx nii2tvx_asan nii2tvx.mjs nii2tvx.wasm
