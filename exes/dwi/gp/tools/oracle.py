# SPDX-License-Identifier: Apache-2.0
"""Write the JSON fixtures of tests/ from NiFreeze 3bcfb00, scikit-learn 1.9.1 and
scipy 1.18.1. Run it in the NiFreeze environment of the M0 runs, with Python's
isolated mode:

    python -I tools/oracle.py BIDS_DWI_PREFIX SKLEARN_GPR_ORIG OUT_DIR

BIDS_DWI_PREFIX is the path of sub-107_dir-AP_dwi of OpenNeuro ds005577 v1.0.0
(CC0) without an extension (the script reads .bvec and .bval). SKLEARN_GPR_ORIG
is the unpatched sklearn/gaussian_process/_gpr.py of the scikit-learn 1.9.1
wheel. The installed _gpr.py must have tools/sklearn-gpr-sum-targets.patch
applied: it sums the gradient over the targets first (the M0 patch). The fits
use it as installed, because that code made the M0 reference data. The
lml_grid fixture records the gradient of both files. The script stops when an
input file has a SHA-256 other than the one of the M0 environment.

Every fixture is smaller than 1 MB. Floats are Python repr (shortest round
trip); inf and nan are the strings "inf", "-inf" and "nan".
"""

import hashlib
import importlib.machinery
import importlib.util
import json
import math
import os
import sys
import warnings

import nifreeze
import numpy as np
import scipy
import sklearn
from nifreeze.model._dipy import GP_JITTER, GaussianProcessModel
from nifreeze.model.gpr import BOUNDS_A, BOUNDS_LAMBDA, DiffusionGPR, SphericalKriging
from scipy import optimize
from sklearn.gaussian_process.kernels import WhiteKernel

PREFIX, ORIG, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
TOL = 1.0e7 * 2.220446049250313e-016  # factr * epsmach, lbfgsb.c:681
PGTOL = 1e-5
HELD_OUT = 7  # the M0 dry-run volume, as a row of the DWI subset


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


INSTALLED_GPR = os.path.join(
    os.path.dirname(sklearn.__file__), "gaussian_process", "_gpr.py"
)
EXPECTED_SHA256 = {
    PREFIX
    + ".bvec": "6f8270c6568dd1b6e781bfb746ec221a2e4e484be0950a4a7c4deaed35303794",
    PREFIX
    + ".bval": "da890b74d0a531fda05d164ad12600aec9507cf42854bc04303b0f29b62f70f1",
    ORIG: "d135acc1e3b186f0b0829a6fe38ec1877d104f9b997edafb330a21626bdd5f4d",
    INSTALLED_GPR: "1cc5c15e120b5b1ae5707389e92d93e8ad21c5bf4d4d280bf6ecfa3926dae9da",
}
for _path, _want in EXPECTED_SHA256.items():
    _got = sha256(_path)
    if _got != _want:
        sys.exit(f"{_path}: SHA-256 {_got}, expected {_want}")

META = {
    "numpy": np.__version__,
    "scipy": scipy.__version__,
    "scikit-learn": sklearn.__version__,
    "nifreeze": nifreeze.__version__,
    "nifreeze_commit": "3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e",
    "oracle_sha256": sha256(__file__),
    "sklearn_gpr_orig_sha256": sha256(ORIG),
    "sklearn_gpr_installed_sha256": sha256(INSTALLED_GPR),
}


def plain(v):
    """Convert numpy values to JSON values; non-finite floats become strings."""
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, np.ndarray):
        return plain(v.tolist())
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        if math.isnan(f):
            return "nan"
        if math.isinf(f):
            return "inf" if f > 0 else "-inf"
        return f
    return v


def write(name, obj):
    obj = {"meta": META, **obj}
    text = json.dumps(plain(obj), allow_nan=False, separators=(",", ":"))
    assert len(text) < 1_000_000, (name, len(text))
    with open(os.path.join(OUT, name + ".json"), "w") as fh:
        fh.write(text + "\n")
    print(f"{name}: {len(text)} bytes")


# ---- X, as NiFreeze builds it (spec section 1.3) --------------------------------
bvec = np.loadtxt(PREFIX + ".bvec", dtype="float32").T
bval = np.loadtxt(PREFIX + ".bval", dtype="float32")
grad = np.asarray(np.column_stack((bvec, bval)), dtype=float)
dwi = grad[bval > 50]  # NiFreeze: b <= DEFAULT_LOWB_THRESHOLD (50) is a b0
keep = np.ones(len(dwi), dtype=bool)
keep[HELD_OUT] = False
X = dwi[keep, :3]
B = dwi[keep, 3]
X_NEW = dwi[[HELD_OUT], :3]
N = X.shape[0]
assert N == 89, N


def projected_norm(x, g, lo, hi):
    """projgr (lbfgsb.c:2756) for finite bounds on every variable."""
    s = 0.0
    for xi, gi, li, ui in zip(x, g, lo, hi):
        gi = max(xi - ui, gi) if gi < 0 else min(xi - li, gi)
        s = max(s, abs(gi))
    return s


class Traced(DiffusionGPR):
    """DiffusionGPR that records every objective call and every NEW_X iterate."""

    def _constrained_optimization(self, obj_func, initial_theta, bounds):
        self.trace_ = []
        self.iterations_ = []

        def traced(theta, eval_gradient=True):
            f, g = obj_func(theta, eval_gradient)
            self.trace_.append(
                {"theta": np.array(theta), "f": float(f), "g": np.array(g, dtype=float)}
            )
            return f, g

        def callback(
            intermediate_result,
        ):  # does not change the path, _lbfgsb_py.py:425
            self.iterations_.append(
                {
                    "x": np.array(intermediate_result.x),
                    "fun": float(intermediate_result.fun),
                }
            )

        self.bounds_log_ = np.array(bounds)
        self.theta0_ = np.array(initial_theta)
        # The same call as DiffusionGPR._constrained_optimization (gpr.py:242-253).
        res = optimize.minimize(
            traced,
            initial_theta,
            method="L-BFGS-B",
            bounds=bounds,
            jac=True,
            options={},
            args=(True,),
            tol=None,
            callback=callback,
        )
        self.res_ = res
        return res.x, res.fun


def nifreeze_kernel():
    return GaussianProcessModel().kernel


def kernel_at(start):
    return SphericalKriging(beta_a=start[0], beta_l=start[1]) + WhiteKernel(
        noise_level=start[2]
    )


def margins(gpr):
    """Stopping margins at every NEW_X: the relative-reduction ratio and the
    projected-gradient ratio."""
    lo, hi = gpr.bounds_log_[:, 0], gpr.bounds_log_[:, 1]
    f_prev = gpr.trace_[0]["f"]
    out = []
    for it in gpr.iterations_:
        g = next(
            t["g"] for t in reversed(gpr.trace_) if np.array_equal(t["theta"], it["x"])
        )
        f = it["fun"]
        ratio = (f_prev - f) / max(abs(f_prev), abs(f), 1.0) / TOL
        out.append(
            {"f_ratio": ratio, "pg_ratio": projected_norm(it["x"], g, lo, hi) / PGTOL}
        )
        f_prev = f
    return out


def fit(y, kernel):
    """Fit as GaussianProcessModel.fit does (_dipy.py:215-239). y is (n, T); NiFreeze
    passes the transpose of a C-ordered (T, n) array, so y is an F-ordered view."""
    y = np.ascontiguousarray(y.T).T
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        gpr = Traced(
            kernel=kernel, random_state=0, n_targets=y.shape[1], alpha=GP_JITTER
        )
        gpr.fit(X, y)
    gpr.warnings_ = [str(w.message) for w in caught]
    return gpr


def fit_record(fid, purpose, recipe, y, kernel, start):
    gpr = fit(y, kernel)
    res = gpr.res_
    y_mean = gpr.predict(X_NEW)
    return gpr, {
        "id": fid,
        "purpose": purpose,
        "recipe": recipe,
        "X": X,
        "X_new": X_NEW[0],
        "y": y,
        "y_dtype": str(y.dtype),
        "kernel": {
            "start": start,
            "bounds": [list(BOUNDS_A), list(BOUNDS_LAMBDA), [1e-5, 1e5]],
            "alpha": GP_JITTER,
            "theta0": gpr.theta0_,
            "exp_theta0": np.exp(gpr.theta0_),
            "bounds_log": gpr.bounds_log_,
        },
        "normalize": {
            "mean": gpr._y_train_mean,
            "std": gpr._y_train_std,
        },
        "trace": gpr.trace_,
        "iterations": gpr.iterations_,
        "margins": margins(gpr),
        "result": {
            "x": res.x,
            "fun": res.fun,
            "jac": res.jac,
            "nit": res.nit,
            "nfev": res.nfev,
            "njev": res.njev,
            "status": res.status,
            "message": res.message,
        },
        "fitted": {
            "theta": gpr.kernel_.theta,
            "params": np.exp(gpr.kernel_.theta),
            "lml": gpr.log_marginal_likelihood_value_,
        },
        "predict": {"y_mean": np.atleast_1d(np.asarray(y_mean).ravel())},
        "warnings": gpr.warnings_,
    }


# ---- F1 bounded_shell -------------------------------------------------------------
SHELL_RECIPE = (
    "rng = default_rng(20261019); T = 64; D = rng.uniform(0.0005, 0.003, T); "
    "S0 = rng.uniform(300, 1500, T); sig = S0 * exp(-b * D); "
    "y = rint(sig * (1 + 0.05 * rng.normal(size=(n, T)))).astype(int16)"
)
rng = np.random.default_rng(20261019)
T = 64
D = rng.uniform(0.0005, 0.003, size=T)
S0 = rng.uniform(300, 1500, size=T)
sig = S0[None, :] * np.exp(-B[:, None] * D[None, :])
y_shell = np.rint(sig * (1 + 0.05 * rng.normal(size=sig.shape))).astype(np.int16)
start_nf = [0.1, 2.0, 1.0]
gpr1, f1 = fit_record(
    "bounded_shell",
    "M0-like end: a and lambda end on their lower bounds",
    SHELL_RECIPE + "; NiFreeze start and bounds",
    y_shell,
    nifreeze_kernel(),
    start_nf,
)
p = np.exp(gpr1.kernel_.theta)
assert gpr1.kernel_.theta[0] == gpr1.bounds_log_[0, 0], p
assert gpr1.kernel_.theta[1] == gpr1.bounds_log_[1, 0], p
write("bounded_shell", f1)

# ---- F2 stuck_inf -----------------------------------------------------------------
rng = np.random.default_rng(20261019)
y_normal = rng.normal(size=(N, 64))
gpr2, f2 = fit_record(
    "stuck_inf",
    "the infinite-value path: the first trial point is the box corner, K is not positive definite",
    "rng = default_rng(20261019); y = rng.normal(size=(n, 64)); NiFreeze start and bounds",
    y_normal,
    nifreeze_kernel(),
    start_nf,
)
assert any(t["f"] == math.inf for t in gpr2.trace_)
assert np.array_equal(gpr2.res_.x, gpr2.theta0_)
assert gpr2.res_.nit == 1 and gpr2.res_.nfev == 3, gpr2.res_
write("stuck_inf", f2)


# ---- F3, F4 interior --------------------------------------------------------------
def gp_prior(seed, t, truth):
    rng = np.random.default_rng(seed)
    L = np.linalg.cholesky(kernel_at(truth)(X) + 1e-10 * np.eye(N))
    return L @ rng.normal(size=(N, t))


def margins_ok(gpr):
    m = gpr.margins_
    # Each stopping test (lbfgsb.c:981, 996) must take the same side under a
    # relative change of about 1e-10 in f or g. Earlier iterates must not stop.
    if len(m) < 3:
        return False
    if any(x["f_ratio"] <= 10 or x["pg_ratio"] <= 2 for x in m[:-1]):
        return False
    last = m[-1]
    if gpr.res_.message.endswith("PGTOL"):
        # PGTOL is tested first; if it flipped, the f test must give the same end.
        return last["pg_ratio"] < 0.5 and (last["f_ratio"] < 0.5 or last["f_ratio"] > 2)
    return last["f_ratio"] < 0.1 and last["pg_ratio"] > 2


TRUTH = [1.2, 1.0, 0.05]
START = [TRUTH[0] * 0.9, TRUTH[1] * 1.2, TRUTH[2] * 1.3]
for fid, t, first_seed, want in (
    ("interior", 4, 447, "FACTR"),
    ("interior_pgtol", 2, 461, "PGTOL"),
):
    tried = []
    for seed in range(first_seed, first_seed + 40):
        y = gp_prior(seed, t, TRUTH)
        gpr, rec = fit_record(
            fid,
            f"interior optimum, stop on {want}",
            f"truth (a, lambda, sigma2) = {TRUTH}; rng = default_rng({seed}); "
            f"L = cholesky(kernel(X) + 1e-10 I); y = L @ rng.normal(size=(n, {t})); "
            f"start = {START}; NiFreeze bounds",
            y,
            kernel_at(START),
            START,
        )
        gpr.margins_ = rec["margins"]
        p = np.exp(gpr.kernel_.theta)
        interior = bool(0.1 < p[0] < 2.35 and 1e-3 < p[1] < 1e3 and 1e-5 < p[2] < 1e5)
        ok = interior and want in gpr.res_.message and margins_ok(gpr)
        tried.append(
            {
                "seed": seed,
                "accepted": ok,
                "message": gpr.res_.message,
                "margins": [
                    [round(m["f_ratio"], 3), round(m["pg_ratio"], 3)]
                    for m in gpr.margins_
                ],
            }
        )
        if ok:
            rec["seed_search"] = tried
            write(fid, rec)
            break
    else:
        raise SystemExit(f"no seed for {fid}: {tried}")


# ---- F5 lml_grid ------------------------------------------------------------------
def load_orig_gpr():
    name = "sklearn.gaussian_process._gpr_orig"
    loader = importlib.machinery.SourceFileLoader(name, ORIG)
    spec = importlib.util.spec_from_file_location(name, ORIG, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.GaussianProcessRegressor


OrigGPR = load_orig_gpr()
y_interior = gp_prior(447, 4, TRUTH)
cases = []
for label, y in (("bounded_shell", y_shell), ("interior", y_interior)):
    gpr = DiffusionGPR(
        kernel=nifreeze_kernel(), optimizer=None, n_targets=y.shape[1], alpha=GP_JITTER
    )
    gpr.fit(X, np.ascontiguousarray(y.T).T)
    for params in (
        [0.1, 2.0, 1.0],
        [0.1, 0.001, 0.999],
        [1.0, 1.0, 0.1],
        [2.0, 1000.0, 1e-5],
        [0.1, 0.001, 1e-5],
        [2.35, 1.0, 1e-5],
    ):
        theta = np.log(params)
        lml_p, g_p = gpr.log_marginal_likelihood(
            theta, eval_gradient=True, clone_kernel=True
        )
        lml_o, g_o = OrigGPR.log_marginal_likelihood(gpr, theta, eval_gradient=True)
        finite = np.isfinite(lml_o)
        rel = (
            float(np.max(np.abs(g_p - g_o) / np.maximum(np.abs(g_o), 1e-300)))
            if finite
            else 0.0
        )
        cases.append(
            {
                "y": label,
                "params": params,
                "theta": theta,
                "lml_orig": lml_o,
                "grad_orig": g_o,
                "lml_patched": lml_p,
                "grad_patched": g_p,
                "grad_max_rel_diff": rel,
            }
        )
assert cases[-1]["lml_orig"] == -math.inf
write(
    "lml_grid",
    {
        "id": "lml_grid",
        "purpose": "lml and gradient at fixed theta; the last theta of each y gives a K that is not positive definite",
        "X": X,
        "alpha": GP_JITTER,
        "y": {"bounded_shell": y_shell, "interior": y_interior},
        "y_recipe": {
            "bounded_shell": "y of bounded_shell.json",
            "interior": "y of interior.json for seed 447",
        },
        "cases": cases,
    },
)

# ---- F6 normalize_edge ------------------------------------------------------------
y_edge = y_shell.copy()
y_edge[:, 5] = 700
gpr6, f6 = fit_record(
    "normalize_edge",
    "constant target column 5: std 1.0, a column of zeros, and the mean predicted",
    "y of bounded_shell with column 5 set to 700; NiFreeze start and bounds",
    y_edge,
    nifreeze_kernel(),
    start_nf,
)
assert gpr6._y_train_std[5] == 1.0
assert not np.any(gpr6.y_train_[:, 5])
f6["y_train_column5"] = gpr6.y_train_[:, 5]
write("normalize_edge", f6)


# ---- L-BFGS-B on plain functions --------------------------------------------------
def rosen(x):
    """Rosenbrock, written as the Rust test writes it (same operation order)."""
    f = 0.0
    g = [0.0] * len(x)
    for i in range(len(x) - 1):
        a = x[i + 1] - x[i] * x[i]
        b = 1.0 - x[i]
        f += 100.0 * a * a + b * b
        g[i] += -400.0 * x[i] * a - 2.0 * b
        g[i + 1] += 200.0 * a
    return f, np.array(g)


def mixed(x):
    """Weighted quadratic plus a quartic coupling, as the Rust test writes it."""
    w = [1.0, 2.0, 3.0, 0.5]
    c = [0.7, -1.0, 1.0, 0.3]
    f = 0.0
    g = [0.0] * 4
    for i in range(4):
        r = x[i] - c[i]
        f += w[i] * r * r
        g[i] += 2.0 * w[i] * r
    q = x[0] * x[1] + x[2]
    f += 0.5 * q * q * q * q
    q3 = 2.0 * q * q * q
    g[0] += q3 * x[1]
    g[1] += q3 * x[0]
    g[2] += q3
    return f, np.array(g)


def plain_run(fid, purpose, fun, x0, bounds):
    trace, iterations = [], []

    def traced(x):
        f, g = fun([float(v) for v in x])
        trace.append({"x": np.array(x), "f": f, "g": g})
        return f, g

    res = optimize.minimize(
        traced,
        np.array(x0, dtype=float),
        method="L-BFGS-B",
        jac=True,
        bounds=bounds,
        callback=lambda intermediate_result: iterations.append(
            {
                "x": np.array(intermediate_result.x),
                "fun": float(intermediate_result.fun),
            }
        ),
    )
    write(
        fid,
        {
            "id": fid,
            "purpose": purpose,
            "x0": x0,
            "bounds": [
                [
                    b[0] if b[0] is not None else "-inf",
                    b[1] if b[1] is not None else "inf",
                ]
                for b in bounds
            ],
            "trace": trace,
            "iterations": iterations,
            "result": {
                "x": res.x,
                "fun": res.fun,
                "jac": res.jac,
                "nit": res.nit,
                "nfev": res.nfev,
                "njev": res.njev,
                "status": res.status,
                "message": res.message,
            },
        },
    )
    return res


r = plain_run(
    "lbfgsb_rosen_box",
    "6-D Rosenbrock in a box with one active upper bound; many more than m = 10 updates",
    rosen,
    [-1.2, 1.0, -1.2, 1.0, -1.2, 1.0],
    [(-2.0, 2.0)] * 5 + [(-2.0, 0.7)],
)
assert r.nit > 15, r
r = plain_run(
    "lbfgsb_mixed",
    "free, lower-only, upper-only and boxed variables; x0 outside the box is clipped",
    mixed,
    [2.0, 3.0, -1.0, 1.5],
    [(None, None), (0.5, None), (None, 0.2), (-1.0, 1.0)],
)
# Found with the port's counters: the subspace step projected onto the box is not a
# descent direction once, so subsm goes back along the path (lbfgsb.c:3094-3157).
r = plain_run(
    "lbfgsb_rosen_backtrack",
    "4-D Rosenbrock in a box where subsm backtracks along the projected path",
    rosen,
    [-1.2, 0.2, 0.5, -1.1],
    [(-1.4, 0.6), (-1.2, 0.8), (-1.4, 0.6), (-1.3, 0.7)],
)
