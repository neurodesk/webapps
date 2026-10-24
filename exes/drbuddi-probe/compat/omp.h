#pragma once
// CPU feasibility probe is single-threaded; OpenMP pragmas are disabled.
static inline int omp_get_thread_num() { return 0; }
static inline void omp_set_num_threads(int) {}
