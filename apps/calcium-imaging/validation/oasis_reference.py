"""OASIS reference numbers for the app's AR(1) deconvolution (test/oasis.test.js).

OASIS (j-friedrich/OASIS, GPL-3) is an external validation reference only: the app's
src/core/oasis.js is written from Friedrich et al. 2017 and shares no code with it. This script
simulates AR(1) calcium traces with a fixed seed, rounds them to 6 decimals, runs OASIS on the
rounded traces and writes inputs and outputs to test/fixtures/oasis-reference.json.

    python -I oasis_reference.py <out.json>

Run with OASIS at j-friedrich/OASIS@<commit in validation/README.md>, Python 3.11.
"""
import json
import sys

import numpy as np
from oasis.functions import GetSn, constrained_oasisAR1, estimate_time_constant
from oasis.oasis_methods import oasisAR1


def simulate(rng, T, g, rate, sn, b):
    s = (rng.random(T) < rate).astype(float) * rng.uniform(0.5, 1.5, T)
    c = np.zeros(T)
    for t in range(T):
        c[t] = (g * c[t - 1] if t else 0) + s[t]
    return np.round(b + c + sn * rng.standard_normal(T), 6)


def main(out):
    rng = np.random.default_rng(20171024)
    cases = []
    for name, T, g, rate, sn in [("slow", 1000, 0.95, 0.02, 0.3), ("fast", 600, 0.8, 0.05, 0.2), ("quiet", 400, 0.9, 0.005, 0.25)]:
        y = simulate(rng, T, g, rate, sn, 0.0)
        c0, s0 = oasisAR1(y, g, lam=0.0)
        c1, s1 = oasisAR1(y, g, lam=1.0)
        cc, sc, bc, gc, lc = constrained_oasisAR1(y, g, sn, optimize_b=False)
        noise = GetSn(y, method="logmexp")
        decay = estimate_time_constant(y, p=1, sn=noise, lags=5)
        cases.append({
            "name": name,
            "g": g,
            "sn": sn,
            "y": y.tolist(),
            "oasisLambda0": {"c": c0.tolist(), "s": s0.tolist()},
            "oasisLambda1": {"c": c1.tolist(), "s": s1.tolist()},
            "constrained": {"c": cc.tolist(), "s": sc.tolist(), "lambda": float(lc)},
            "noiseLogmexp": float(noise),
            "arCoefficientLags5": float(decay[0]),
        })
        print(name, "sn", noise, "g", decay, "lambda", lc)
    with open(out, "w") as handle:
        json.dump({"source": "OASIS j-friedrich/OASIS (GPL-3), validation reference only", "cases": cases}, handle)


if __name__ == "__main__":
    main(sys.argv[1])
