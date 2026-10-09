/* Fixed-cost single-threaded control. Identical work every run, so its spread IS the machine's
 * timing noise floor. If that spread is as large as the browser effect you are chasing, the
 * effect is not measured yet. See README.md.
 *
 *   cc -O1 -o ctl ctl.c && for i in $(seq 8); do ./ctl; done
 */
#include <stdio.h>
#include <time.h>

int main(void) {
    struct timespec a, b;
    volatile double s = 0;
    clock_gettime(CLOCK_MONOTONIC, &a);
    for (long i = 1; i < 400000000L; i++) s += 1.0 / (double)i;
    clock_gettime(CLOCK_MONOTONIC, &b);
    printf("%.2f\n", (b.tv_sec - a.tv_sec) + (b.tv_nsec - a.tv_nsec) / 1e9);
    /* `s` is volatile, so the loop cannot be optimized away; exit 0 so `set -e` callers survive. */
    return 0;
}
