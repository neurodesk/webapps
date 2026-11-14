# Pre-registration: effective MKL controls inside MATLAB (#730)

Committed before the recording it describes. Nothing below has been observed
yet; the outcomes are filled in afterwards in `README.md` ("Requested and
effective MKL controls"), next to these predictions, unchanged.

## Question

The MATLAB recorders start MATLAB with `MKL_CBWR=COMPATIBLE`,
`MKL_NUM_THREADS=1`, `OMP_NUM_THREADS=1`, `MKL_DYNAMIC=FALSE` and
`OMP_DYNAMIC=FALSE`, and call `maxNumCompThreads(1)`. `version('-blas')`
then reports `CNR branch auto` on AMD hosts and `CNR branch AVX512_E1` on
Intel hosts. The `qr_only` recording found identical arrays under six
`MKL_CBWR` requests on AMD. None of this says which settings MKL actually
uses. Identical repeats show only that a process is deterministic, not that
a request took effect.

## Observations and their sources

A MEX file (`mkl_controls.c`) asks the MKL already loaded in the MATLAB
process, through oneMKL's documented support functions (oneMKL Developer
Reference, "Support Functions": "Conditional Numerical Reproducibility
Control" and "Threading Control"):

- `mkl_cbwr_get(MKL_CBWR_BRANCH)`: the CNR branch MKL is using;
- `mkl_cbwr_get_auto_branch()`: the branch `AUTO` would choose on this CPU;
- `mkl_get_max_threads()`, `mkl_get_dynamic()`: MKL's thread count and
  dynamic adjustment;
- `mkl_get_version_string()`: the library's own version;
- `omp_get_max_threads()`, `omp_get_dynamic()` (OpenMP API 5.x, section 3.2),
  if an OpenMP runtime is loaded.

Symbols are looked up with `dlsym` in the running process and then in the
MKL library MATLAB has loaded (`dlopen` with `RTLD_NOLOAD`, so nothing new is
loaded). A symbol that cannot be found is recorded as unavailable, with the
lookups tried. It is not guessed. The MATLAB recorder adds:

- `version('-blas')` and `version('-lapack')`;
- `maxNumCompThreads` before and after `maxNumCompThreads(1)` (documented
  MATLAB function);
- the requested environment, read with `getenv`;
- the mapped MKL, OpenMP, BLAS and LAPACK libraries from `/proc/self/maps`
  (Linux `proc(5)`);
- `lscpu`.

As an effect check independent of the receipt, each process also records the
FPRev summation trees of `dgemv` and `sgemv` at lengths 64 and 250 with
`qr_kernels.c`. These are the same probes as the pinned kernel recording, so
they can be compared with its AMD and Intel trees.

The integer branch codes are mapped to names with oneMKL 2021's
`mkl_service.h` (`MKL_CBWR_AUTO` 2, `MKL_CBWR_COMPATIBLE` 3, `MKL_CBWR_AVX2`
10, `MKL_CBWR_AVX512_E1` 14 and the rest). The raw integers are kept, so a
wrong mapping can be corrected.

## Design

- Hosts: both GitHub runner labels (`ubuntu-22.04`, `ubuntu-24.04`). The label
  does not choose the CPU, so each receipt records the CPU it got.
- Requests, one job each (`controls_only` dispatch):
  - `documented`: the five variables above, exactly as the reference recorders
    set them;
  - `none`: all five unset;
  - `contrast`: `MKL_CBWR=AVX2`, `MKL_NUM_THREADS=4`, `OMP_NUM_THREADS=4`,
    `MKL_DYNAMIC=TRUE`, `OMP_DYNAMIC=TRUE`.
- Each job runs the recorder in two fresh MATLAB processes (`repeat`) on the
  same host.
- The `none` and `contrast` jobs are the held-out controls: no reference
  recording was ever made under them.

## Competing predictions

| Id | Observation | Prediction A | Prediction B |
| --- | --- | --- | --- |
| C1 | `mkl_cbwr_get(BRANCH)` under `documented` | `AUTO` (2): MATLAB's MKL ignores `MKL_CBWR`, consistent with `version('-blas')` | `COMPATIBLE` (3): the request is set, and `version('-blas')` names the detected branch, not the setting |
| C2 | the same under `contrast` | equal to C1's value | `AVX2` (10) |
| C3 | `mkl_cbwr_get_auto_branch()` | `AVX2` (10) on AMD EPYC, an `AVX512` code (12-14) on Intel Xeon | another code |
| T1 | `mkl_get_max_threads()` after `maxNumCompThreads(1)` | 1 under every request | the requested `MKL_NUM_THREADS` (4 under `contrast`) |
| T2 | `mkl_get_dynamic()` | 0 under every request | 1 under `contrast` |
| E1 | `dgemv` and `sgemv` trees | identical across the three requests on one host, and equal to the pinned trees of that CPU family | the `contrast` trees differ |
| R1 | two processes on one host | every receipt field and tree identical | something differs (not deterministic) |
| S1 | symbol lookup | all support functions resolvable | some unavailable: recorded as such, and the corresponding prediction stays undecided |

## What each outcome means for the reference

- C1 = A and E1 = A: the recorded references ran MKL's `auto` branch whatever
  was requested. The documented requests are then ineffective, and README text
  that implies otherwise must change.
- C1 = B: the requests took effect, and `version('-blas')` is not a receipt of
  the branch.
- T1 = A: MATLAB's thread limit governs MKL. With T2 = A this establishes
  single-threaded, non-dynamic MKL for the references, which are recorded
  under `documented`.
- Any S1 = B, or an unavailable observation: that control stays unestablished,
  and the documentation says so.

Two runner labels on whatever CPUs GitHub assigns cannot cover every host, and
this recording proves nothing about MATLAB on other machines.
