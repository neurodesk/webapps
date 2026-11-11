/*
 * MEX probe of the BLAS/LAPACK routines MATLAB links (MKL in R2023b).
 * Every input and output is a real double array; complex values travel as
 * separate real and imaginary parts and are converted to the requested class
 * here, so the same file builds under MATLAB and, for plumbing only, Octave.
 *
 *   [F, Fi, tau, taui, jpvt, c, ci] = qr_kernels('factor', cls, A, Ai, b, bi)
 *       ?geqp3 on A (m x n), then ?ormqr / ?unmqr applying Q' to b.
 *       b may have several columns; ?ormqr then applies Q' to all of them.
 *   [x, xi] = qr_kernels('trsv', cls, R, Ri, c, ci)
 *       ?trsv with the upper triangle of R (r x r), no transpose, non-unit.
 *   [X, Xi] = qr_kernels('trsm', cls, R, Ri, C, Ci)
 *       ?trsm, the same solve for several right-hand sides at once.
 *   S = qr_kernels('probe', cls, part, m, oa, ox, M)
 *       ?gemv('T' or 'C') of one column of m values against ones. For each
 *       pair i < j the column holds +M at i, -M at j and 1 elsewhere, in the
 *       real (part 0) or imaginary (part 1) component; S(i, j) is that
 *       component of the result. The column starts oa elements and the ones
 *       vector ox elements after a 64-byte boundary. The values reveal which
 *       terms each partial sum absorbs (the FPRev construction).
 *   blas = qr_kernels('int') returns sizeof the BLAS integer.
 */
#define _POSIX_C_SOURCE 200112L
#include "mex.h"
#include <stdlib.h>
#include <string.h>

#ifndef BI
#include <stddef.h>
#define BI ptrdiff_t
#endif

typedef BI blasint;

extern void sgeqp3_(const blasint *m, const blasint *n, float *a, const blasint *lda, blasint *jpvt, float *tau, float *work, const blasint *lwork, blasint *info);
extern void dgeqp3_(const blasint *m, const blasint *n, double *a, const blasint *lda, blasint *jpvt, double *tau, double *work, const blasint *lwork, blasint *info);
extern void cgeqp3_(const blasint *m, const blasint *n, float *a, const blasint *lda, blasint *jpvt, float *tau, float *work, const blasint *lwork, float *rwork, blasint *info);
extern void zgeqp3_(const blasint *m, const blasint *n, double *a, const blasint *lda, blasint *jpvt, double *tau, double *work, const blasint *lwork, double *rwork, blasint *info);
extern void sormqr_(const char *side, const char *trans, const blasint *m, const blasint *n, const blasint *k, const float *a, const blasint *lda, const float *tau, float *c, const blasint *ldc, float *work, const blasint *lwork, blasint *info);
extern void dormqr_(const char *side, const char *trans, const blasint *m, const blasint *n, const blasint *k, const double *a, const blasint *lda, const double *tau, double *c, const blasint *ldc, double *work, const blasint *lwork, blasint *info);
extern void cunmqr_(const char *side, const char *trans, const blasint *m, const blasint *n, const blasint *k, const float *a, const blasint *lda, const float *tau, float *c, const blasint *ldc, float *work, const blasint *lwork, blasint *info);
extern void zunmqr_(const char *side, const char *trans, const blasint *m, const blasint *n, const blasint *k, const double *a, const blasint *lda, const double *tau, double *c, const blasint *ldc, double *work, const blasint *lwork, blasint *info);
extern void strsv_(const char *uplo, const char *trans, const char *diag, const blasint *n, const float *a, const blasint *lda, float *x, const blasint *incx);
extern void dtrsv_(const char *uplo, const char *trans, const char *diag, const blasint *n, const double *a, const blasint *lda, double *x, const blasint *incx);
extern void ctrsv_(const char *uplo, const char *trans, const char *diag, const blasint *n, const float *a, const blasint *lda, float *x, const blasint *incx);
extern void ztrsv_(const char *uplo, const char *trans, const char *diag, const blasint *n, const double *a, const blasint *lda, double *x, const blasint *incx);
extern void strsm_(const char *side, const char *uplo, const char *trans, const char *diag, const blasint *m, const blasint *n, const float *alpha, const float *a, const blasint *lda, float *b, const blasint *ldb);
extern void dtrsm_(const char *side, const char *uplo, const char *trans, const char *diag, const blasint *m, const blasint *n, const double *alpha, const double *a, const blasint *lda, double *b, const blasint *ldb);
extern void ctrsm_(const char *side, const char *uplo, const char *trans, const char *diag, const blasint *m, const blasint *n, const float *alpha, const float *a, const blasint *lda, float *b, const blasint *ldb);
extern void ztrsm_(const char *side, const char *uplo, const char *trans, const char *diag, const blasint *m, const blasint *n, const double *alpha, const double *a, const blasint *lda, double *b, const blasint *ldb);
extern void sgemv_(const char *trans, const blasint *m, const blasint *n, const float *alpha, const float *a, const blasint *lda, const float *x, const blasint *incx, const float *beta, float *y, const blasint *incy);
extern void dgemv_(const char *trans, const blasint *m, const blasint *n, const double *alpha, const double *a, const blasint *lda, const double *x, const blasint *incx, const double *beta, double *y, const blasint *incy);
extern void cgemv_(const char *trans, const blasint *m, const blasint *n, const float *alpha, const float *a, const blasint *lda, const float *x, const blasint *incx, const float *beta, float *y, const blasint *incy);
extern void zgemv_(const char *trans, const blasint *m, const blasint *n, const double *alpha, const double *a, const blasint *lda, const double *x, const blasint *incx, const double *beta, double *y, const blasint *incy);

enum kind { REAL_SINGLE, REAL_DOUBLE, COMPLEX_SINGLE, COMPLEX_DOUBLE };

static enum kind parse_kind(const mxArray *array) {
    char name[16];
    if (mxGetString(array, name, sizeof name)) mexErrMsgTxt("class must be a short string");
    if (!strcmp(name, "single")) return REAL_SINGLE;
    if (!strcmp(name, "double")) return REAL_DOUBLE;
    if (!strcmp(name, "csingle")) return COMPLEX_SINGLE;
    if (!strcmp(name, "cdouble")) return COMPLEX_DOUBLE;
    mexErrMsgTxt("class is single, double, csingle or cdouble");
    return REAL_DOUBLE;
}

static int complex_kind(enum kind k) { return k == COMPLEX_SINGLE || k == COMPLEX_DOUBLE; }
static int single_kind(enum kind k) { return k == REAL_SINGLE || k == COMPLEX_SINGLE; }

/* Pack a real/imaginary double pair into the class's interleaved storage. */
static void *pack(enum kind k, const mxArray *re, const mxArray *im, size_t count) {
    const double *r = mxGetPr(re);
    const double *i = im ? mxGetPr(im) : NULL;
    size_t width = complex_kind(k) ? 2 : 1;
    if (mxGetNumberOfElements(re) != count || (i && mxGetNumberOfElements(im) != count)) mexErrMsgTxt("size mismatch");
    if (single_kind(k)) {
        float *out = mxCalloc(count * width + 1, sizeof(float));
        for (size_t n = 0; n < count; n++) {
            out[n * width] = (float)r[n];
            if (width == 2) out[n * width + 1] = i ? (float)i[n] : 0.0f;
        }
        return out;
    }
    double *out = mxCalloc(count * width + 1, sizeof(double));
    for (size_t n = 0; n < count; n++) {
        out[n * width] = r[n];
        if (width == 2) out[n * width + 1] = i ? i[n] : 0.0;
    }
    return out;
}

/* Unpack the class's storage into real and imaginary double matrices. */
static void unpack(enum kind k, const void *data, size_t rows, size_t cols, mxArray **re, mxArray **im) {
    size_t count = rows * cols, width = complex_kind(k) ? 2 : 1;
    *re = mxCreateDoubleMatrix(rows, cols, mxREAL);
    *im = mxCreateDoubleMatrix(rows, cols, mxREAL);
    double *r = mxGetPr(*re), *i = mxGetPr(*im);
    for (size_t n = 0; n < count; n++) {
        if (single_kind(k)) {
            r[n] = ((const float *)data)[n * width];
            i[n] = width == 2 ? ((const float *)data)[n * width + 1] : 0.0;
        } else {
            r[n] = ((const double *)data)[n * width];
            i[n] = width == 2 ? ((const double *)data)[n * width + 1] : 0.0;
        }
    }
}

static void factor(int nlhs, mxArray *plhs[], const mxArray *prhs[]) {
    enum kind k = parse_kind(prhs[1]);
    blasint m = (blasint)mxGetM(prhs[2]), n = (blasint)mxGetN(prhs[2]), one = 1, info = 0, lwork = -1;
    blasint mn = m < n ? m : n;
    void *a = pack(k, prhs[2], prhs[3], (size_t)(m * n));
    blasint nrhs = (blasint)mxGetN(prhs[4]);
    if ((blasint)mxGetM(prhs[4]) != m) mexErrMsgTxt("b needs m rows");
    void *b = pack(k, prhs[4], prhs[5], (size_t)(m * nrhs));
    blasint *jpvt = mxCalloc((size_t)n, sizeof(blasint));
    size_t width = complex_kind(k) ? 2 : 1, element = single_kind(k) ? sizeof(float) : sizeof(double);
    void *tau = mxCalloc((size_t)mn * width + 1, element);
    void *rwork = mxCalloc(2 * (size_t)n + 1, element);
    double query[2] = {0, 0};
    float queryf[2] = {0, 0};
    /* Workspace queries, then the factorisation. */
    switch (k) {
    case REAL_SINGLE: sgeqp3_(&m, &n, a, &m, jpvt, tau, queryf, &lwork, &info); lwork = (blasint)queryf[0]; break;
    case REAL_DOUBLE: dgeqp3_(&m, &n, a, &m, jpvt, tau, query, &lwork, &info); lwork = (blasint)query[0]; break;
    case COMPLEX_SINGLE: cgeqp3_(&m, &n, a, &m, jpvt, tau, queryf, &lwork, rwork, &info); lwork = (blasint)queryf[0]; break;
    case COMPLEX_DOUBLE: zgeqp3_(&m, &n, a, &m, jpvt, tau, query, &lwork, rwork, &info); lwork = (blasint)query[0]; break;
    }
    if (info) mexErrMsgTxt("geqp3 workspace query failed");
    if (lwork < 1) lwork = 1;
    void *work = mxCalloc((size_t)lwork * width + 1, element);
    switch (k) {
    case REAL_SINGLE: sgeqp3_(&m, &n, a, &m, jpvt, tau, work, &lwork, &info); break;
    case REAL_DOUBLE: dgeqp3_(&m, &n, a, &m, jpvt, tau, work, &lwork, &info); break;
    case COMPLEX_SINGLE: cgeqp3_(&m, &n, a, &m, jpvt, tau, work, &lwork, rwork, &info); break;
    case COMPLEX_DOUBLE: zgeqp3_(&m, &n, a, &m, jpvt, tau, work, &lwork, rwork, &info); break;
    }
    if (info) mexErrMsgTxt("geqp3 failed");
    blasint qlwork = -1;
    const char *trans = complex_kind(k) ? "C" : "T";
    switch (k) {
    case REAL_SINGLE: sormqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, queryf, &qlwork, &info); qlwork = (blasint)queryf[0]; break;
    case REAL_DOUBLE: dormqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, query, &qlwork, &info); qlwork = (blasint)query[0]; break;
    case COMPLEX_SINGLE: cunmqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, queryf, &qlwork, &info); qlwork = (blasint)queryf[0]; break;
    case COMPLEX_DOUBLE: zunmqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, query, &qlwork, &info); qlwork = (blasint)query[0]; break;
    }
    if (info) mexErrMsgTxt("ormqr workspace query failed");
    if (qlwork < 1) qlwork = 1;
    void *qwork = mxCalloc((size_t)qlwork * width + 1, element);
    switch (k) {
    case REAL_SINGLE: sormqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, qwork, &qlwork, &info); break;
    case REAL_DOUBLE: dormqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, qwork, &qlwork, &info); break;
    case COMPLEX_SINGLE: cunmqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, qwork, &qlwork, &info); break;
    case COMPLEX_DOUBLE: zunmqr_("L", trans, &m, &nrhs, &mn, a, &m, tau, b, &m, qwork, &qlwork, &info); break;
    }
    if (info) mexErrMsgTxt("ormqr failed");
    unpack(k, a, (size_t)m, (size_t)n, &plhs[0], &plhs[1]);
    unpack(k, tau, (size_t)mn, 1, &plhs[2], &plhs[3]);
    plhs[4] = mxCreateDoubleMatrix(1, (size_t)n, mxREAL);
    for (blasint j = 0; j < n; j++) mxGetPr(plhs[4])[j] = (double)jpvt[j];
    unpack(k, b, (size_t)m, (size_t)nrhs, &plhs[5], &plhs[6]);
    (void)nlhs;
}

/* ?trsm with several right-hand sides, as a multi-column mldivide needs. */
static void trsm(mxArray *plhs[], const mxArray *prhs[]) {
    enum kind k = parse_kind(prhs[1]);
    blasint n = (blasint)mxGetM(prhs[2]), nrhs = (blasint)mxGetN(prhs[4]);
    if ((blasint)mxGetN(prhs[2]) != n || (blasint)mxGetM(prhs[4]) != n) mexErrMsgTxt("R must be square and C have its rows");
    void *r = pack(k, prhs[2], prhs[3], (size_t)(n * n));
    void *x = pack(k, prhs[4], prhs[5], (size_t)(n * nrhs));
    float onef[2] = {1.0f, 0.0f};
    double oned[2] = {1.0, 0.0};
    switch (k) {
    case REAL_SINGLE: strsm_("L", "U", "N", "N", &n, &nrhs, onef, r, &n, x, &n); break;
    case REAL_DOUBLE: dtrsm_("L", "U", "N", "N", &n, &nrhs, oned, r, &n, x, &n); break;
    case COMPLEX_SINGLE: ctrsm_("L", "U", "N", "N", &n, &nrhs, onef, r, &n, x, &n); break;
    case COMPLEX_DOUBLE: ztrsm_("L", "U", "N", "N", &n, &nrhs, oned, r, &n, x, &n); break;
    }
    unpack(k, x, (size_t)n, (size_t)nrhs, &plhs[0], &plhs[1]);
}

static void trsv(mxArray *plhs[], const mxArray *prhs[]) {
    enum kind k = parse_kind(prhs[1]);
    blasint n = (blasint)mxGetM(prhs[2]), one = 1;
    if ((blasint)mxGetN(prhs[2]) != n) mexErrMsgTxt("R must be square");
    void *r = pack(k, prhs[2], prhs[3], (size_t)(n * n));
    void *x = pack(k, prhs[4], prhs[5], (size_t)n);
    switch (k) {
    case REAL_SINGLE: strsv_("U", "N", "N", &n, r, &n, x, &one); break;
    case REAL_DOUBLE: dtrsv_("U", "N", "N", &n, r, &n, x, &one); break;
    case COMPLEX_SINGLE: ctrsv_("U", "N", "N", &n, r, &n, x, &one); break;
    case COMPLEX_DOUBLE: ztrsv_("U", "N", "N", &n, r, &n, x, &one); break;
    }
    unpack(k, x, (size_t)n, 1, &plhs[0], &plhs[1]);
}

static void probe(mxArray *plhs[], const mxArray *prhs[]) {
    enum kind k = parse_kind(prhs[1]);
    int part = (int)mxGetScalar(prhs[2]);
    blasint m = (blasint)mxGetScalar(prhs[3]), one = 1;
    size_t oa = (size_t)mxGetScalar(prhs[4]), ox = (size_t)mxGetScalar(prhs[5]);
    double big = mxGetScalar(prhs[6]);
    size_t width = complex_kind(k) ? 2 : 1, element = single_kind(k) ? sizeof(float) : sizeof(double);
    size_t bytes = ((size_t)m + 64) * width * element;
    void *abuf = NULL, *xbuf = NULL;
    if (posix_memalign(&abuf, 64, bytes) || posix_memalign(&xbuf, 64, bytes)) mexErrMsgTxt("allocation failed");
    memset(abuf, 0, bytes);
    memset(xbuf, 0, bytes);
    char *a = (char *)abuf + oa * width * element, *x = (char *)xbuf + ox * width * element;
    for (blasint t = 0; t < m; t++) {
        if (single_kind(k)) ((float *)x)[t * width] = 1.0f;
        else ((double *)x)[t * width] = 1.0;
    }
    plhs[0] = mxCreateDoubleMatrix((size_t)m, (size_t)m, mxREAL);
    double *out = mxGetPr(plhs[0]);
    const char *trans = complex_kind(k) ? "C" : "T";
    for (blasint i = 0; i < m; i++) {
        for (blasint j = i + 1; j < m; j++) {
            for (blasint t = 0; t < m; t++) {
                double value = t == i ? big : t == j ? -big : 1.0;
                size_t slot = (size_t)t * width + (size_t)(width == 2 ? part : 0);
                if (single_kind(k)) {
                    if (width == 2) { ((float *)a)[t * 2] = 0.0f; ((float *)a)[t * 2 + 1] = 0.0f; }
                    ((float *)a)[slot] = (float)value;
                } else {
                    if (width == 2) { ((double *)a)[t * 2] = 0.0; ((double *)a)[t * 2 + 1] = 0.0; }
                    ((double *)a)[slot] = value;
                }
            }
            double result = 0;
            if (single_kind(k)) {
                float alpha[2] = {1.0f, 0.0f}, beta[2] = {0.0f, 0.0f}, y[2] = {0.0f, 0.0f};
                if (width == 2) cgemv_(trans, &m, &one, alpha, (float *)a, &m, (float *)x, &one, beta, y, &one);
                else sgemv_(trans, &m, &one, alpha, (float *)a, &m, (float *)x, &one, beta, y, &one);
                result = y[width == 2 ? part : 0];
            } else {
                double alpha[2] = {1.0, 0.0}, beta[2] = {0.0, 0.0}, y[2] = {0.0, 0.0};
                if (width == 2) zgemv_(trans, &m, &one, alpha, (double *)a, &m, (double *)x, &one, beta, y, &one);
                else dgemv_(trans, &m, &one, alpha, (double *)a, &m, (double *)x, &one, beta, y, &one);
                result = y[width == 2 ? part : 0];
            }
            out[(size_t)i + (size_t)j * (size_t)m] = result;
        }
    }
    free(abuf);
    free(xbuf);
}

void mexFunction(int nlhs, mxArray *plhs[], int nrhs, const mxArray *prhs[]) {
    char command[16];
    if (nrhs < 1 || mxGetString(prhs[0], command, sizeof command)) mexErrMsgTxt("first argument is a command");
    if (!strcmp(command, "int")) {
        plhs[0] = mxCreateDoubleScalar((double)sizeof(blasint));
    } else if (!strcmp(command, "factor") && nrhs == 6) {
        factor(nlhs, plhs, prhs);
    } else if (!strcmp(command, "trsm") && nrhs == 6) {
        trsm(plhs, prhs);
    } else if (!strcmp(command, "trsv") && nrhs == 6) {
        trsv(plhs, prhs);
    } else if (!strcmp(command, "probe") && nrhs == 7) {
        probe(plhs, prhs);
    } else {
        mexErrMsgTxt("unknown command or wrong argument count");
    }
}
