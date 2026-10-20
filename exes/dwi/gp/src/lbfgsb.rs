// SPDX-License-Identifier: BSD-3-Clause AND MIT
//! L-BFGS-B 3.0 as scipy 1.18.1 runs it for `minimize(method="L-BFGS-B", jac=True)`.
//!
//! This is a routine-by-routine port of `scipy/optimize/src/lbfgsb.c` (the C
//! translation of L-BFGS-B 3.0 in scipy 1.18.1) and of the driver loop of
//! `scipy/optimize/_lbfgsb_py.py::_minimize_lbfgsb`. Comments cite `lbfgsb.c:LINE`
//! and `_lbfgsb_py.py:LINE`. All arithmetic is f64 in the order of the C source.
//!
//! The work arrays keep the C layout: `ws` and `wy` are n x m, `sy`, `ss` and `wt` are
//! m x m, `wn` and `snd` are 2m x 2m, all column major, and every index expression is
//! the one of the C source (`sy[i + m*k]`, `wn[jy + m2*iy]`, `ws[k1 + n*ipntr]`).
//!
//! The C code returns to its caller (reverse communication) each time it needs f and g,
//! and the Python driver then calls the objective. Here [`minimize`] calls the
//! objective at the same points; the state transitions of `mainlb` are the same.
//!
//! The BLAS and LAPACK calls work on vectors of length n and matrices of at most
//! 2m x 2m. They are written out below in the operation order of the reference BLAS
//! and of LAPACK's unblocked routines. scipy links OpenBLAS, whose summation order
//! can differ in the last bit; `pow(x, 2.0)` is written `x * x`, which glibc's
//! correctly rounded `pow` equals.

// The loops keep the C source's index form, so that each line can be checked against
// lbfgsb.c.
#![allow(clippy::needless_range_loop)]

/// Machine epsilon as `lbfgsb.c:163` writes it.
const EPSMACH: f64 = 2.220446049250313e-016;

/// `enum Status` of `lbfgsb.c:4-14`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Start = 0,
    NewX = 1,
    Restart = 2,
    Fg = 3,
    Convergence = 4,
    Stop = 5,
    Warning = 6,
    Error = 7,
    Abnormal = 8,
}

impl Status {
    /// `status_messages` of `_lbfgsb_py.py:50-60`.
    pub fn text(self) -> &'static str {
        match self {
            Status::Start => "START",
            Status::NewX => "NEW_X",
            Status::Restart => "RESTART",
            Status::Fg => "FG",
            Status::Convergence => "CONVERGENCE",
            Status::Stop => "STOP",
            Status::Warning => "WARNING",
            Status::Error => "ERROR",
            Status::Abnormal => "ABNORMAL",
        }
    }
}

/// `enum StatusMsg` of `lbfgsb.c:17-50`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Msg {
    NoMsg = 0,
    FgStart = 301,
    FgLnsrch = 302,
    ConvGrad = 401,
    ConvF = 402,
    StopCpu = 501,
    StopIter = 502,
    StopGrad = 503,
    StopIterc = 504,
    StopCallb = 505,
    WarnRound = 601,
    WarnStpmax = 602,
    WarnStpmin = 603,
    WarnXtol = 604,
    ErrorNofeas = 701,
    ErrorFactr = 702,
    ErrorFtol = 703,
    ErrorGtol = 704,
    ErrorXtol = 705,
    ErrorStp1 = 706,
    ErrorStp2 = 707,
    ErrorStpmin = 708,
    ErrorStpmax = 709,
    ErrorInitg = 710,
    ErrorM = 711,
    ErrorN = 712,
    ErrorNbd = 713,
}

impl Msg {
    /// `task_messages` of `_lbfgsb_py.py:63-91`.
    pub fn text(self) -> &'static str {
        match self {
            Msg::NoMsg | Msg::FgStart | Msg::FgLnsrch => "",
            Msg::ConvGrad => "NORM OF PROJECTED GRADIENT <= PGTOL",
            Msg::ConvF => "RELATIVE REDUCTION OF F <= FACTR*EPSMCH",
            Msg::StopCpu => "CPU EXCEEDING THE TIME LIMIT",
            Msg::StopIter => "TOTAL NO. OF F,G EVALUATIONS EXCEEDS LIMIT",
            Msg::StopGrad => "PROJECTED GRADIENT IS SUFFICIENTLY SMALL",
            Msg::StopIterc => "TOTAL NO. OF ITERATIONS REACHED LIMIT",
            Msg::StopCallb => "CALLBACK REQUESTED HALT",
            Msg::WarnRound => "ROUNDING ERRORS PREVENT PROGRESS",
            Msg::WarnStpmax => "STP = STPMAX",
            Msg::WarnStpmin => "STP = STPMIN",
            Msg::WarnXtol => "XTOL TEST SATISFIED",
            Msg::ErrorNofeas => "NO FEASIBLE SOLUTION",
            Msg::ErrorFactr => "FACTR < 0",
            Msg::ErrorFtol => "FTOL < 0",
            Msg::ErrorGtol => "GTOL < 0",
            Msg::ErrorXtol => "XTOL < 0",
            Msg::ErrorStp1 => "STP < STPMIN",
            Msg::ErrorStp2 => "STP > STPMAX",
            Msg::ErrorStpmin => "STPMIN < 0",
            Msg::ErrorStpmax => "STPMAX < STPMIN",
            Msg::ErrorInitg => "INITIAL G >= 0",
            Msg::ErrorM => "M <= 0",
            Msg::ErrorN => "N <= 0",
            Msg::ErrorNbd => "INVALID NBD",
        }
    }
}

/// The options of `_minimize_lbfgsb` (`_lbfgsb_py.py:272-275`), with scipy's defaults.
#[derive(Clone, Debug)]
pub struct Options {
    pub maxcor: usize,
    pub ftol: f64,
    pub gtol: f64,
    pub maxfun: usize,
    pub maxiter: usize,
    pub maxls: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            maxcor: 10,
            ftol: 2.220_446_049_250_313e-9,
            gtol: 1e-5,
            maxfun: 15000,
            maxiter: 15000,
            maxls: 20,
        }
    }
}

/// Counters of the run. They do not change the path; tests use them to show which
/// branches a fixture reaches.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    /// BFGS updates (`iupdat` summed over restarts).
    pub updates: usize,
    /// Updates skipped by the curvature test (`nskip`, `lbfgsb.c:1031-1036`).
    pub skipped: usize,
    /// Memory resets after a failure (`info != 0` or `iback >= maxls`).
    pub resets: usize,
    /// Updates with a full memory, which shift the stored pairs (`iupdat > m`).
    pub shifts: usize,
    /// `subsm` calls that went back along the projected path (`lbfgsb.c:3094-3157`).
    pub subsm_backtracks: usize,
    /// Cauchy searches that passed at least one break point (`nseg > 1`).
    pub cauchy_segments: usize,
    /// Segments of all Cauchy searches (`nintol`, `lbfgsb.c:822`).
    pub segments: usize,
}

/// The `OptimizeResult` of `_lbfgsb_py.py:456-461`.
#[derive(Clone, Debug)]
pub struct OptimizeResult {
    pub x: Vec<f64>,
    pub fun: f64,
    pub jac: Vec<f64>,
    pub nit: usize,
    pub nfev: usize,
    pub njev: usize,
    /// `warnflag`: 0 converged, 1 iteration or evaluation limit, 2 other stop.
    pub status: u8,
    pub task: Status,
    pub task_msg: Msg,
    pub stats: Stats,
}

impl OptimizeResult {
    pub fn success(&self) -> bool {
        self.status == 0
    }

    /// `status_messages[task[0]] + ": " + task_messages[task[1]]` (`_lbfgsb_py.py:454`).
    pub fn message(&self) -> String {
        format!("{}: {}", self.task.text(), self.task_msg.text())
    }
}

/// Errors that `_minimize_lbfgsb` raises before it calls `setulb`.
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// `length of x0 != length of bounds`.
    Length,
    /// `one of the lower bounds is greater than an upper bound`.
    Bounds,
    /// `maxls must be positive`.
    Maxls,
    /// Every lower bound equals its upper bound; scipy then returns without a
    /// minimisation (`_optimize_result_for_equal_bounds`), which is not ported.
    AllFixed,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Error::Length => "length of x0 != length of bounds",
            Error::Bounds => "LBFGSB - one of the lower bounds is greater than an upper bound.",
            Error::Maxls => "maxls must be positive.",
            Error::AllFixed => "all variables are fixed by their bounds",
        };
        f.write_str(text)
    }
}

impl std::error::Error for Error {}

/// The objective with the memoisation of scipy's `ScalarFunction` and `MemoizeJac`:
/// it evaluates again only when x differs from the last x (`np.array_equal`,
/// `_differentiable_functions.py:409-414`), and counts the evaluations.
struct Memo<F> {
    fun: F,
    x: Vec<f64>,
    f: f64,
    g: Vec<f64>,
    nfev: usize,
}

impl<F: FnMut(&[f64], &mut [f64]) -> f64> Memo<F> {
    fn new(mut fun: F, x0: &[f64]) -> Self {
        let mut g = vec![0.0; x0.len()];
        let f = fun(x0, &mut g);
        Memo {
            fun,
            x: x0.to_vec(),
            f,
            g,
            nfev: 1,
        }
    }

    fn fun_and_grad(&mut self, x: &[f64], f: &mut f64, g: &mut [f64]) {
        if self.x.as_slice() != x {
            self.x.copy_from_slice(x);
            self.f = (self.fun)(x, &mut self.g);
            self.nfev += 1;
        }
        *f = self.f;
        g.copy_from_slice(&self.g);
    }
}

/// `minimize(fun, x0, method="L-BFGS-B", jac=True, bounds=..., options={})`.
///
/// `fun(x, g)` returns f and writes the gradient into g. `lower` and `upper` hold the
/// bounds; use `f64::NEG_INFINITY` and `f64::INFINITY` for a missing bound.
pub fn minimize<F>(
    fun: F,
    x0: &[f64],
    lower: &[f64],
    upper: &[f64],
    opts: &Options,
) -> Result<OptimizeResult, Error>
where
    F: FnMut(&[f64], &mut [f64]) -> f64,
{
    minimize_observed(fun, x0, lower, upper, opts, |_, _| {})
}

/// [`minimize`] with a callback at each new iterate, as scipy calls
/// `callback(intermediate_result)` with `x` and `fun` (`_lbfgsb_py.py:421-427`).
pub fn minimize_observed<F, C>(
    fun: F,
    x0: &[f64],
    lower: &[f64],
    upper: &[f64],
    opts: &Options,
    mut callback: C,
) -> Result<OptimizeResult, Error>
where
    F: FnMut(&[f64], &mut [f64]) -> f64,
    C: FnMut(&[f64], f64),
{
    let n = x0.len();
    if lower.len() != n || upper.len() != n {
        return Err(Error::Length);
    }
    if (0..n).any(|i| lower[i] > upper[i]) {
        return Err(Error::Bounds);
    }
    if n > 0 && (0..n).all(|i| lower[i] == upper[i]) {
        return Err(Error::AllFixed);
    }
    if opts.maxls == 0 {
        return Err(Error::Maxls);
    }
    let m = opts.maxcor;
    let pgtol = opts.gtol;
    // _lbfgsb_py.py:336
    let factr = opts.ftol / f64::EPSILON;

    // _lbfgsb_py.py:359: x0 = np.clip(x0, lb, ub)
    let x0: Vec<f64> = (0..n)
        .map(|i| {
            let v = if x0[i] < lower[i] { lower[i] } else { x0[i] };
            if v > upper[i] { upper[i] } else { v }
        })
        .collect();

    // _lbfgsb_py.py:371-388
    let mut nbd = vec![0i32; n];
    let mut l = vec![0.0; n];
    let mut u = vec![0.0; n];
    for i in 0..n {
        let lo = lower[i].is_finite();
        let hi = upper[i].is_finite();
        if lo {
            l[i] = lower[i];
        }
        if hi {
            u[i] = upper[i];
        }
        nbd[i] = match (lo, hi) {
            (false, false) => 0,
            (true, false) => 1,
            (true, true) => 2,
            (false, true) => 3,
        };
    }

    // ScalarFunction evaluates f and g at x0 before the first setulb call
    // (_differentiable_functions.py:283,292).
    let mut driver = PyDriver {
        memo: Memo::new(fun, &x0),
        n_iterations: 0,
        callback: &mut callback,
        maxiter: opts.maxiter,
        maxfun: opts.maxfun,
    };
    let mut x = x0;
    let mut f = 0.0;
    let mut g = vec![0.0; n];

    let mut state = Mainlb::new(n, m);
    let (task, task_msg) = state.run(
        &mut x,
        &l,
        &u,
        &nbd,
        &mut f,
        &mut g,
        factr,
        pgtol,
        opts.maxls,
        &mut driver,
    );
    let nfev = driver.memo.nfev;
    let n_iterations = driver.n_iterations;

    // _lbfgsb_py.py:438-443
    let status = if task == Status::Convergence {
        0
    } else if nfev > opts.maxfun || n_iterations >= opts.maxiter {
        1
    } else {
        2
    };
    Ok(OptimizeResult {
        x,
        fun: f,
        jac: g,
        nit: n_iterations,
        nfev,
        njev: nfev,
        status,
        task,
        task_msg,
        stats: state.stats,
    })
}

/// The saved variables of `dcsrch` (`isave`, `dsave`, `lbfgsb.c:3482-3509`). They
/// start at zero, as scipy's `isave` and `dsave` arrays do.
#[derive(Clone, Debug, Default)]
struct Dcsrch {
    brackt: bool,
    stage: i32,
    ginit: f64,
    gtest: f64,
    gx: f64,
    gy: f64,
    finit: f64,
    fx: f64,
    fy: f64,
    stx: f64,
    sty: f64,
    stmin: f64,
    stmax: f64,
    width: f64,
    width1: f64,
}

/// The work arrays and saved scalars of `setulb` and `mainlb`.
struct Mainlb {
    n: usize,
    m: usize,
    ws: Vec<f64>,
    wy: Vec<f64>,
    sy: Vec<f64>,
    ss: Vec<f64>,
    wt: Vec<f64>,
    wn: Vec<f64>,
    snd: Vec<f64>,
    z: Vec<f64>,
    r: Vec<f64>,
    d: Vec<f64>,
    t: Vec<f64>,
    xp: Vec<f64>,
    wa: Vec<f64>,
    index: Vec<usize>,
    iwhere: Vec<i32>,
    indx2: Vec<usize>,
    // lnsrlb's saved line-search state (`isave[21..]`, `dsave[16..]`, `ln_task`).
    ls: Dcsrch,
    ln_task: Status,
    ln_msg: Msg,
    stats: Stats,
}

/// What the Python driver does between two `setulb` calls (`_lbfgsb_py.py:406-436`).
trait Driver {
    /// Task FG: `f, g = func_and_grad(x)`.
    fn fun_and_grad(&mut self, x: &[f64], f: &mut f64, g: &mut [f64]);
    /// Task NEW_X: count the iteration, call the callback and test the limits.
    /// Returns the message of task STOP, or None to continue.
    fn new_x(&mut self, x: &[f64], f: f64) -> Option<Msg>;
}

struct PyDriver<'c, F, C> {
    memo: Memo<F>,
    n_iterations: usize,
    callback: &'c mut C,
    maxiter: usize,
    maxfun: usize,
}

impl<F, C> Driver for PyDriver<'_, F, C>
where
    F: FnMut(&[f64], &mut [f64]) -> f64,
    C: FnMut(&[f64], f64),
{
    fn fun_and_grad(&mut self, x: &[f64], f: &mut f64, g: &mut [f64]) {
        self.memo.fun_and_grad(x, f, g);
    }

    fn new_x(&mut self, x: &[f64], f: f64) -> Option<Msg> {
        // _lbfgsb_py.py:418-433
        self.n_iterations += 1;
        (self.callback)(x, f);
        if self.n_iterations >= self.maxiter {
            Some(Msg::StopIterc)
        } else if self.memo.nfev > self.maxfun {
            Some(Msg::StopIter)
        } else {
            None
        }
    }
}

impl Mainlb {
    fn new(n: usize, m: usize) -> Self {
        // setulb's workspace split (lbfgsb.c:353-386)
        Mainlb {
            n,
            m,
            ws: vec![0.0; m * n],
            wy: vec![0.0; m * n],
            sy: vec![0.0; m * m],
            ss: vec![0.0; m * m],
            wt: vec![0.0; m * m],
            wn: vec![0.0; 4 * m * m],
            snd: vec![0.0; 4 * m * m],
            z: vec![0.0; n],
            r: vec![0.0; n],
            d: vec![0.0; n],
            t: vec![0.0; n],
            xp: vec![0.0; n],
            wa: vec![0.0; 8 * m],
            index: vec![0; n],
            iwhere: vec![0; n],
            indx2: vec![0; n],
            ls: Dcsrch::default(),
            ln_task: Status::Start,
            ln_msg: Msg::NoMsg,
            stats: Stats::default(),
        }
    }

    /// `mainlb` (`lbfgsb.c:453-1077`). Where the C code returns to the driver, this
    /// calls the driver: at task FG for f and g, at task NEW_X for the iteration
    /// count and the limits. Returns the final task.
    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        x: &mut [f64],
        l: &[f64],
        u: &[f64],
        nbd: &[i32],
        f: &mut f64,
        g: &mut [f64],
        factr: f64,
        pgtol: f64,
        maxls: usize,
        driver: &mut dyn Driver,
    ) -> (Status, Msg) {
        let n = self.n;
        let m = self.m;
        let mut task;
        let mut task_msg;

        // lbfgsb.c:650-691
        let mut col = 0usize;
        let mut head = 0usize;
        let mut theta = 1.0;
        let mut iupdat = 0usize;
        let mut updatd = false;
        let mut iback = 0isize;
        let mut itail = 0usize;
        let mut fold = 0.0;
        let mut dnorm = 0.0;
        let mut gd = 0.0;
        let mut sbgnrm;
        let mut stp = 0.0;
        let mut gdold = 0.0;
        let mut dtd = 0.0;
        let mut iter = 0usize;
        let mut nfgv;
        let mut nseg = 0usize;
        let mut nfree = n;
        let mut ifun = 0isize;
        let tol = factr * EPSMACH;
        let mut info = 0i32;
        let mut stpmx = 0.0;
        let mut wrk = false;
        let mut nenter = 0usize;
        let mut ileave = n;
        let mut iword: i32;

        let (t, m_) = errclb(n, m, factr, l, u, nbd);
        if t == Status::Error {
            return (t, m_);
        }
        let (_prjctd, cnstnd, boxed) = active(n, l, u, nbd, x, &mut self.iwhere);

        // lbfgsb.c:763-764: task = FG, FG_START; the driver evaluates f and g.
        driver.fun_and_grad(x, f, g);

        // LINE111 (lbfgsb.c:776-794)
        nfgv = 1;
        sbgnrm = projgr(n, l, u, nbd, x, g);
        if sbgnrm <= pgtol {
            return (Status::Convergence, Msg::ConvGrad);
        }

        'main: loop {
            iword = -1;
            let _ = iword;

            if cnstnd || col == 0 {
                // lbfgsb.c:808-828
                {
                    let (p, rest) = self.wa.split_at_mut(2 * m);
                    let (c, rest) = rest.split_at_mut(2 * m);
                    let (wbp, v) = rest.split_at_mut(2 * m);
                    cauchy(
                        n,
                        x,
                        l,
                        u,
                        nbd,
                        g,
                        &mut self.indx2,
                        &mut self.iwhere,
                        &mut self.t,
                        &mut self.d,
                        &mut self.z,
                        m,
                        &self.wy,
                        &self.ws,
                        &self.sy,
                        &self.wt,
                        theta,
                        col,
                        head,
                        p,
                        c,
                        wbp,
                        v,
                        &mut nseg,
                        sbgnrm,
                        &mut info,
                    );
                }
                if info != 0 {
                    info = 0;
                    col = 0;
                    head = 0;
                    theta = 1.0;
                    iupdat = 0;
                    updatd = false;
                    self.stats.resets += 1;
                    continue 'main;
                }
                if nseg > 1 {
                    self.stats.cauchy_segments += 1;
                }
                self.stats.segments += nseg;
                freev(
                    n,
                    &mut nfree,
                    &mut self.index,
                    &mut nenter,
                    &mut ileave,
                    &mut self.indx2,
                    &self.iwhere,
                    &mut wrk,
                    updatd,
                    cnstnd,
                    iter,
                );
            } else {
                self.z.copy_from_slice(x);
                wrk = updatd;
                nseg = 0;
            }

            // lbfgsb.c:837-891
            if nfree != 0 && col != 0 {
                if wrk {
                    formk(
                        n,
                        nfree,
                        &self.index,
                        nenter,
                        ileave,
                        &self.indx2,
                        iupdat,
                        updatd,
                        &mut self.wn,
                        &mut self.snd,
                        m,
                        &self.ws,
                        &self.wy,
                        &self.sy,
                        theta,
                        col,
                        head,
                        &mut info,
                    );
                }
                if info != 0 {
                    info = 0;
                    col = 0;
                    head = 0;
                    theta = 1.0;
                    iupdat = 0;
                    updatd = false;
                    self.stats.resets += 1;
                    continue 'main;
                }
                cmprlb(
                    n,
                    m,
                    x,
                    g,
                    &self.ws,
                    &self.wy,
                    &self.sy,
                    &self.wt,
                    &self.z,
                    &mut self.r,
                    &mut self.wa,
                    &self.index,
                    theta,
                    col,
                    head,
                    nfree,
                    cnstnd,
                    &mut info,
                );
                if info == 0 {
                    let backtracked = subsm(
                        n,
                        m,
                        nfree,
                        &self.index,
                        l,
                        u,
                        nbd,
                        &mut self.z,
                        &mut self.r,
                        &mut self.xp,
                        &self.ws,
                        &self.wy,
                        theta,
                        x,
                        g,
                        col,
                        head,
                        &mut iword,
                        &mut self.wa,
                        &self.wn,
                        &mut info,
                    );
                    if backtracked {
                        self.stats.subsm_backtracks += 1;
                    }
                }
                if info != 0 {
                    info = 0;
                    col = 0;
                    head = 0;
                    theta = 1.0;
                    iupdat = 0;
                    updatd = false;
                    self.stats.resets += 1;
                    continue 'main;
                }
            }

            // lbfgsb.c:900-903
            for i in 0..n {
                self.d[i] = self.z[i] - x[i];
            }

            // The task before the line search: FG_START on the first iteration,
            // NEW_X or RESTART later. Only FG_LNSRCH matters to lnsrlb.
            task = Status::Fg;
            task_msg = Msg::NoMsg;
            // LINE666 (lbfgsb.c:905-976)
            loop {
                lnsrlb(
                    n,
                    l,
                    u,
                    nbd,
                    x,
                    *f,
                    &mut fold,
                    &mut gd,
                    &mut gdold,
                    g,
                    &mut self.d,
                    &mut self.r,
                    &mut self.t,
                    &self.z,
                    &mut stp,
                    &mut dnorm,
                    &mut dtd,
                    &mut stpmx,
                    iter,
                    &mut ifun,
                    &mut iback,
                    &mut nfgv,
                    &mut info,
                    &mut task,
                    &mut task_msg,
                    boxed,
                    cnstnd,
                    &mut self.ls,
                    &mut self.ln_task,
                    &mut self.ln_msg,
                );
                if info != 0 || iback >= maxls as isize {
                    // lbfgsb.c:910-950
                    x.copy_from_slice(&self.t);
                    g.copy_from_slice(&self.r);
                    *f = fold;
                    if col == 0 {
                        if info == 0 {
                            info = -9;
                            nfgv -= 1;
                            ifun -= 1;
                            iback -= 1;
                        }
                        let _ = (info, nfgv, ifun, iback);
                        return (Status::Abnormal, Msg::NoMsg);
                    }
                    if info == 0 {
                        nfgv -= 1;
                    }
                    info = 0;
                    col = 0;
                    head = 0;
                    theta = 1.0;
                    iupdat = 0;
                    updatd = false;
                    self.stats.resets += 1;
                    continue 'main;
                } else if task == Status::Fg && task_msg == Msg::FgLnsrch {
                    // The driver evaluates f and g at the trial x.
                    driver.fun_and_grad(x, f, g);
                    continue;
                } else {
                    // lbfgsb.c:963-975: a new iterate; the driver counts it and
                    // tests its limits (_lbfgsb_py.py:418-433).
                    iter += 1;
                    sbgnrm = projgr(n, l, u, nbd, x, g);
                    if let Some(msg) = driver.new_x(x, *f) {
                        return (Status::Stop, msg);
                    }
                    break;
                }
            }

            // LINE777 (lbfgsb.c:978-1011)
            if sbgnrm <= pgtol {
                return (Status::Convergence, Msg::ConvGrad);
            }
            let ddum = fold.abs().max(f.abs()).max(1.0);
            if (fold - *f) <= tol * ddum {
                return (Status::Convergence, Msg::ConvF);
            }

            // lbfgsb.c:1014-1037
            for i in 0..n {
                self.r[i] = g[i] - self.r[i];
            }
            let rn = dnrm2(n, &self.r);
            let rr = rn * rn;
            let dr;
            let ddum;
            if stp == 1.0 {
                dr = gd - gdold;
                ddum = -gdold;
            } else {
                dr = (gd - gdold) * stp;
                dscal(n, stp, &mut self.d);
                ddum = -gdold * stp;
            }
            if dr <= EPSMACH * ddum {
                updatd = false;
                self.stats.skipped += 1;
                continue 'main;
            }

            // lbfgsb.c:1044-1068
            updatd = true;
            iupdat += 1;
            self.stats.updates += 1;
            if iupdat > m {
                self.stats.shifts += 1;
            }
            matupd(
                n,
                m,
                &mut self.ws,
                &mut self.wy,
                &mut self.sy,
                &mut self.ss,
                &self.d,
                &self.r,
                &mut itail,
                iupdat,
                &mut col,
                &mut head,
                &mut theta,
                rr,
                dr,
                stp,
                dtd,
            );
            formt(m, &mut self.wt, &self.sy, &self.ss, col, theta, &mut info);
            if info != 0 {
                info = 0;
                col = 0;
                head = 0;
                theta = 1.0;
                iupdat = 0;
                updatd = false;
                self.stats.resets += 1;
                continue 'main;
            }
        }
    }
}

/// `errclb` (`lbfgsb.c:1825-1878`).
fn errclb(n: usize, m: usize, factr: f64, l: &[f64], u: &[f64], nbd: &[i32]) -> (Status, Msg) {
    let mut task = Status::Start;
    let mut msg = Msg::NoMsg;
    if n == 0 {
        task = Status::Error;
        msg = Msg::ErrorN;
    }
    if m == 0 {
        task = Status::Error;
        msg = Msg::ErrorM;
    }
    if factr < 0.0 {
        task = Status::Error;
        msg = Msg::ErrorFactr;
    }
    for i in 0..n {
        if nbd[i] < 0 || nbd[i] > 3 {
            task = Status::Error;
            msg = Msg::ErrorNbd;
        }
        if nbd[i] == 2 && l[i] > u[i] {
            task = Status::Error;
            msg = Msg::ErrorNofeas;
        }
    }
    (task, msg)
}

/// `active` (`lbfgsb.c:1081-1164`). Returns (prjctd, cnstnd, boxed).
fn active(
    n: usize,
    l: &[f64],
    u: &[f64],
    nbd: &[i32],
    x: &mut [f64],
    iwhere: &mut [i32],
) -> (bool, bool, bool) {
    let mut prjctd = false;
    let mut cnstnd = false;
    let mut boxed = true;
    for i in 0..n {
        if nbd[i] > 0 {
            if nbd[i] <= 2 && x[i] <= l[i] {
                if x[i] < l[i] {
                    prjctd = true;
                    x[i] = l[i];
                }
            } else if nbd[i] >= 2 && x[i] >= u[i] && x[i] > u[i] {
                prjctd = true;
                x[i] = u[i];
            }
        }
    }
    for i in 0..n {
        if nbd[i] != 2 {
            boxed = false;
        }
        if nbd[i] == 0 {
            iwhere[i] = -1;
        } else {
            cnstnd = true;
            if nbd[i] == 2 && u[i] - l[i] <= 0.0 {
                iwhere[i] = 3;
            } else {
                iwhere[i] = 0;
            }
        }
    }
    (prjctd, cnstnd, boxed)
}

/// `bmv` (`lbfgsb.c:1168-1294`): p = M v for the 2m x 2m middle matrix.
#[allow(clippy::too_many_arguments)]
fn bmv(m: usize, sy: &[f64], wt: &[f64], col: usize, v: &[f64], p: &mut [f64], info: &mut i32) {
    if col == 0 {
        return;
    }
    p[col] = v[col];
    for i in 1..col {
        let i2 = col + i;
        let mut ssum = 0.0;
        for k in 0..i {
            ssum += sy[i + m * k] * v[k] / sy[k + m * k];
        }
        p[i2] = v[i2] + ssum;
    }
    *info = dtrtrs_upper(true, col, 1, wt, m, &mut p[col..], col);
    if *info != 0 {
        return;
    }
    for i in 0..col {
        p[i] = v[i] / sy[i + m * i].sqrt();
    }
    *info = dtrtrs_upper(false, col, 1, wt, m, &mut p[col..], col);
    if *info != 0 {
        return;
    }
    for i in 0..col {
        p[i] = -p[i] / sy[i + m * i].sqrt();
    }
    for i in 0..col {
        let mut ssum = 0.0;
        for k in (i + 1)..col {
            ssum += sy[k + m * i] * p[col + k] / sy[i + m * i];
        }
        p[i] += ssum;
    }
}

/// `cauchy` (`lbfgsb.c:1298-1754`): the generalised Cauchy point.
#[allow(clippy::too_many_arguments)]
fn cauchy(
    n: usize,
    x: &[f64],
    l: &[f64],
    u: &[f64],
    nbd: &[i32],
    g: &[f64],
    iorder: &mut [usize],
    iwhere: &mut [i32],
    t: &mut [f64],
    d: &mut [f64],
    xcp: &mut [f64],
    m: usize,
    wy: &[f64],
    ws: &[f64],
    sy: &[f64],
    wt: &[f64],
    theta: f64,
    col: usize,
    head: usize,
    p: &mut [f64],
    c: &mut [f64],
    wbp: &mut [f64],
    v: &mut [f64],
    nseg: &mut usize,
    sbgnrm: f64,
    info: &mut i32,
) {
    let mut f1 = 0.0;
    let mut tl = 0.0;
    let mut tu = 0.0;

    if sbgnrm <= 0.0 {
        xcp.copy_from_slice(x);
        return;
    }
    let mut bnded = true;
    let mut nfree = n;
    let mut nbreak: isize = -1;
    let mut ibkmin = 0usize;
    let mut bkmin = 0.0;
    let col2 = 2 * col;

    for pi in p.iter_mut().take(col2) {
        *pi = 0.0;
    }

    // lbfgsb.c:1510-1576
    for i in 0..n {
        let neggi = -g[i];
        if iwhere[i] != 3 && iwhere[i] != -1 {
            if nbd[i] <= 2 {
                tl = x[i] - l[i];
            }
            if nbd[i] >= 2 {
                tu = u[i] - x[i];
            }
            let xlower = nbd[i] <= 2 && tl <= 0.0;
            let xupper = nbd[i] >= 2 && tu <= 0.0;
            iwhere[i] = 0;
            if xlower {
                if neggi <= 0.0 {
                    iwhere[i] = 1;
                }
            } else if xupper {
                if neggi >= 0.0 {
                    iwhere[i] = 2;
                }
            } else if neggi.abs() <= 0.0 {
                iwhere[i] = -3;
            }
        }
        let mut pointr = head;
        if iwhere[i] != 0 && iwhere[i] != -1 {
            d[i] = 0.0;
        } else {
            d[i] = neggi;
            f1 -= neggi * neggi;
            for j in 0..col {
                p[j] += wy[i + n * pointr] * neggi;
                p[col + j] += ws[i + n * pointr] * neggi;
                pointr = (pointr + 1) % m;
            }
            if nbd[i] <= 2 && nbd[i] != 0 && neggi < 0.0 {
                nbreak += 1;
                let nb = nbreak as usize;
                iorder[nb] = i;
                t[nb] = tl / (-neggi);
                if nbreak == 0 || t[nb] < bkmin {
                    bkmin = t[nb];
                    ibkmin = nb;
                }
            } else if nbd[i] >= 2 && neggi > 0.0 {
                nbreak += 1;
                let nb = nbreak as usize;
                iorder[nb] = i;
                t[nb] = tu / neggi;
                if nbreak == 0 || t[nb] < bkmin {
                    bkmin = t[nb];
                    ibkmin = nb;
                }
            } else {
                nfree -= 1;
                iorder[nfree] = i;
                if neggi.abs() > 0.0 {
                    bnded = false;
                }
            }
        }
    }

    // lbfgsb.c:1582-1593
    if theta != 1.0 {
        dscal(col, theta, &mut p[col..]);
    }
    xcp.copy_from_slice(x);
    if nbreak == -1 && nfree == n {
        return;
    }
    for cj in c.iter_mut().take(col2) {
        *cj = 0.0;
    }

    // lbfgsb.c:1602-1615
    let mut f2 = -theta * f1;
    let f2_org = f2;
    if col > 0 {
        bmv(m, sy, wt, col, p, v, info);
        if *info != 0 {
            return;
        }
        f2 -= ddot(col2, v, p);
    }
    let mut dtm = -f1 / f2;
    let mut tsum = 0.0;
    *nseg = 1;
    let mut nleft = nbreak;
    let mut iter = 0usize;
    let mut tj = 0.0;

    // lbfgsb.c:1619-1739
    // nbreak does not change in the loop: C's while ends only by break or return.
    if nbreak > -1 {
        loop {
            let tj0 = tj;
            let ibp;
            if iter == 0 {
                tj = bkmin;
                ibp = iorder[ibkmin];
            } else {
                if iter == 1 && ibkmin as isize != nbreak {
                    let nb = nbreak as usize;
                    t[ibkmin] = t[nb];
                    iorder[ibkmin] = iorder[nb];
                }
                hpsolb(nleft as usize, t, iorder, iter - 1);
                tj = t[nleft as usize];
                ibp = iorder[nleft as usize];
            }
            let dt = tj - tj0;

            if dtm < dt {
                if dtm <= 0.0 {
                    dtm = 0.0;
                }
                tsum += dtm;
                daxpy(n, tsum, d, xcp);
                if col > 0 {
                    daxpy(col2, dtm, p, c);
                }
                return;
            }

            tsum += dt;
            nleft -= 1;
            iter += 1;
            let mut dibp = d[ibp];
            d[ibp] = 0.0;
            let zibp;
            if dibp > 0.0 {
                zibp = u[ibp] - x[ibp];
                xcp[ibp] = u[ibp];
                iwhere[ibp] = 2;
            } else {
                zibp = l[ibp] - x[ibp];
                xcp[ibp] = l[ibp];
                iwhere[ibp] = 1;
            }
            // The C test is `nbreak == n`, which a 0-based nbreak never meets (the
            // Fortran's 1-based test was true when every variable broke). Kept as is.
            if nleft == -1 && nbreak == n as isize {
                dtm = dt;
                if col > 0 {
                    daxpy(col2, dtm, p, c);
                }
                return;
            }

            *nseg += 1;
            let dibp2 = dibp * dibp;
            f1 = f1 + dt * f2 + dibp2 - theta * dibp * zibp;
            f2 -= theta * dibp2;
            if col > 0 {
                daxpy(col2, dt, p, c);
                let mut pointr = head;
                for j in 0..col {
                    wbp[j] = wy[ibp + n * pointr];
                    wbp[col + j] = theta * ws[ibp + n * pointr];
                    pointr = (pointr + 1) % m;
                }
                bmv(m, sy, wt, col, wbp, v, info);
                if *info != 0 {
                    return;
                }
                let wmc = ddot(col2, c, v);
                let wmp = ddot(col2, p, v);
                let wmw = ddot(col2, wbp, v);
                dibp = -dibp;
                daxpy(col2, dibp, wbp, p);
                dibp = -dibp;
                f1 += dibp * wmc;
                f2 = f2 + dibp * 2.0 * wmp - dibp2 * wmw;
            }
            f2 = (EPSMACH * f2_org).max(f2);
            if nleft >= 0 {
                dtm = -f1 / f2;
            } else if bnded {
                dtm = 0.0;
                break;
            } else {
                dtm = -f1 / f2;
                break;
            }
        }
    }

    // lbfgsb.c:1743-1751
    if dtm <= 0.0 {
        dtm = 0.0;
    }
    tsum += dtm;
    daxpy(n, tsum, d, xcp);
    if col > 0 {
        daxpy(col2, dtm, p, c);
    }
}

/// `cmprlb` (`lbfgsb.c:1758-1821`): the reduced gradient at the Cauchy point.
#[allow(clippy::too_many_arguments)]
fn cmprlb(
    n: usize,
    m: usize,
    x: &[f64],
    g: &[f64],
    ws: &[f64],
    wy: &[f64],
    sy: &[f64],
    wt: &[f64],
    z: &[f64],
    r: &mut [f64],
    wa: &mut [f64],
    index: &[usize],
    theta: f64,
    col: usize,
    head: usize,
    nfree: usize,
    cnstnd: bool,
    info: &mut i32,
) {
    if !cnstnd && col > 0 {
        for i in 0..n {
            r[i] = -g[i];
        }
    } else {
        for i in 0..nfree {
            let k = index[i];
            r[i] = -theta * (z[k] - x[k]) - g[k];
        }
        // bmv(m, sy, wt, col, &wa[2*m], wa, info)
        let (p, v) = wa.split_at_mut(2 * m);
        bmv(m, sy, wt, col, v, p, info);
        if *info != 0 {
            *info = -8;
            return;
        }
        let mut pointr = head;
        for j in 0..col {
            let a1 = wa[j];
            let a2 = theta * wa[col + j];
            for i in 0..nfree {
                let k = index[i];
                r[i] = r[i] + wy[k + n * pointr] * a1 + ws[k + n * pointr] * a2;
            }
            pointr = (pointr + 1) % m;
        }
    }
}

/// `formk` (`lbfgsb.c:1882-2242`): forms and factorises the 2col x 2col matrix K.
#[allow(clippy::too_many_arguments)]
fn formk(
    n: usize,
    nsub: usize,
    ind: &[usize],
    nenter: usize,
    ileave: usize,
    indx2: &[usize],
    iupdat: usize,
    updatd: bool,
    wn: &mut [f64],
    wn1: &mut [f64],
    m: usize,
    ws: &[f64],
    wy: &[f64],
    sy: &[f64],
    theta: f64,
    col: usize,
    head: usize,
    info: &mut i32,
) {
    let m2 = 2 * m;
    let upcl = if updatd {
        if iupdat > m {
            // lbfgsb.c:2025-2033: shift the old parts of WN1.
            for jy in 0..(m - 1) {
                let js = m + jy;
                let cnt = m - (jy + 1);
                for q in 0..cnt {
                    wn1[jy + m2 * jy + q] = wn1[(jy + 1) + m2 * (jy + 1) + q];
                }
                for q in 0..cnt {
                    wn1[js + m2 * js + q] = wn1[(js + 1) + m2 * (js + 1) + q];
                }
                for q in 0..(m - 1) {
                    wn1[m + m2 * jy + q] = wn1[(m + 1) + m2 * (jy + 1) + q];
                }
            }
        }

        // lbfgsb.c:2038-2075: the new column and row of WN1.
        let pbegin = 0;
        let pend = nsub;
        let dbegin = nsub;
        let dend = n;
        let iy = col - 1;
        let is = m + col - 1;
        let mut ipntr = head + col - 1;
        if ipntr >= m {
            ipntr -= m;
        }
        let mut jpntr = head;
        for jy in 0..col {
            let js = m + jy;
            let mut temp1 = 0.0;
            let mut temp2 = 0.0;
            let mut temp3 = 0.0;
            for &k1 in &ind[pbegin..pend] {
                temp1 += wy[k1 + n * ipntr] * wy[k1 + n * jpntr];
            }
            for &k1 in &ind[dbegin..dend] {
                temp2 += ws[k1 + n * ipntr] * ws[k1 + n * jpntr];
                temp3 += ws[k1 + n * ipntr] * wy[k1 + n * jpntr];
            }
            wn1[iy + m2 * jy] = temp1;
            wn1[is + m2 * js] = temp2;
            wn1[is + m2 * jy] = temp3;
            jpntr = (jpntr + 1) % m;
        }

        // lbfgsb.c:2079-2097
        let jy = col - 1;
        let mut jpntr = head + col - 1;
        if jpntr >= m {
            jpntr -= m;
        }
        let mut ipntr = head;
        for i in 0..col {
            let is = m + i;
            let mut temp3 = 0.0;
            for &k1 in &ind[pbegin..pend] {
                temp3 += ws[k1 + n * ipntr] * wy[k1 + n * jpntr];
            }
            ipntr = (ipntr + 1) % m;
            wn1[is + m2 * jy] = temp3;
        }
        col - 1
    } else {
        col
    };

    // lbfgsb.c:2107-2142
    let mut ipntr = head;
    for iy in 0..upcl {
        let is = m + iy;
        let mut jpntr = head;
        for jy in 0..=iy {
            let js = m + jy;
            let mut temp1 = 0.0;
            let mut temp2 = 0.0;
            let mut temp3 = 0.0;
            let mut temp4 = 0.0;
            for &k1 in &indx2[0..nenter] {
                temp1 += wy[k1 + n * ipntr] * wy[k1 + n * jpntr];
                temp2 += ws[k1 + n * ipntr] * ws[k1 + n * jpntr];
            }
            for &k1 in &indx2[ileave..n] {
                temp3 += wy[k1 + n * ipntr] * wy[k1 + n * jpntr];
                temp4 += ws[k1 + n * ipntr] * ws[k1 + n * jpntr];
            }
            wn1[iy + m2 * jy] = wn1[iy + m2 * jy] + temp1 - temp3;
            wn1[is + m2 * js] = wn1[is + m2 * js] - temp2 + temp4;
            jpntr = (jpntr + 1) % m;
        }
        ipntr = (ipntr + 1) % m;
    }

    // lbfgsb.c:2146-2176
    let mut ipntr = head;
    for is in m..(m + upcl) {
        let mut jpntr = head;
        for jy in 0..upcl {
            let mut temp1 = 0.0;
            let mut temp3 = 0.0;
            for &k1 in &indx2[0..nenter] {
                temp1 += ws[k1 + n * ipntr] * wy[k1 + n * jpntr];
            }
            for &k1 in &indx2[ileave..n] {
                temp3 += ws[k1 + n * ipntr] * wy[k1 + n * jpntr];
            }
            if is <= jy + m {
                wn1[is + m2 * jy] = wn1[is + m2 * jy] + temp1 - temp3;
            } else {
                wn1[is + m2 * jy] = wn1[is + m2 * jy] - temp1 + temp3;
            }
            jpntr = (jpntr + 1) % m;
        }
        ipntr = (ipntr + 1) % m;
    }

    // lbfgsb.c:2182-2206: the upper triangle of WN.
    for iy in 0..col {
        let is = col + iy;
        let is1 = m + iy;
        for jy in 0..=iy {
            let js = col + jy;
            let js1 = m + jy;
            wn[jy + m2 * iy] = wn1[iy + m2 * jy] / theta;
            wn[js + m2 * is] = wn1[is1 + m2 * js1] * theta;
        }
        for jy in 0..iy {
            wn[jy + m2 * is] = -wn1[is1 + m2 * jy];
        }
        for jy in iy..col {
            wn[jy + m2 * is] = wn1[is1 + m2 * jy];
        }
        wn[iy + m2 * iy] += sy[iy + m * iy];
    }

    // lbfgsb.c:2216-2239
    *info = dpotrf_upper(col, wn, m2);
    if *info != 0 {
        *info = -1;
        return;
    }
    let col2 = 2 * col;
    {
        let (a, b) = wn.split_at_mut(m2 * col);
        // The info of this dtrtrs is not tested in lbfgsb.c:2223.
        let _ = dtrtrs_upper(true, col, col, a, m2, b, m2);
    }
    for is in col..col2 {
        for js in is..col2 {
            let dot = ddot(col, &wn[m2 * is..], &wn[m2 * js..]);
            wn[is + m2 * js] += dot;
        }
    }
    *info = dpotrf_upper(col, &mut wn[col + m2 * col..], m2);
    if *info != 0 {
        *info = -2;
    }
}

/// `formt` (`lbfgsb.c:2246-2309`): T = theta SS + L D^-1 L', factorised.
fn formt(m: usize, wt: &mut [f64], sy: &[f64], ss: &[f64], col: usize, theta: f64, info: &mut i32) {
    for j in 0..col {
        wt[m * j] = theta * ss[m * j];
    }
    for i in 1..col {
        for j in i..col {
            let k1 = if i > j { j } else { i };
            let mut ddum = 0.0;
            for k in 0..k1 {
                ddum += (sy[i + m * k] * sy[j + m * k]) / sy[k + m * k];
            }
            wt[i + m * j] = ddum + theta * ss[i + m * j];
        }
    }
    *info = dpotrf_upper(col, wt, m);
    if *info != 0 {
        *info = -3;
    }
}

/// `freev` (`lbfgsb.c:2313-2407`): the entering and leaving variables.
#[allow(clippy::too_many_arguments)]
fn freev(
    n: usize,
    nfree: &mut usize,
    idx: &mut [usize],
    nenter: &mut usize,
    ileave: &mut usize,
    idx2: &mut [usize],
    iwhere: &[i32],
    wrk: &mut bool,
    updatd: bool,
    cnstnd: bool,
    iter: usize,
) {
    *nenter = 0;
    *ileave = n;
    if iter > 0 && cnstnd {
        for i in 0..*nfree {
            let k = idx[i];
            if iwhere[k] > 0 {
                *ileave -= 1;
                idx2[*ileave] = k;
            }
        }
        for i in *nfree..n {
            let k = idx[i];
            if iwhere[k] <= 0 {
                idx2[*nenter] = k;
                *nenter += 1;
            }
        }
    }
    *wrk = *ileave < n || *nenter > 0 || updatd;
    *nfree = 0;
    let mut iact = n;
    for i in 0..n {
        if iwhere[i] <= 0 {
            idx[*nfree] = i;
            *nfree += 1;
        } else {
            iact -= 1;
            idx[iact] = i;
        }
    }
}

/// `hpsolb` (`lbfgsb.c:2411-2530`): heap sort of the break points. `n` is the C
/// argument (nleft); the heap holds t[0..=n].
fn hpsolb(n: usize, t: &mut [f64], iorder: &mut [usize], iheap: usize) {
    if iheap == 0 {
        for k in 2..=(n + 1) {
            let ddum = t[k - 1];
            let indxin = iorder[k - 1];
            let mut i = k;
            while i > 1 {
                let j = i / 2;
                if ddum < t[j - 1] {
                    t[i - 1] = t[j - 1];
                    iorder[i - 1] = iorder[j - 1];
                    i = j;
                } else {
                    break;
                }
            }
            t[i - 1] = ddum;
            iorder[i - 1] = indxin;
        }
    }
    if n > 0 {
        let mut i = 1;
        let out = t[0];
        let indxout = iorder[0];
        let ddum = t[n];
        let indxin = iorder[n];
        loop {
            let mut j = i + i;
            if j <= n {
                if t[j] < t[j - 1] {
                    j += 1;
                }
                if t[j - 1] < ddum {
                    t[i - 1] = t[j - 1];
                    iorder[i - 1] = iorder[j - 1];
                    i = j;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        t[i - 1] = ddum;
        iorder[i - 1] = indxin;
        t[n] = out;
        iorder[n] = indxout;
    }
}

/// `lnsrlb` (`lbfgsb.c:2534-2674`): one step of the Moré-Thuente line search.
#[allow(clippy::too_many_arguments)]
fn lnsrlb(
    n: usize,
    l: &[f64],
    u: &[f64],
    nbd: &[i32],
    x: &mut [f64],
    f: f64,
    fold: &mut f64,
    gd: &mut f64,
    gdold: &mut f64,
    g: &[f64],
    d: &mut [f64],
    r: &mut [f64],
    t: &mut [f64],
    z: &[f64],
    stp: &mut f64,
    dnorm: &mut f64,
    dtd: &mut f64,
    stpmx: &mut f64,
    iter: usize,
    ifun: &mut isize,
    iback: &mut isize,
    nfgv: &mut usize,
    info: &mut i32,
    task: &mut Status,
    task_msg: &mut Msg,
    boxed: bool,
    cnstnd: bool,
    ls: &mut Dcsrch,
    temp_task: &mut Status,
    temp_taskmsg: &mut Msg,
) {
    let ftol = 1e-3;
    let gtol = 0.9;
    let xtol = 0.1;

    if *task_msg != Msg::FgLnsrch {
        *dnorm = dnrm2(n, d);
        *dtd = *dnorm * *dnorm;

        *stpmx = 1.0e+10;
        if cnstnd {
            if iter == 0 {
                *stpmx = 1.0;
            } else {
                for i in 0..n {
                    let a1 = d[i];
                    if nbd[i] != 0 {
                        if a1 < 0.0 && nbd[i] <= 2 {
                            let a2 = l[i] - x[i];
                            if a2 >= 0.0 {
                                *stpmx = 0.0;
                            } else if a1 * *stpmx < a2 {
                                *stpmx = a2 / a1;
                            }
                        } else if a1 > 0.0 && nbd[i] >= 2 {
                            let a2 = u[i] - x[i];
                            if a2 <= 0.0 {
                                *stpmx = 0.0;
                            } else if a1 * *stpmx > a2 {
                                *stpmx = a2 / a1;
                            }
                        }
                    }
                }
            }
        }

        if iter == 0 && !boxed {
            *stp = (1.0 / *dnorm).min(*stpmx);
        } else {
            *stp = 1.0;
        }

        t[..n].copy_from_slice(&x[..n]);
        r[..n].copy_from_slice(&g[..n]);
        *fold = f;
        *ifun = 0;
        *iback = 0;
        *temp_task = Status::Start;
        *temp_taskmsg = Msg::NoMsg;
    }

    *gd = ddot(n, g, d);
    if *ifun == 0 {
        *gdold = *gd;
        if *gd >= 0.0 {
            // The directional derivative is >= 0: the line search is impossible.
            *info = -4;
            return;
        }
    }
    dcsrch(
        f,
        *gd,
        stp,
        ftol,
        gtol,
        xtol,
        0.0,
        *stpmx,
        temp_task,
        temp_taskmsg,
        ls,
    );

    if *temp_task != Status::Convergence && *temp_task != Status::Warning {
        *task = Status::Fg;
        *task_msg = Msg::FgLnsrch;
        *ifun += 1;
        *nfgv += 1;
        *iback = *ifun - 1;
        if *stp == 1.0 {
            x[..n].copy_from_slice(&z[..n]);
        } else {
            for i in 0..n {
                x[i] = *stp * d[i] + t[i];
                if nbd[i] == 1 || nbd[i] == 2 {
                    x[i] = x[i].max(l[i]);
                }
                if nbd[i] == 2 || nbd[i] == 3 {
                    x[i] = x[i].min(u[i]);
                }
            }
        }
    } else {
        *task = Status::NewX;
        *task_msg = Msg::NoMsg;
    }
}

/// `matupd` (`lbfgsb.c:2678-2752`): updates the matrices WS, WY, SY and SS.
#[allow(clippy::too_many_arguments)]
fn matupd(
    n: usize,
    m: usize,
    ws: &mut [f64],
    wy: &mut [f64],
    sy: &mut [f64],
    ss: &mut [f64],
    d: &[f64],
    r: &[f64],
    itail: &mut usize,
    iupdat: usize,
    col: &mut usize,
    head: &mut usize,
    theta: &mut f64,
    rr: f64,
    dr: f64,
    stp: f64,
    dtd: f64,
) {
    if iupdat <= m {
        *col = iupdat;
        *itail = (*head + iupdat - 1) % m;
    } else {
        *itail = (*itail + 1) % m;
        *head = (*head + 1) % m;
    }
    ws[*itail * n..*itail * n + n].copy_from_slice(&d[..n]);
    wy[*itail * n..*itail * n + n].copy_from_slice(&r[..n]);

    *theta = rr / dr;

    if iupdat > m {
        // lbfgsb.c:2729-2735: move the old information.
        for j in 1..*col {
            for q in 0..j {
                ss[m * (j - 1) + q] = ss[1 + m * j + q];
            }
            for q in 0..(*col - j) {
                sy[(j - 1) + m * (j - 1) + q] = sy[j + m * j + q];
            }
        }
    }

    let mut pointr = *head;
    for j in 0..(*col - 1) {
        sy[*col - 1 + m * j] = ddot(n, d, &wy[pointr * n..]);
        ss[j + m * (*col - 1)] = ddot(n, &ws[pointr * n..], d);
        pointr = (pointr + 1) % m;
    }
    ss[(*col - 1) + m * (*col - 1)] = if stp == 1.0 { dtd } else { stp * stp * dtd };
    sy[(*col - 1) + m * (*col - 1)] = dr;
}

/// `projgr` (`lbfgsb.c:2756-2805`): the infinity norm of the projected gradient.
/// A NaN in g gives NaN (`lbfgsb.c:2785-2790`).
fn projgr(n: usize, l: &[f64], u: &[f64], nbd: &[i32], x: &[f64], g: &[f64]) -> f64 {
    let mut sbgnrm = 0.0f64;
    for i in 0..n {
        let mut gi = g[i];
        if gi.is_nan() {
            return gi;
        }
        if nbd[i] != 0 {
            if gi < 0.0 {
                if nbd[i] >= 2 {
                    gi = (x[i] - u[i]).max(gi);
                }
            } else if nbd[i] <= 2 {
                gi = (x[i] - l[i]).min(gi);
            }
        }
        sbgnrm = sbgnrm.max(gi.abs());
    }
    sbgnrm
}

/// `subsm` (`lbfgsb.c:2808-3161`): subspace minimisation with the L-BFGS-B 3.0
/// projection. Returns true when it went back along the projected path.
#[allow(clippy::too_many_arguments)]
fn subsm(
    n: usize,
    m: usize,
    nsub: usize,
    ind: &[usize],
    l: &[f64],
    u: &[f64],
    nbd: &[i32],
    x: &mut [f64],
    d: &mut [f64],
    xp: &mut [f64],
    ws: &[f64],
    wy: &[f64],
    theta: f64,
    xx: &[f64],
    gg: &[f64],
    col: usize,
    head: usize,
    iword: &mut i32,
    wv: &mut [f64],
    wn: &[f64],
    info: &mut i32,
) -> bool {
    if nsub == 0 {
        return false;
    }

    // lbfgsb.c:2999-3013
    let mut pointr = head;
    for i in 0..col {
        let mut temp1 = 0.0;
        let mut temp2 = 0.0;
        for j in 0..nsub {
            let k = ind[j];
            temp1 += wy[k + n * pointr] * d[j];
            temp2 += ws[k + n * pointr] * d[j];
        }
        wv[i] = temp1;
        wv[col + i] = theta * temp2;
        pointr = (pointr + 1) % m;
    }

    // lbfgsb.c:3016-3027
    let m2 = 2 * m;
    let col2 = 2 * col;
    *info = dtrtrs_upper(true, col2, 1, wn, m2, wv, m2);
    if *info != 0 {
        return false;
    }
    for wvi in wv.iter_mut().take(col) {
        *wvi = -*wvi;
    }
    *info = dtrtrs_upper(false, col2, 1, wn, m2, wv, m2);
    if *info != 0 {
        return false;
    }

    // lbfgsb.c:3030-3047
    let mut pointr = head;
    for jy in 0..col {
        let js = col + jy;
        for i in 0..nsub {
            let k = ind[i];
            d[i] = d[i] + (wy[k + n * pointr] * wv[jy] / theta) + (ws[k + n * pointr] * wv[js]);
        }
        pointr = (pointr + 1) % m;
    }
    let temp = 1.0 / theta;
    dscal(nsub, temp, d);

    // lbfgsb.c:3052-3084: project the subspace minimiser onto the box.
    *iword = 0;
    xp.copy_from_slice(&x[..n]);
    for i in 0..nsub {
        let k = ind[i];
        let dk = d[i];
        let mut xk = x[k];
        if nbd[k] != 0 {
            if nbd[k] == 1 {
                x[k] = l[k].max(xk + dk);
                if x[k] == l[k] {
                    *iword = 1;
                }
            } else if nbd[k] == 2 {
                xk = l[k].max(xk + dk);
                x[k] = u[k].min(xk);
                if x[k] == l[k] || x[k] == u[k] {
                    *iword = 1;
                }
            } else if nbd[k] == 3 {
                x[k] = u[k].min(xk + dk);
                if x[k] == u[k] {
                    *iword = 1;
                }
            }
        } else {
            x[k] = xk + dk;
        }
    }
    if *iword == 0 {
        return false;
    }

    // lbfgsb.c:3090-3100: is the projected point a descent direction?
    let mut dd_p = 0.0;
    for i in 0..n {
        dd_p += (x[i] - xx[i]) * gg[i];
    }
    if dd_p > 0.0 {
        x[..n].copy_from_slice(&xp[..n]);
    } else {
        return false;
    }

    // lbfgsb.c:3103-3157: the 2.1 projection along the path.
    let mut alpha = 1.0;
    let mut temp1 = 1.0;
    let mut ibd = 0usize;
    for i in 0..nsub {
        let k = ind[i];
        let dk = d[i];
        if nbd[k] != 0 {
            if dk < 0.0 && nbd[k] <= 2 {
                let temp2 = l[k] - x[k];
                if temp2 >= 0.0 {
                    temp1 = 0.0;
                } else if dk * alpha < temp2 {
                    temp1 = temp2 / dk;
                }
            } else if dk > 0.0 && nbd[k] >= 2 {
                let temp2 = u[k] - x[k];
                if temp2 <= 0.0 {
                    temp1 = 0.0;
                } else if dk * alpha > temp2 {
                    temp1 = temp2 / dk;
                }
            }
            if temp1 < alpha {
                alpha = temp1;
                ibd = i;
            }
        }
    }
    if alpha < 1.0 {
        let dk = d[ibd];
        let k = ind[ibd];
        if dk > 0.0 {
            x[k] = u[k];
            d[ibd] = 0.0;
        } else if dk < 0.0 {
            x[k] = l[k];
            d[ibd] = 0.0;
        }
    }
    for i in 0..nsub {
        let k = ind[i];
        x[k] += alpha * d[i];
    }
    true
}

/// `dcsrch` (`lbfgsb.c:3165-3480`), MINPACK-2.
#[allow(clippy::too_many_arguments)]
fn dcsrch(
    f: f64,
    g: f64,
    stp: &mut f64,
    ftol: f64,
    gtol: f64,
    xtol: f64,
    stpmin: f64,
    stpmax: f64,
    task: &mut Status,
    task_msg: &mut Msg,
    save: &mut Dcsrch,
) {
    let xtrapl = 1.1;
    let xtrapu = 4.0;
    let mut s;

    if *task == Status::Start {
        // lbfgsb.c:3311-3321
        if *stp < stpmin {
            *task = Status::Error;
            *task_msg = Msg::ErrorStp1;
        }
        if *stp > stpmax {
            *task = Status::Error;
            *task_msg = Msg::ErrorStp2;
        }
        if g >= 0.0 {
            *task = Status::Error;
            *task_msg = Msg::ErrorInitg;
        }
        if ftol < 0.0 {
            *task = Status::Error;
            *task_msg = Msg::ErrorFtol;
        }
        if gtol < 0.0 {
            *task = Status::Error;
            *task_msg = Msg::ErrorGtol;
        }
        if xtol < 0.0 {
            *task = Status::Error;
            *task_msg = Msg::ErrorXtol;
        }
        if stpmin < 0.0 {
            *task = Status::Error;
            *task_msg = Msg::ErrorStpmin;
        }
        if stpmax < stpmin {
            *task = Status::Error;
            *task_msg = Msg::ErrorStpmax;
        }
        if *task == Status::Error {
            return;
        }

        // lbfgsb.c:3324-3351
        s = Dcsrch {
            brackt: false,
            stage: 1,
            finit: f,
            ginit: g,
            gtest: ftol * g,
            width: stpmax - stpmin,
            width1: (stpmax - stpmin) / 0.5,
            stx: 0.0,
            fx: f,
            gx: g,
            sty: 0.0,
            fy: f,
            gy: g,
            stmin: 0.0,
            stmax: *stp + xtrapu * *stp,
        };
        *task = Status::Fg;
        *task_msg = Msg::NoMsg;
        *save = s;
        return;
    }
    s = save.clone();

    // lbfgsb.c:3378-3411
    let ftest = s.finit + *stp * s.gtest;
    if s.stage == 1 && f <= ftest && g >= 0.0 {
        s.stage = 2;
    }
    if s.brackt && (*stp <= s.stmin || *stp >= s.stmax) {
        *task = Status::Warning;
        *task_msg = Msg::WarnRound;
    }
    if s.brackt && (s.stmax - s.stmin) <= xtol * s.stmax {
        *task = Status::Warning;
        *task_msg = Msg::WarnXtol;
    }
    if *stp == stpmax && f <= ftest && g <= s.gtest {
        *task = Status::Warning;
        *task_msg = Msg::WarnStpmax;
    }
    if *stp == stpmin && (f > ftest || g >= s.gtest) {
        *task = Status::Warning;
        *task_msg = Msg::WarnStpmin;
    }
    if f <= ftest && g.abs() <= gtol * (-s.ginit) {
        *task = Status::Convergence;
    }
    if *task == Status::Warning || *task == Status::Convergence {
        *save = s;
        return;
    }

    // lbfgsb.c:3416-3438
    if s.stage == 1 && f <= s.fx && f > ftest {
        let fm = f - *stp * s.gtest;
        let mut fxm = s.fx - s.stx * s.gtest;
        let mut fym = s.fy - s.sty * s.gtest;
        let gm = g - s.gtest;
        let mut gxm = s.gx - s.gtest;
        let mut gym = s.gy - s.gtest;
        dcstep(
            &mut s.stx,
            &mut fxm,
            &mut gxm,
            &mut s.sty,
            &mut fym,
            &mut gym,
            stp,
            fm,
            gm,
            &mut s.brackt,
            s.stmin,
            s.stmax,
        );
        s.fx = fxm + s.stx * s.gtest;
        s.fy = fym + s.sty * s.gtest;
        s.gx = gxm + s.gtest;
        s.gy = gym + s.gtest;
    } else {
        dcstep(
            &mut s.stx,
            &mut s.fx,
            &mut s.gx,
            &mut s.sty,
            &mut s.fy,
            &mut s.gy,
            stp,
            f,
            g,
            &mut s.brackt,
            s.stmin,
            s.stmax,
        );
    }

    // lbfgsb.c:3441-3472
    if s.brackt {
        if (s.sty - s.stx).abs() >= 0.66 * s.width1 {
            *stp = s.stx + 0.5 * (s.sty - s.stx);
        }
        s.width1 = s.width;
        s.width = (s.sty - s.stx).abs();
    }
    if s.brackt {
        s.stmin = s.stx.min(s.sty);
        s.stmax = s.stx.max(s.sty);
    } else {
        s.stmin = *stp + xtrapl * (*stp - s.stx);
        s.stmax = *stp + xtrapu * (*stp - s.stx);
    }
    // C fmax and fmin return the other argument when one is NaN; so do f64::max
    // and f64::min. The infinite-value path depends on this.
    *stp = stp.max(stpmin);
    *stp = stp.min(stpmax);
    // The test keeps the C form of dcsrch; older clippy asks for a shorter form.
    #[allow(clippy::nonminimal_bool)]
    let unusual = (s.brackt && (*stp <= s.stmin || *stp >= s.stmax))
        || (s.brackt && s.stmax - s.stmin <= xtol * s.stmax);
    if unusual {
        *stp = s.stx;
    }
    *task = Status::Fg;
    *task_msg = Msg::NoMsg;
    *save = s;
}

/// `dcstep` (`lbfgsb.c:3513-3769`), MINPACK-2: the safeguarded step.
#[allow(clippy::too_many_arguments)]
fn dcstep(
    stx: &mut f64,
    fx: &mut f64,
    dx: &mut f64,
    sty: &mut f64,
    fy: &mut f64,
    dy: &mut f64,
    stp: &mut f64,
    fp: f64,
    dp: f64,
    brackt: &mut bool,
    stpmin: f64,
    stpmax: f64,
) {
    let sgnd = dp * (*dx / dx.abs());
    let stpf;
    if fp > *fx {
        // Case 1: a higher function value; the minimum is bracketed.
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs().max(dp.abs()));
        let ts = theta / s;
        let mut gamma = s * (ts * ts - (*dx / s) * (dp / s)).sqrt();
        if *stp < *stx {
            gamma = -gamma;
        }
        let p = (gamma - *dx) + theta;
        let q = ((gamma - *dx) + gamma) + dp;
        let r = p / q;
        let stpc = *stx + r * (*stp - *stx);
        let stpq = *stx + ((*dx / ((*fx - fp) / (*stp - *stx) + *dx)) / 2.0) * (*stp - *stx);
        if (stpc - *stx).abs() < (stpq - *stx).abs() {
            stpf = stpc;
        } else {
            stpf = stpc + (stpq - stpc) / 2.0;
        }
        *brackt = true;
    } else if sgnd < 0.0 {
        // Case 2: derivatives of opposite sign; the minimum is bracketed.
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs().max(dp.abs()));
        let ts = theta / s;
        let mut gamma = s * (ts * ts - (*dx / s) * (dp / s)).sqrt();
        if *stp > *stx {
            gamma = -gamma;
        }
        let p = (gamma - dp) + theta;
        let q = ((gamma - dp) + gamma) + *dx;
        let r = p / q;
        let stpc = *stp + r * (*stx - *stp);
        let stpq = *stp + (dp / (dp - *dx)) * (*stx - *stp);
        if (stpc - *stp).abs() > (stpq - *stp).abs() {
            stpf = stpc;
        } else {
            stpf = stpq;
        }
        *brackt = true;
    } else if dp.abs() < dx.abs() {
        // Case 3: the derivative magnitude decreases.
        let theta = 3.0 * (*fx - fp) / (*stp - *stx) + *dx + dp;
        let s = theta.abs().max(dx.abs().max(dp.abs()));
        let ts = theta / s;
        let mut gamma = s * (0.0f64).max(ts * ts - (*dx / s) * (dp / s)).sqrt();
        if *stp > *stx {
            gamma = -gamma;
        }
        let p = (gamma - dp) + theta;
        let q = (gamma + (*dx - dp)) + gamma;
        let r = p / q;
        let stpc = if r < 0.0 && gamma != 0.0 {
            *stp + r * (*stx - *stp)
        } else if *stp > *stx {
            stpmax
        } else {
            stpmin
        };
        let stpq = *stp + (dp / (dp - *dx)) * (*stx - *stp);
        if *brackt {
            let mut sf = if (stpc - *stp).abs() < (stpq - *stp).abs() {
                stpc
            } else {
                stpq
            };
            if *stp > *stx {
                sf = (*stp + 0.66 * (*sty - *stp)).min(sf);
            } else {
                sf = (*stp + 0.66 * (*sty - *stp)).max(sf);
            }
            stpf = sf;
        } else {
            let mut sf = if (stpc - *stp).abs() > (stpq - *stp).abs() {
                stpc
            } else {
                stpq
            };
            sf = stpmax.min(sf);
            sf = stpmin.max(sf);
            stpf = sf;
        }
    } else {
        // Case 4: the derivative magnitude does not decrease.
        if *brackt {
            let theta = 3.0 * (fp - *fy) / (*sty - *stp) + *dy + dp;
            let s = theta.abs().max(dy.abs().max(dp.abs()));
            let ts = theta / s;
            let mut gamma = s * (ts * ts - (*dy / s) * (dp / s)).sqrt();
            if *stp > *sty {
                gamma = -gamma;
            }
            let p = (gamma - dp) + theta;
            let q = ((gamma - dp) + gamma) + *dy;
            let r = p / q;
            let stpc = *stp + r * (*sty - *stp);
            stpf = stpc;
        } else if *stp > *stx {
            stpf = stpmax;
        } else {
            stpf = stpmin;
        }
    }

    // lbfgsb.c:3749-3762: update the interval that contains a minimiser.
    if fp > *fx {
        *sty = *stp;
        *fy = fp;
        *dy = dp;
    } else {
        if sgnd < 0.0 {
            *sty = *stx;
            *fy = *fx;
            *dy = *dx;
        }
        *stx = *stp;
        *fx = fp;
        *dx = dp;
    }
    *stp = stpf;
}

// ---- BLAS level 1, reference order ------------------------------------------------

fn ddot(n: usize, x: &[f64], y: &[f64]) -> f64 {
    let mut s = 0.0;
    for i in 0..n {
        s += x[i] * y[i];
    }
    s
}

/// Reference `daxpy`: y += a x, nothing when a == 0.
fn daxpy(n: usize, a: f64, x: &[f64], y: &mut [f64]) {
    if n == 0 || a == 0.0 {
        return;
    }
    for i in 0..n {
        y[i] += a * x[i];
    }
}

fn dscal(n: usize, a: f64, x: &mut [f64]) {
    for xi in x.iter_mut().take(n) {
        *xi *= a;
    }
}

fn dnrm2(n: usize, x: &[f64]) -> f64 {
    ddot(n, x, x).sqrt()
}

// ---- LAPACK, unblocked ------------------------------------------------------------

/// `dpotrf("U")` as LAPACK's unblocked `dpotf2`: A = U'U for the leading n x n part
/// of a column-major `a` with leading dimension `lda`. Returns info (0, or the
/// 1-based column of the first pivot that is not positive or is NaN).
fn dpotrf_upper(n: usize, a: &mut [f64], lda: usize) -> i32 {
    for j in 0..n {
        let mut ajj = a[j + lda * j];
        let mut dot = 0.0;
        for k in 0..j {
            dot += a[k + lda * j] * a[k + lda * j];
        }
        ajj -= dot;
        if ajj <= 0.0 || ajj.is_nan() {
            a[j + lda * j] = ajj;
            return (j + 1) as i32;
        }
        ajj = ajj.sqrt();
        a[j + lda * j] = ajj;
        if j + 1 < n {
            // dgemv("T", -1, ...) then dscal(1 / ajj)
            for c in (j + 1)..n {
                let mut temp = 0.0;
                for k in 0..j {
                    temp += a[k + lda * c] * a[k + lda * j];
                }
                a[j + lda * c] += -temp;
            }
            let r = 1.0 / ajj;
            for c in (j + 1)..n {
                a[j + lda * c] *= r;
            }
        }
    }
    0
}

/// `dtrtrs("U", trans, "N")` with LAPACK's reference `dtrsm`: solves A X = B
/// (`trans` false) or A' X = B (`trans` true) for an upper triangular n x n A.
/// Returns info: the 1-based index of a zero diagonal element, or 0.
fn dtrtrs_upper(
    trans: bool,
    n: usize,
    nrhs: usize,
    a: &[f64],
    lda: usize,
    b: &mut [f64],
    ldb: usize,
) -> i32 {
    for i in 0..n {
        if a[i + lda * i] == 0.0 {
            return (i + 1) as i32;
        }
    }
    for j in 0..nrhs {
        let bj = &mut b[ldb * j..];
        if trans {
            for i in 0..n {
                let mut temp = bj[i];
                for k in 0..i {
                    temp -= a[k + lda * i] * bj[k];
                }
                temp /= a[i + lda * i];
                bj[i] = temp;
            }
        } else {
            for k in (0..n).rev() {
                if bj[k] != 0.0 {
                    bj[k] /= a[k + lda * k];
                    let bk = bj[k];
                    for i in 0..k {
                        bj[i] -= bk * a[i + lda * k];
                    }
                }
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmax_semantics_of_f64_max() {
        // C fmax(NaN, 0) == 0: the infinite-value path needs this.
        assert_eq!(f64::NAN.max(0.0), 0.0);
        assert_eq!(0.0f64.min(f64::NAN), 0.0);
    }

    #[test]
    fn dpotrf_fails_on_nan_and_nonpositive() {
        let mut a = vec![1.0, 0.0, 0.0, -1.0];
        assert_eq!(dpotrf_upper(2, &mut a, 2), 2);
        let mut a = vec![f64::NAN];
        assert_eq!(dpotrf_upper(1, &mut a, 1), 1);
    }

    #[test]
    fn hpsolb_pops_the_smallest() {
        let mut t = vec![3.0, 1.0, 2.0, 0.5];
        let mut io = vec![0, 1, 2, 3];
        // Build the heap over t[0..=3] and move the least to t[3].
        hpsolb(3, &mut t, &mut io, 0);
        assert_eq!(t[3], 0.5);
        assert_eq!(io[3], 3);
        hpsolb(2, &mut t, &mut io, 1);
        assert_eq!(t[2], 1.0);
        assert_eq!(io[2], 1);
    }
}
