/*
 * MEX receipt of one MKL control in effect inside this MATLAB process
 * (controls-preregistration.md). It calls a oneMKL or OpenMP support function
 * on the libraries MATLAB has already loaded, and loads or sets nothing.
 *
 *   [value, symbol] = mkl_controls(mklPath, control)
 *
 * control is one of 'cbwrBranch', 'cbwrAutoBranch', 'mklMaxThreads',
 * 'mklDynamic', 'ompMaxThreads', 'ompDynamic' or 'version'. mklPath names
 * MATLAB's MKL library (bin/<arch>/mkl.so). Symbols are looked up in the
 * running process, then in that library through dlopen(RTLD_NOLOAD). value is
 * NaN ('' for 'version') and symbol '' when no symbol resolves.
 *
 * oneMKL exports each support function twice: the C function (MKL_CBWR_Get,
 * arguments by value) and the Fortran interface (mkl_cbwr_get, mkl_cbwr_get_,
 * MKL_CBWR_GET, arguments by reference). The first recording called the
 * Fortran name with a C argument, which dereferenced 1 as a pointer and
 * crashed MATLAB. C names are tried first; mkl_cbwr_get's Fortran names are
 * called with the option by reference. The other functions take no argument,
 * so either interface is safe. The version string has only its C name here:
 * the Fortran one takes a hidden length argument.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "mex.h"
#include <dlfcn.h>
#include <math.h>
#include <string.h>

/* oneMKL mkl_service.h */
#define MKL_CBWR_BRANCH 1

typedef int (*int_of_int)(int);
typedef int (*int_of_pointer)(const int *);
typedef int (*int_of_void)(void);
typedef void (*version_string)(char *, int);

static void *lookup(void *library, const char *const *names, const char **found) {
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

void mexFunction(int nlhs, mxArray *plhs[], int nrhs, const mxArray *prhs[]) {
    if (nrhs != 2 || !mxIsChar(prhs[0]) || !mxIsChar(prhs[1])) mexErrMsgTxt("Usage: [value, symbol] = mkl_controls(mklPath, control)");
    char *path = mxArrayToString(prhs[0]);
    char *control = mxArrayToString(prhs[1]);
    void *library = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
    const char *found = "";
    double value = NAN;
    char text[512] = "";
    int string_result = 0;
    if (strcmp(control, "cbwrBranch") == 0) {
        static const char *c[] = {"MKL_CBWR_Get", NULL};
        static const char *f[] = {"mkl_cbwr_get", "mkl_cbwr_get_", "MKL_CBWR_GET", NULL};
        int_of_int get = (int_of_int)lookup(library, c, &found);
        if (get) {
            value = get(MKL_CBWR_BRANCH);
        } else {
            int_of_pointer getf = (int_of_pointer)lookup(library, f, &found);
            int option = MKL_CBWR_BRANCH;
            if (getf) value = getf(&option);
        }
    } else if (strcmp(control, "version") == 0) {
        static const char *c[] = {"MKL_Get_Version_String", NULL};
        version_string vs = (version_string)lookup(library, c, &found);
        if (vs) vs(text, (int)sizeof text);
        text[sizeof text - 1] = '\0';
        string_result = 1;
    } else {
        static const char *auto_branch[] = {"MKL_CBWR_Get_Auto_Branch", "mkl_cbwr_get_auto_branch", "mkl_cbwr_get_auto_branch_", "MKL_CBWR_GET_AUTO_BRANCH", NULL};
        static const char *max_threads[] = {"MKL_Get_Max_Threads", "mkl_get_max_threads", "mkl_get_max_threads_", "MKL_GET_MAX_THREADS", NULL};
        static const char *dynamic[] = {"MKL_Get_Dynamic", "mkl_get_dynamic", "mkl_get_dynamic_", "MKL_GET_DYNAMIC", NULL};
        static const char *omp_threads[] = {"omp_get_max_threads", NULL};
        static const char *omp_dynamic[] = {"omp_get_dynamic", NULL};
        const char *const *names = NULL;
        if (strcmp(control, "cbwrAutoBranch") == 0) names = auto_branch;
        else if (strcmp(control, "mklMaxThreads") == 0) names = max_threads;
        else if (strcmp(control, "mklDynamic") == 0) names = dynamic;
        else if (strcmp(control, "ompMaxThreads") == 0) names = omp_threads;
        else if (strcmp(control, "ompDynamic") == 0) names = omp_dynamic;
        else mexErrMsgTxt("Unknown control");
        int_of_void get = (int_of_void)lookup(library, names, &found);
        if (get) value = get();
    }
    plhs[0] = string_result ? mxCreateString(text) : mxCreateDoubleScalar(value);
    if (nlhs > 1) plhs[1] = mxCreateString(found);
    if (library) dlclose(library);
    mxFree(path);
    mxFree(control);
}
