#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>
#include "nifti1.h"
#ifdef __EMSCRIPTEN__
	#include <emscripten.h>
	#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
	#define EXPORT
#endif
#define kVersion "v1.1.20260920"

// ============================================================================
// Core: buffer in, numbers out. No file I/O, no zlib. This is also the WASM surface.
// ============================================================================
#define kSig 0x0A585654 // "TVX\n"

typedef struct { // file header, followed by ntract records
	uint32_t signature, dim[3];
	float srow_x[4], srow_y[4], srow_z[4];
	uint32_t ntract;
} tvx_header;

typedef struct { // record header, followed by uint32 offsets[noffset] and the stream padded to 4 bytes
	char name[64];
	uint32_t noffset, nbytes;
} tract_header;
_Static_assert(sizeof(tvx_header) == 68 && sizeof(tract_header) == 72, "no padding expected");

typedef struct {
	const tract_header *h;
	const uint32_t *offsets; // byte offsets into stream; offsets[noffset-1] == nbytes
	const uint8_t *stream;
} tract_t;

typedef struct {
	tvx_header h;
	tract_t *tracts;
	uint8_t *buf; // owned
	size_t len;   // bytes of buf used by header + records
	int64_t nvox, tab[27];
} tvx_t;

typedef struct {
	nifti_1_header hdr;
	uint8_t *img; // 0/1 per voxel
} mask_t;

// codes 0..26 are the 27 offsets (dx,dy,dz) in {-1,0,1}^3; code 27 escapes to a zigzag LEB128 delta
static void neighbour_table(int64_t tab[27], int64_t nx, int64_t ny) {
	for (int c = 0; c < 27; c++)
		tab[c] = (c % 3 - 1) + (c / 3 % 3 - 1) * nx + (c / 9 - 1) * nx * ny;
}

// One streamline: uint32 first voxel, then one code per further voxel.
// Returns 1 when a voxel is in img, 0 when none is, -1 when the bytes are not a valid stream.
static int walk(const uint8_t *p, const uint8_t *end, const tvx_t *t, const uint8_t *img) {
	if (end - p < 4)
		return -1;
	uint32_t first;
	memcpy(&first, p, 4);
	int64_t v = first;
	p += 4;
	for (;;) {
		if (v < 0 || v >= t->nvox)
			return -1;
		if (img[v])
			return 1;
		if (p == end)
			return 0;
		int c = *p++;
		if (c > 27)
			return -1;
		if (c < 27) {
			v += t->tab[c];
			continue;
		}
		uint64_t z = 0;
		uint8_t b = 0x80;
		for (int s = 0; s < 35 && (b & 0x80); s += 7) { // at most 5 bytes: |delta| < 2^32
			if (p == end)
				return -1;
			b = *p++;
			z |= (uint64_t)(b & 0x7F) << s;
		}
		if (b & 0x80)
			return -1;
		v += (int64_t)(z >> 1) ^ -(int64_t)(z & 1);
	}
}

EXPORT void tvx_close(tvx_t *t) {
	if (!t)
		return;
	free(t->tracts);
	free(t->buf);
	free(t);
}

// Takes ownership of buf. Validates structure (sizes, names, offsets); stream contents are checked as they are walked.
EXPORT tvx_t *tvx_open(uint8_t *buf, size_t len) {
	tvx_t *t = calloc(1, sizeof(tvx_t));
	t->buf = buf;
	if (len < sizeof(tvx_header))
		goto bad;
	memcpy(&t->h, buf, sizeof(tvx_header));
	if (t->h.signature != kSig)
		goto bad;
	if (t->h.dim[0] > 32767 || t->h.dim[1] > 32767 || t->h.dim[2] > 32767) // NIfTI-1 dims are int16
		goto bad;
	if (t->h.ntract > (len - sizeof(tvx_header)) / sizeof(tract_header))
		goto bad;
	t->tracts = calloc(t->h.ntract, sizeof(tract_t));
	size_t p = sizeof(tvx_header);
	for (uint32_t k = 0; k < t->h.ntract; k++) {
		tract_t *tr = &t->tracts[k];
		if (len - p < sizeof(tract_header))
			goto bad;
		tr->h = (const tract_header *)(buf + p);
		p += sizeof(tract_header);
		if (!memchr(tr->h->name, 0, sizeof(tr->h->name)))
			goto bad;
		uint64_t noffset = tr->h->noffset, nbytes = tr->h->nbytes;
		uint64_t need = noffset * 4 + ((nbytes + 3) & ~(uint64_t)3); // 64-bit: cannot wrap on wasm32
		if (noffset < 1 || need > len - p)
			goto bad;
		tr->offsets = (const uint32_t *)(buf + p);
		tr->stream = buf + p + 4 * noffset;
		p += need;
		if (tr->offsets[0] != 0 || tr->offsets[noffset - 1] != nbytes)
			goto bad;
		for (uint64_t i = 1; i < noffset; i++)
			if (tr->offsets[i] < tr->offsets[i - 1])
				goto bad;
	}
	t->len = p;
	t->nvox = (int64_t)t->h.dim[0] * t->h.dim[1] * t->h.dim[2];
	neighbour_table(t->tab, t->h.dim[0], t->h.dim[1]);
	return t;
bad:
	fprintf(stderr, "Not a valid TVX file\n");
	tvx_close(t);
	return NULL;
}

EXPORT int tvx_ntract(const tvx_t *t) {
	return t->h.ntract;
}

EXPORT const char *tvx_name(const tvx_t *t, int k) {
	return k >= 0 && k < (int)t->h.ntract ? t->tracts[k].h->name : NULL;
}

EXPORT void mask_close(mask_t *m) {
	if (!m)
		return;
	free(m->img);
	free(m);
}

// buf is an uncompressed NIfTI-1 image (header + voxels); any non-zero voxel is in the mask. buf is not kept.
EXPORT mask_t *mask_open(const uint8_t *buf, size_t len) {
	nifti_1_header h;
	if (len < sizeof(h)) {
		fprintf(stderr, "Not a NIfTI image\n");
		return NULL;
	}
	memcpy(&h, buf, sizeof(h));
	if (h.sizeof_hdr != 348) {
		fprintf(stderr, "Not a native-endian NIfTI-1 image (solution: use niimath)\n");
		return NULL;
	}
	int bpp;
	switch (h.datatype) {
	case DT_UINT8: bpp = 1; break;
	case DT_INT16: case DT_UINT16: bpp = 2; break;
	case DT_FLOAT32: bpp = 4; break;
	default:
		fprintf(stderr, "Unsupported datatype %d (solution: use niimath)\n", h.datatype);
		return NULL;
	}
	if (h.dim[1] < 1 || h.dim[2] < 1 || h.dim[3] < 1) {
		fprintf(stderr, "Bad image dimensions\n");
		return NULL;
	}
	// vox_offset is a float and dims are int16: do the size arithmetic in double, which is exact here, before any cast
	double nvox = (double)h.dim[1] * h.dim[2] * h.dim[3];
	if (!(h.vox_offset >= 348) || fmod(h.vox_offset, bpp) != 0 || h.vox_offset + nvox * bpp > (double)len) {
		fprintf(stderr, "Truncated or misaligned NIfTI image\n");
		return NULL;
	}
	size_t n = (size_t)nvox;
	const uint8_t *raw = buf + (size_t)h.vox_offset;
	mask_t *m = malloc(sizeof(mask_t));
	m->hdr = h;
	m->img = malloc(n);
	switch (bpp) { // int16 is read as uint16: sign is irrelevant to a != 0 test
	case 1: for (size_t i = 0; i < n; i++) m->img[i] = raw[i] != 0; break;
	case 2: for (size_t i = 0; i < n; i++) m->img[i] = ((const uint16_t *)raw)[i] != 0; break;
	default: for (size_t i = 0; i < n; i++) m->img[i] = ((const float *)raw)[i] != 0; break;
	}
	return m;
}

// float32 round-trips through other tools perturb the sform in the 6th digit; 1e-4 relative
// (0.01 mm on a 100 mm translation, 0.02 voxel drift across a 182 voxel axis) absorbs that
// and still rejects any genuinely different grid.
static bool close_enough(float a, float b) {
	return fabsf(a - b) <= 1e-4f * fmaxf(1.0f, fabsf(a));
}

static bool same_grid(const tvx_header *a, const nifti_1_header *hdr) {
	bool ok = true;
	for (int i = 0; i < 3; i++)
		ok &= a->dim[i] == (uint32_t)hdr->dim[i + 1];
	for (int i = 0; i < 4; i++)
		ok &= close_enough(a->srow_x[i], hdr->srow_x[i]) && close_enough(a->srow_y[i], hdr->srow_y[i]) && close_enough(a->srow_z[i], hdr->srow_z[i]);
	if (!ok) {
		fprintf(stderr, "NIfTI and TVX grids differ (use fslhd for NIfTI):\n");
		fprintf(stderr, " dim123: %u %u %u\n", a->dim[0], a->dim[1], a->dim[2]);
		fprintf(stderr, " sto_xyz1: %g %g %g %g\n", a->srow_x[0], a->srow_x[1], a->srow_x[2], a->srow_x[3]);
		fprintf(stderr, " sto_xyz2: %g %g %g %g\n", a->srow_y[0], a->srow_y[1], a->srow_y[2], a->srow_y[3]);
		fprintf(stderr, " sto_xyz3: %g %g %g %g\n", a->srow_z[0], a->srow_z[1], a->srow_z[2], a->srow_z[3]);
	}
	return ok;
}

// Fraction of streamlines of tract k touching the mask. -1 on grid mismatch or corrupt stream; NaN if the tract is empty.
EXPORT float tvx_query(const tvx_t *t, int k, const mask_t *m) {
	if (k < 0 || k >= (int)t->h.ntract || !same_grid(&t->h, &m->hdr))
		return -1;
	const tract_t *tr = &t->tracts[k];
	uint32_t n = tr->h->noffset - 1, hits = 0;
	for (uint32_t i = 0; i < n; i++) {
		int r = walk(tr->stream + tr->offsets[i], tr->stream + tr->offsets[i + 1], t, m->img);
		if (r < 0) {
			fprintf(stderr, "Corrupt stream in tract %s\n", tr->h->name);
			return -1;
		}
		hits += r;
	}
	return (float)hits / (float)n;
}

#ifndef __EMSCRIPTEN__
// ============================================================================
// Command line: file I/O, TRK/TCK conversion, packing
// ============================================================================
#include <zlib.h>

static bool is_ext(const char *filename, const char *extension) {
	size_t n = strlen(filename), m = strlen(extension);
	return n >= m && strcmp(filename + n - m, extension) == 0;
}

static const char *basenamex(const char *path) {
	const char *s = strrchr(path, '/');
	return s ? s + 1 : path;
}

static void strip_ext(char *fname) {
	char *dot = strrchr(fname, '.');
	if (dot && dot > basenamex(fname))
		*dot = '\0';
}

static void strip_ext2(char *fname) { // also peels .gz: file.nii.gz -> file
	if (is_ext(fname, ".gz"))
		fname[strlen(fname) - 3] = '\0';
	strip_ext(fname);
}

// whole file into memory; gzread reads plain and gzipped files alike
static uint8_t *read_file(const char *fnm, size_t *len) {
	FILE *fp = fopen(fnm, "rb");
	if (!fp) {
		fprintf(stderr, "Unable to open %s\n", fnm);
		return NULL;
	}
	fseek(fp, 0, SEEK_END); // on-disk size: exact for plain files, a lower bound for gzipped ones
	size_t cap = ftell(fp) + 1, n = 0;
	fclose(fp);
	gzFile fgz = gzopen(fnm, "rb");
	gzbuffer(fgz, 1 << 20);
	uint8_t *buf = malloc(cap);
	int got;
	while ((got = gzread(fgz, buf + n, cap - n)) > 0) {
		n += got;
		if (n == cap)
			buf = realloc(buf, cap *= 2);
	}
	gzclose(fgz);
	*len = n;
	return buf;
}

static tvx_t *open_tvx_file(const char *fnm) {
	size_t len;
	uint8_t *buf = read_file(fnm, &len);
	tvx_t *t = buf ? tvx_open(buf, len) : NULL;
	if (!t) {
		fprintf(stderr, "Unable to load %s\n", fnm);
		exit(EXIT_FAILURE);
	}
	return t;
}

static mask_t *open_mask_file(const char *fnm) {
	size_t len;
	uint8_t *buf = read_file(fnm, &len);
	mask_t *m = buf ? mask_open(buf, len) : NULL;
	free(buf);
	if (!m) {
		fprintf(stderr, "Unable to load %s\n", fnm);
		exit(EXIT_FAILURE);
	}
	return m;
}

// ---- 4x4 affine helpers (from niftilib)
typedef struct {
	float m[4][4];
} mat44;

static mat44 nifti_mat44_mul(mat44 A, mat44 B) {
	mat44 C;
	for (int i = 0; i < 4; i++)
		for (int j = 0; j < 4; j++) {
			C.m[i][j] = 0.0;
			for (int k = 0; k < 4; k++)
				C.m[i][j] += A.m[i][k] * B.m[k][j];
		}
	return C;
}

static mat44 nifti_mat44_inverse(mat44 R) { // Q.m[3][3] == 0 flags a singular input
	double r11, r12, r13, r21, r22, r23, r31, r32, r33, v1, v2, v3, deti;
	mat44 Q;
	r11 = R.m[0][0]; r12 = R.m[0][1]; r13 = R.m[0][2]; /* [ r11 r12 r13 v1 ] */
	r21 = R.m[1][0]; r22 = R.m[1][1]; r23 = R.m[1][2]; /* [ r21 r22 r23 v2 ] */
	r31 = R.m[2][0]; r32 = R.m[2][1]; r33 = R.m[2][2]; /* [ r31 r32 r33 v3 ] */
	v1 = R.m[0][3]; v2 = R.m[1][3]; v3 = R.m[2][3];    /* [ 0   0   0   1  ] */
	deti = r11*r22*r33-r11*r32*r23-r21*r12*r33
		 +r21*r32*r13+r31*r12*r23-r31*r22*r13;
	if (deti != 0.0l) deti = 1.0l / deti;
	Q.m[0][0] = (float)( deti*( r22*r33-r32*r23) );
	Q.m[0][1] = (float)( deti*(-r12*r33+r32*r13) );
	Q.m[0][2] = (float)( deti*( r12*r23-r22*r13) );
	Q.m[0][3] = (float)( deti*(-r12*r23*v3+r12*v2*r33+r22*r13*v3
					 -r22*v1*r33-r32*r13*v2+r32*v1*r23) );
	Q.m[1][0] = (float)( deti*(-r21*r33+r31*r23) );
	Q.m[1][1] = (float)( deti*( r11*r33-r31*r13) );
	Q.m[1][2] = (float)( deti*(-r11*r23+r21*r13) );
	Q.m[1][3] = (float)( deti*( r11*r23*v3-r11*v2*r33-r21*r13*v3
					 +r21*v1*r33+r31*r13*v2-r31*v1*r23) );
	Q.m[2][0] = (float)( deti*( r21*r32-r31*r22) );
	Q.m[2][1] = (float)( deti*(-r11*r32+r31*r12) );
	Q.m[2][2] = (float)( deti*( r11*r22-r21*r12) );
	Q.m[2][3] = (float)( deti*(-r11*r22*v3+r11*r32*v2+r21*r12*v3
					 -r21*r32*v1-r31*r12*v2+r31*r22*v1) );
	Q.m[3][0] = Q.m[3][1] = Q.m[3][2] = 0.0l;
	Q.m[3][3] = (deti == 0.0l) ? 0.0l : 1.0l;
	return Q;
}

static mat44 sform(const nifti_1_header *h) {
	return (mat44){{
		{h->srow_x[0], h->srow_x[1], h->srow_x[2], h->srow_x[3]},
		{h->srow_y[0], h->srow_y[1], h->srow_y[2], h->srow_y[3]},
		{h->srow_z[0], h->srow_z[1], h->srow_z[2], h->srow_z[3]},
		{0, 0, 0, 1}}};
}

#pragma pack(2)
typedef struct { //always little endian
	char id_string[6];
	int16_t dim[3];
	float voxel_size[3];
	float origin[3];
	int16_t n_scalars;
	char scalar_name[10][20];
	int16_t n_properties;
	char property_name[10][20];
	mat44 vox_to_ras;
	char reserved[444];
	char voxel_order[4];
	char pad2[4];
	float image_orientation_patient[6];
	char pad1[2];
	uint8_t invert_x, invert_y, swap_xy, swap_yz, swap_zx;
	int32_t n_count, version, hdr_size;
} trk_header;
#pragma pack()

// ---- conversion: streamline vertices (mm) -> voxel codes
typedef struct {
	tvx_header h;
	tract_header th;
	uint8_t *stream;
	size_t scap;
	uint32_t *offsets;
	size_t ocap;
	int64_t prev; // linear index of the last emitted voxel, -1 at streamline start
	int px, py, pz;
	bool has_prev;
	float pv[3]; // previous vertex, continuous voxel coords
	mat44 inv;   // mm (or TRK voxmm) -> voxel
} tvx_writer;

static bool writer_init(tvx_writer *w, const char *fnm, const nifti_1_header *hdr, mat44 inv) {
	memset(w, 0, sizeof(*w));
	if (inv.m[3][3] == 0.0f) {
		fprintf(stderr, "Template has no usable sform\n");
		return false;
	}
	if ((int64_t)hdr->dim[1] * hdr->dim[2] * hdr->dim[3] > UINT32_MAX) { // first voxel of a streamline is a uint32
		fprintf(stderr, "Template has too many voxels\n");
		return false;
	}
	w->h.signature = kSig;
	w->h.ntract = 1;
	for (int i = 0; i < 3; i++) w->h.dim[i] = hdr->dim[i + 1];
	for (int i = 0; i < 4; i++) {
		w->h.srow_x[i] = hdr->srow_x[i];
		w->h.srow_y[i] = hdr->srow_y[i];
		w->h.srow_z[i] = hdr->srow_z[i];
	}
	char *nm = strdup(basenamex(fnm));
	strip_ext(nm);
	strncpy(w->th.name, nm, sizeof(w->th.name) - 1);
	free(nm);
	w->inv = inv;
	w->prev = -1;
	w->ocap = 1 << 16;
	w->offsets = malloc(w->ocap * sizeof(uint32_t));
	w->offsets[0] = 0;
	w->th.noffset = 1;
	return true;
}

static void put(tvx_writer *w, uint8_t b) {
	if (w->th.nbytes == w->scap)
		w->stream = realloc(w->stream, w->scap = w->scap ? 2 * w->scap : 1 << 20);
	w->stream[w->th.nbytes++] = b;
}

static void emit(tvx_writer *w, int x, int y, int z) {
	uint32_t *dim = w->h.dim;
	if (x < 0 || y < 0 || z < 0 || x >= (int)dim[0] || y >= (int)dim[1] || z >= (int)dim[2])
		return;
	int64_t vxl = x + (int64_t)y * dim[0] + (int64_t)z * dim[0] * dim[1];
	if (vxl == w->prev)
		return;
	if (w->prev < 0) { // first voxel of a streamline is absolute
		for (int i = 0; i < 4; i++)
			put(w, (uint32_t)vxl >> (8 * i));
	} else if (abs(x - w->px) <= 1 && abs(y - w->py) <= 1 && abs(z - w->pz) <= 1) {
		put(w, (x - w->px + 1) + 3 * (y - w->py + 1) + 9 * (z - w->pz + 1));
	} else {
		put(w, 27);
		int64_t d = vxl - w->prev;
		uint64_t u = ((uint64_t)d << 1) ^ (uint64_t)(d >> 63);
		for (; u >= 0x80; u >>= 7)
			put(w, 0x80 | (u & 0x7F));
		put(w, u);
	}
	w->prev = vxl;
	w->px = x;
	w->py = y;
	w->pz = z;
}

// Amanatides & Woo grid traversal: every voxel the segment a->b crosses.
// Voxel v spans [v-0.5, v+0.5), matching nearest-voxel rounding.
static void raster(tvx_writer *w, const float *a, const float *b) {
	int v[3], step[3];
	float tMax[3], tDelta[3];
	for (int k = 0; k < 3; k++) {
		v[k] = (int)floorf(a[k] + 0.5f);
		float d = b[k] - a[k];
		step[k] = (d > 0) - (d < 0);
		tDelta[k] = step[k] ? fabsf(1.0f / d) : INFINITY;
		tMax[k] = step[k] ? (v[k] + 0.5f * step[k] - a[k]) / d : INFINITY;
	}
	emit(w, v[0], v[1], v[2]);
	for (;;) {
		int k = 0; // on ties step the higher axis first (keeps output stable across versions)
		if (tMax[1] <= tMax[k]) k = 1;
		if (tMax[2] <= tMax[k]) k = 2;
		if (tMax[k] > 1.0f)
			break;
		v[k] += step[k];
		tMax[k] += tDelta[k];
		emit(w, v[0], v[1], v[2]);
	}
}

static void add_vertex(tvx_writer *w, const float *xyz) {
	float p[3];
	for (int i = 0; i < 3; i++)
		p[i] = xyz[0] * w->inv.m[i][0] + xyz[1] * w->inv.m[i][1] + xyz[2] * w->inv.m[i][2] + w->inv.m[i][3];
	for (int i = 0; i < 3; i++)
		if (!(fabsf(p[i]) < 1e6f)) { // NaN, Inf or far outside any volume: raster would not terminate
			w->has_prev = false;
			return;
		}
	raster(w, w->has_prev ? w->pv : p, p);
	memcpy(w->pv, p, sizeof(p));
	w->has_prev = true;
}

static void end_streamline(tvx_writer *w) {
	uint32_t n = w->th.noffset;
	if (w->th.nbytes > w->offsets[n - 1]) { // drop streamlines with no in-volume voxel
		if (n == w->ocap)
			w->offsets = realloc(w->offsets, (w->ocap *= 2) * sizeof(uint32_t));
		w->offsets[n] = w->th.nbytes;
		w->th.noffset++;
	}
	w->has_prev = false;
	w->prev = -1;
}

static void write_tvx(const char *fnm, tvx_writer *w) {
	char *outnm = malloc(strlen(fnm) + 5);
	strcpy(outnm, fnm);
	strip_ext(outnm);
	strcat(outnm, ".tvx");
	FILE *fp = fopen(outnm, "wb");
	if (!fp) {
		fprintf(stderr, "Unable to write %s\n", outnm);
		exit(EXIT_FAILURE);
	}
	fwrite(&w->h, sizeof(w->h), 1, fp);
	fwrite(&w->th, sizeof(w->th), 1, fp);
	fwrite(w->offsets, sizeof(uint32_t), w->th.noffset, fp);
	fwrite(w->stream, 1, w->th.nbytes, fp);
	fwrite("\0\0\0", 1, (4 - w->th.nbytes % 4) % 4, fp);
	fclose(fp);
	fprintf(stderr, "%s\t%u\tstreamlines\t%u\tbytes\n", outnm, w->th.noffset - 1, w->th.nbytes);
	free(outnm);
	free(w->offsets);
	free(w->stream);
}

static bool load_trk(const char *fnm, const nifti_1_header *hdr) {
	//https://trackvis.org/docs/?subsect=fileformat
	FILE *fp = fopen(fnm, "rb");
	if (fp == NULL)
		return false;
	trk_header thdr;
	if (fread(&thdr, sizeof(trk_header), 1, fp) != 1 || thdr.hdr_size != sizeof(trk_header) || thdr.version != 2 || thdr.n_count == 0) {
		fprintf(stderr, "Unable to read TRK header %d %d\n", thdr.hdr_size, thdr.version);
		if (thdr.n_count == 0)
			fprintf(stderr, "unable to read TRK with implicit n_count (hint: convert to TCK with tff_convert_tractogram.py)\n");
		fclose(fp);
		return false;
	}
	if (thdr.vox_to_ras.m[3][3] == 0.0 || thdr.n_scalars < 0 || thdr.n_properties < 0) {
		fprintf(stderr, "TRK vox_to_ras not set or header corrupt\n");
		fclose(fp);
		return false;
	}
	// TRK vertices are in voxmm with corner origin: scale to voxels, shift half a voxel, then vox_to_ras
	mat44 zoomMat = {{
		{1.0f / thdr.voxel_size[0], 0, 0, -0.5f},
		{0, 1.0f / thdr.voxel_size[1], 0, -0.5f},
		{0, 0, 1.0f / thdr.voxel_size[2], -0.5f},
		{0, 0, 0, 1}}};
	mat44 vox2mm = nifti_mat44_mul(thdr.vox_to_ras, zoomMat);
	tvx_writer w;
	if (!writer_init(&w, fnm, hdr, nifti_mat44_mul(nifti_mat44_inverse(sform(hdr)), vox2mm))) {
		fclose(fp);
		return false;
	}
	int stride = 3 + thdr.n_scalars;
	float *buf = NULL;
	size_t bufcap = 0;
	for (int i = 0; i < thdr.n_count; i++) {
		int32_t m;
		if (fread(&m, sizeof(m), 1, fp) != 1 || m < 0)
			break;
		if ((size_t)m * stride > bufcap)
			buf = realloc(buf, (bufcap = (size_t)m * stride) * sizeof(float));
		if (fread(buf, sizeof(float), (size_t)m * stride, fp) != (size_t)m * stride)
			break;
		for (int j = 0; j < m; j++)
			add_vertex(&w, buf + (size_t)j * stride);
		fseek(fp, thdr.n_properties * sizeof(float), SEEK_CUR);
		end_streamline(&w);
	}
	free(buf);
	fclose(fp);
	write_tvx(fnm, &w);
	return true;
}

static bool load_tck(const char *fnm, const nifti_1_header *hdr) {
	FILE *fp = fopen(fnm, "rb");
	if (fp == NULL)
		return false;
	char line[1024];
	do { // text header ends with "END\n"; assumes Float32LE data follows immediately
		if (!fgets(line, sizeof(line), fp)) {
			fclose(fp);
			return false;
		}
	} while (strcmp(line, "END\n") != 0);
	tvx_writer w;
	if (!writer_init(&w, fnm, hdr, nifti_mat44_inverse(sform(hdr)))) {
		fclose(fp);
		return false;
	}
	float xyz[3];
	while (fread(xyz, sizeof(xyz), 1, fp) == 1) {
		if (isfinite(xyz[0])) {
			add_vertex(&w, xyz);
			continue;
		}
		end_streamline(&w); // NaN separates streamlines, Inf terminates the file
		if (!isnan(xyz[0]))
			break;
	}
	end_streamline(&w);
	fclose(fp);
	write_tvx(fnm, &w);
	return true;
}

// concatenate the records of several TVX files sharing one grid into a single file
static void pack(const char *outnm, int n, char **fnms) {
	tvx_t **in = malloc(n * sizeof(tvx_t *));
	tvx_header h;
	for (int i = 0; i < n; i++) {
		in[i] = open_tvx_file(fnms[i]);
		if (i == 0)
			h = in[0]->h;
		else if (memcmp(&in[i]->h, &h, offsetof(tvx_header, ntract)) != 0) {
			fprintf(stderr, "Grid of %s differs from %s\n", fnms[i], fnms[0]);
			exit(EXIT_FAILURE);
		} else
			h.ntract += in[i]->h.ntract;
	}
	FILE *fp = fopen(outnm, "wb");
	if (!fp) {
		fprintf(stderr, "Unable to write %s\n", outnm);
		exit(EXIT_FAILURE);
	}
	fwrite(&h, sizeof(h), 1, fp);
	for (int i = 0; i < n; i++) {
		fwrite(in[i]->buf + sizeof(tvx_header), 1, in[i]->len - sizeof(tvx_header), fp);
		tvx_close(in[i]);
	}
	fclose(fp);
	free(in);
	fprintf(stderr, "%s\t%u\ttracts\n", outnm, h.ntract);
}

static bool is_nifti(const char *fnm) {
	return is_ext(fnm, ".nii") || is_ext(fnm, ".nii.gz");
}

static bool is_track(const char *fnm) {
	return is_ext(fnm, ".trk") || is_ext(fnm, ".tck");
}

// every TRK/TCK argument -> a .tvx beside it, on the template's grid
static void convert_all(const char *template, int argc, char **argv) {
	mask_t *m = open_mask_file(template);
	for (int j = 1; j < argc; j++)
		if (is_track(argv[j]) && !(is_ext(argv[j], ".tck") ? load_tck : load_trk)(argv[j], &m->hdr)) {
			fprintf(stderr, "Unable to convert %s\n", argv[j]);
			exit(EXIT_FAILURE);
		}
	mask_close(m);
}

// every NIfTI argument is a lesion, every TVX argument a set of tracts: one TSV row per lesion
static void query_all(int argc, char **argv) {
	tvx_t **tvx = malloc(argc * sizeof(tvx_t *));
	int ntvx = 0;
	for (int j = 1; j < argc; j++)
		if (is_ext(argv[j], ".tvx"))
			tvx[ntvx++] = open_tvx_file(argv[j]);
	printf("id");
	for (int j = 0; j < ntvx; j++)
		for (int k = 0; k < tvx_ntract(tvx[j]); k++)
			printf("\t%s", tvx_name(tvx[j], k));
	printf("\n");
	for (int i = 1; i < argc; i++) {
		if (!is_nifti(argv[i]))
			continue;
		mask_t *m = open_mask_file(argv[i]);
		for (int j = 0; j < ntvx; j++) // fail before writing a partial row
			if (!same_grid(&tvx[j]->h, &m->hdr))
				exit(EXIT_FAILURE);
		char *basenm = strdup(argv[i]);
		strip_ext2(basenm);
		printf("%s", basenamex(basenm));
		free(basenm);
		for (int j = 0; j < ntvx; j++)
			for (int k = 0; k < tvx_ntract(tvx[j]); k++) {
				float frac = tvx_query(tvx[j], k, m);
				if (frac < 0)
					exit(EXIT_FAILURE);
				printf("\t%g", frac);
			}
		printf("\n");
		mask_close(m);
	}
	for (int j = 0; j < ntvx; j++)
		tvx_close(tvx[j]);
	free(tvx);
}

static void show_help(const char *fname) {
	fprintf(stderr, "nii2tvx %s\n", kVersion);
	fprintf(stderr, "Computes overlap of lesion (NIfTI) and tracts (tvx).\n");
	fprintf(stderr, "Usage to create TVX file(s)\n");
	fprintf(stderr, " %s template.nii tracks1.tck tracks2.tck\n", fname);
	fprintf(stderr, " %s template.nii tracks1.trk\n", fname);
	fprintf(stderr, "Usage to pack TVX files into one\n");
	fprintf(stderr, " %s -p atlas.tvx tracks1.tvx tracks2.tvx\n", fname);
	fprintf(stderr, "Usage to compute lesion overlap(s) with TVX file(s)\n");
	fprintf(stderr, " %s lesion.nii atlas.tvx\n", fname);
	fprintf(stderr, " %s lesion1.nii lesion2.nii tracks1.tvx tracks2.tvx\n", fname);
	fprintf(stderr, " %s ./imgs/w*lesion.nii.gz atlas.tvx > results.tsv\n", fname);
	exit(EXIT_FAILURE);
}

int main(int argc, char **argv) {
	if (argc > 3 && strcmp(argv[1], "-p") == 0) {
		pack(argv[2], argc - 3, argv + 3);
		return EXIT_SUCCESS;
	}
	if (argc < 3 || argv[1][0] == '-')
		show_help(argv[0]);
	const char *template = NULL; // first NIfTI: grid for conversion, and also a lesion
	int ntrack = 0, ntvx = 0;
	for (int i = 1; i < argc; i++) {
		if (is_nifti(argv[i]))
			template = template ? template : argv[i];
		else if (is_track(argv[i]))
			ntrack++;
		else if (is_ext(argv[i], ".tvx"))
			ntvx++;
		else {
			fprintf(stderr, "Extension unknown %s\n", argv[i]);
			exit(EXIT_FAILURE);
		}
	}
	if (!template || ntrack + ntvx == 0) {
		fprintf(stderr, "Arguments must include at least one NIfTI image and at least one tractography file (TCK, TRK, TVX)\n");
		show_help(argv[0]);
	}
	if (ntrack)
		convert_all(template, argc, argv);
	if (ntvx)
		query_all(argc, argv);
	return EXIT_SUCCESS;
}
#endif // __EMSCRIPTEN__
