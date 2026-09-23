#include <assert.h>
#include <stdlib.h>

static int fail_after = -1;
static int allocations = 0;

static void *test_malloc(size_t size) {
	if (fail_after == 0)
		return NULL;
	if (fail_after > 0)
		fail_after--;
	void *p = malloc(size);
	if (p)
		allocations++;
	return p;
}

static void *test_calloc(size_t count, size_t size) {
	if (fail_after == 0)
		return NULL;
	if (fail_after > 0)
		fail_after--;
	void *p = calloc(count, size);
	if (p)
		allocations++;
	return p;
}

static void test_free(void *p) {
	if (p)
		allocations--;
	free(p);
}

#define malloc test_malloc
#define calloc test_calloc
#define free test_free
#define main nii2tvx_cli_main
#include "../nii2tvx.c"
#undef main

int main(void) {
	const size_t len = sizeof(tvx_header) + sizeof(tract_header) + 4;
	for (int failure = 0; failure < 2; failure++) {
		fail_after = -1;
		uint8_t *buf = test_calloc(1, len);
		tvx_header h = {.signature = kSig, .dim = {1, 1, 1}, .ntract = 1};
		tract_header tr = {.name = "empty", .noffset = 1};
		memcpy(buf, &h, sizeof(h));
		memcpy(buf + sizeof(h), &tr, sizeof(tr));
		fail_after = failure;
		assert(tvx_open(buf, len) == NULL);
		assert(allocations == 0); // includes the input buffer owned by tvx_open
	}
	uint8_t nii[352 + 1] = {0};
	nifti_1_header h = {.sizeof_hdr = 348, .datatype = DT_UINT8, .vox_offset = 352};
	h.dim[1] = h.dim[2] = h.dim[3] = 1;
	memcpy(nii, &h, sizeof(h));
	for (int failure = 0; failure < 2; failure++) {
		fail_after = failure;
		assert(mask_open(nii, sizeof(nii)) == NULL);
		assert(allocations == 0);
	}
	fail_after = -1;
	mask_t *mask = mask_open(nii, sizeof(nii));
	assert(mask != NULL);
	mask_close(mask);
	assert(allocations == 0);
	return 0;
}
