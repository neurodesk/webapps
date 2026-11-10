# SPDX-License-Identifier: Apache-2.0
"""High-precision erfi and log I0 values for tests/special.rs.

Usage: uv run --no-project --with mpmath==1.3.0 python -I tools/special_values.py
Prints the Rust tables pasted into tests/special.rs: 50-digit values, rounded to the nearest
f64 and printed in its shortest round-trip form.
"""
from mpmath import mp, mpf, erfi, besseli, log

mp.dps = 50
# sqrt(kappa) over the toolbox's range: kappa = 10 * kappa_toolbox, kappa_toolbox in [0, 6.4],
# and the grid's kappa up to 8.
ERFI = ["0.01", "0.1", "0.3", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5",
        "5.5", "5.7", "6", "6.5", "7", "7.5", "8", "8.5", "9"]
LOG_I0 = ["0", "1e-8", "0.001", "0.5", "1", "3.75", "8", "15", "29.9", "30", "30.1", "50", "100",
          "250", "500", "699.9"]
print("const ERFI: [(f64, f64); %d] = [" % len(ERFI))
for x in ERFI:
    print(f"    ({float(x)!r}, {float(erfi(mpf(x)))!r}),")
print("];")
print("const LOG_I0: [(f64, f64); %d] = [" % len(LOG_I0))
for x in LOG_I0:
    print(f"    ({float(x)!r}, {float(log(besseli(0, mpf(x))))!r}),")
print("];")
