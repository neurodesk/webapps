/*
 * MEX receipt of the MKL controls in effect inside this MATLAB process
 * (controls-preregistration.md). It calls oneMKL's documented support
 * functions on the MKL MATLAB has already loaded and loads nothing itself.
 *
 *   r = mkl_controls(mklPath)
 *
 * mklPath names MATLAB's MKL library (bin/<arch>/mkl.so). Symbols are looked
 * up in the running process first, then in that library through
 * dlopen(RTLD_NOLOAD). r is a struct: every integer field is NaN when its
 * function was not found, `found` lists the symbol each lookup resolved
 * ('' when none), and `version` is '' when unavailable.
 */
#define _GNU_SOURCE
#include "mex.h"
#include <dlfcn.h>
#include <math.h>
#include <string.h>

/* oneMKL mkl_service.h */
#define MKL_CBWR_BRANCH 1

typedef int (*int_of_int)(int);
typedef int (*int_of_void)(void);
typedef void (*version_string)(char *, int);

static void *library = NULL;

static void *lookup(const char *const *names, const char **found) {
    for (int i = 0; names[i]; i++) {
        void *p = dlsym(RTLD_DEFAULT, names[i]);
        if (!p && library) p = dlsym(library, names[i]);
        if (p) {
            *found = names[i];
            return p;
        }
    }
    *found = "";
    return NULL;
}

static void set_number(mxArray *s, const char *field, double value) {
    mxSetField(s, 0, field, mxCreateDoubleScalar(value));
}

static void set_string(mxArray *s, const char *field, const char *value) {
    mxSetField(s, 0, field, mxCreateString(value));
}

void mexFunction(int nlhs, mxArray *plhs[], int nrhs, const mxArray *prhs[]) {
    if (nrhs != 1 || !mxIsChar(prhs[0])) mexErrMsgTxt("Usage: r = mkl_controls(mklPath)");
    char *path = mxArrayToString(prhs[0]);
    library = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
    const char *fields[] = {
        "mklLibraryLoaded", "cbwrBranch", "cbwrAutoBranch", "mklMaxThreads", "mklDynamic",
        "ompMaxThreads", "ompDynamic", "version", "found",
    };
    mxArray *r = mxCreateStructMatrix(1, 1, 9, fields);
    set_number(r, "mklLibraryLoaded", library ? 1.0 : 0.0);

    static const char *cbwr_get[] = {"mkl_cbwr_get", "MKL_CBWR_Get", "MKL_CBWR_GET", NULL};
    static const char *cbwr_auto[] = {"mkl_cbwr_get_auto_branch", "MKL_CBWR_Get_Auto_Branch", "MKL_CBWR_GET_AUTO_BRANCH", NULL};
    static const char *max_threads[] = {"mkl_get_max_threads", "MKL_Get_Max_Threads", "MKL_GET_MAX_THREADS", NULL};
    static const char *dynamic[] = {"mkl_get_dynamic", "MKL_Get_Dynamic", "MKL_GET_DYNAMIC", NULL};
    static const char *omp_threads[] = {"omp_get_max_threads", NULL};
    static const char *omp_dynamic[] = {"omp_get_dynamic", NULL};
    static const char *version[] = {"mkl_get_version_string", "MKL_Get_Version_String", NULL};
    const char *names[7];

    int_of_int get = (int_of_int)lookup(cbwr_get, &names[0]);
    set_number(r, "cbwrBranch", get ? (double)get(MKL_CBWR_BRANCH) : NAN);
    int_of_void autob = (int_of_void)lookup(cbwr_auto, &names[1]);
    set_number(r, "cbwrAutoBranch", autob ? (double)autob() : NAN);
    int_of_void threads = (int_of_void)lookup(max_threads, &names[2]);
    set_number(r, "mklMaxThreads", threads ? (double)threads() : NAN);
    int_of_void dyn = (int_of_void)lookup(dynamic, &names[3]);
    set_number(r, "mklDynamic", dyn ? (double)dyn() : NAN);
    int_of_void omp = (int_of_void)lookup(omp_threads, &names[4]);
    set_number(r, "ompMaxThreads", omp ? (double)omp() : NAN);
    int_of_void ompd = (int_of_void)lookup(omp_dynamic, &names[5]);
    set_number(r, "ompDynamic", ompd ? (double)ompd() : NAN);
    version_string vs = (version_string)lookup(version, &names[6]);
    char buffer[512] = "";
    if (vs) vs(buffer, (int)sizeof buffer);
    buffer[sizeof buffer - 1] = '\0';
    set_string(r, "version", buffer);

    mxArray *found = mxCreateCellMatrix(1, 7);
    for (int i = 0; i < 7; i++) mxSetCell(found, i, mxCreateString(names[i]));
    mxSetField(r, 0, "found", found);
    if (library) dlclose(library);
    library = NULL;
    mxFree(path);
    plhs[0] = r;
    (void)nlhs;
}
