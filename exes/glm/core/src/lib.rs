//! Block-design GLM of glm.py: design matrix, OLS and AR(1) Prais-Winsten t statistics, scipy-compatible Gaussian
//! smoothing. Voxel arrays are NIfTI order (x fastest). float32 steps of the NumPy reference stay float32 here, so
//! the AR(1) quantisation picks the same groups.

pub mod io;

/// Row-major n x p matrix.
#[derive(Clone)]
pub struct Mat {
    pub n: usize,
    pub p: usize,
    pub v: Vec<f64>,
}

impl Mat {
    pub(crate) fn at(&self, r: usize, c: usize) -> f64 {
        self.v[r * self.p + c]
    }
}

pub struct Event {
    pub onset: f64,
    pub duration: f64,
    pub trial_type: String,
}

pub(crate) const MOTION: [&str; 6] = ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z"];

/// `np.arange(0, stop, step)` length.
fn arange_len(stop: f64, step: f64) -> usize {
    (stop / step).ceil().max(0.0) as usize
}

/// scipy.stats.gamma.pdf(x, a) with integer shape a (scale 1).
fn gamma_pdf(x: f64, a: u32) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let ln_fact: f64 = (1..a).map(|k| (k as f64).ln()).sum(); // ln (a-1)!
    ((a - 1) as f64 * x.ln() - x - ln_fact).exp()
}

/// (design matrix, dropped volumes): condition boxcars convolved with a double-gamma HRF, intercept, DCT drift
/// (128 s) and 6 motion parameters; non-steady-state volumes (confound columns non_steady_state_*) dropped.
/// `start`: BIDS StartTime, the time within each TR the volume represents; default mid-TR.
pub fn design(
    nvol: usize,
    tr: f64,
    events: &[Event],
    conditions: &[&str],
    conf: &[(String, Vec<f64>)],
    start: Option<f64>,
) -> Result<(Mat, usize), String> {
    if !(tr.is_finite() && tr > 0.0) {
        return Err(format!("invalid RepetitionTime {tr}"));
    }
    let drop = conf
        .iter()
        .filter(|(k, _)| k.starts_with("non_steady_state"))
        .count();
    if drop >= nvol {
        return Err(format!(
            "{drop} non-steady-state volumes leave nothing of {nvol}"
        ));
    }
    let n = nvol - drop;
    let dt = 0.1; // build the regressor at 100 ms, sample at the volume's reference time
    let nt = arange_len(nvol as f64 * tr, dt);
    let t = |i: usize| i as f64 * dt;
    let hrf: Vec<f64> = (0..arange_len(32.0, dt))
        .map(|i| gamma_pdf(t(i), 6) - gamma_pdf(t(i), 16) / 6.0)
        .collect();
    let sample: Vec<usize> = (0..nvol)
        .map(|i| {
            let s = ((i as f64 * tr + start.unwrap_or(tr / 2.0)) / dt).round_ties_even();
            s.clamp(0.0, (nt - 1) as f64) as usize
        })
        .collect();
    let mut cols: Vec<Vec<f64>> = vec![];
    for c in conditions {
        let mut bx = vec![0.0; nt];
        for e in events.iter().filter(|e| e.trial_type == *c) {
            for (i, b) in bx.iter_mut().enumerate() {
                if t(i) >= e.onset && t(i) < e.onset + e.duration {
                    *b = 1.0;
                }
            }
        }
        let conv = |k: usize| {
            (0..hrf.len().min(k + 1))
                .map(|j| bx[k - j] * hrf[j])
                .sum::<f64>()
        };
        cols.push(sample[drop..].iter().map(|&k| conv(k)).collect());
    }
    cols.push(vec![1.0; n]);
    let k = (2.0 * n as f64 * tr / 128.0) as usize;
    for j in 1..=k {
        cols.push(
            (0..n)
                .map(|i| (std::f64::consts::PI * (i as f64 + 0.5) * j as f64 / n as f64).cos())
                .collect(),
        );
    }
    for m in MOTION {
        let col = conf
            .iter()
            .find(|(k, _)| k == m)
            .ok_or(format!("confounds lack {m}"))?;
        if col.1.len() != nvol {
            return Err(format!(
                "confounds have {} rows; the BOLD has {nvol} volumes",
                col.1.len()
            ));
        }
        cols.push(col.1[drop..].to_vec());
    }
    let p = cols.len();
    let mut v = vec![0.0; n * p];
    for (c, col) in cols.iter().enumerate() {
        for (r, x) in col.iter().enumerate() {
            v[r * p + c] = *x;
        }
    }
    Ok((Mat { n, p, v }, drop))
}

/// Least squares via Householder QR: `pinv` (p x n) maps a time series to its betas.
struct Fit {
    d: Mat,
    pinv: Vec<f64>,
    /// c' (D'D)^-1 c per contrast
    cc: Vec<f64>,
    contrasts: Vec<Vec<f64>>,
}

impl Fit {
    fn new(d: Mat, contrasts: &[Vec<f64>]) -> Result<Fit, String> {
        let (n, p) = (d.n, d.p);
        if n <= p {
            return Err(format!(
                "{n} volumes for {p} regressors leaves no degrees of freedom"
            ));
        }
        // column-major working copy; Householder vectors overwrite it below the diagonal
        let mut a: Vec<f64> = (0..p)
            .flat_map(|c| (0..n).map(move |r| (r, c)))
            .map(|(r, c)| d.at(r, c))
            .collect();
        let mut beta = vec![0.0; p];
        let mut rdiag = vec![0.0; p];
        for k in 0..p {
            let col = &mut a[k * n..(k + 1) * n];
            let norm = col[k..].iter().map(|x| x * x).sum::<f64>().sqrt();
            let alpha = if col[k] > 0.0 { -norm } else { norm };
            rdiag[k] = alpha;
            col[k] -= alpha;
            let vnorm2: f64 = col[k..].iter().map(|x| x * x).sum();
            beta[k] = if vnorm2 > 0.0 { 2.0 / vnorm2 } else { 0.0 };
            let vk: Vec<f64> = col[k..].to_vec();
            for c in k + 1..p {
                let cc = &mut a[c * n..(c + 1) * n];
                let s = beta[k] * vk.iter().zip(&cc[k..]).map(|(x, y)| x * y).sum::<f64>();
                for (y, x) in cc[k..].iter_mut().zip(&vk) {
                    *y -= s * x;
                }
            }
        }
        let rmax = rdiag.iter().fold(0.0f64, |m, r| m.max(r.abs()));
        if rdiag.iter().any(|r| r.abs() <= 1e-10 * rmax) {
            return Err("design matrix is rank deficient (collinear regressors)".into());
        }
        let r = |i: usize, j: usize| if i == j { rdiag[i] } else { a[j * n + i] };
        // pinv = R^-1 Q1': apply the reflections to each unit vector e_t, keep the first p rows, back-substitute
        let mut pinv = vec![0.0; p * n];
        let mut y = vec![0.0; n];
        for t in 0..n {
            y.iter_mut().for_each(|x| *x = 0.0);
            y[t] = 1.0;
            for k in 0..p {
                let vk = &a[k * n + k..(k + 1) * n];
                let s = beta[k] * vk.iter().zip(&y[k..]).map(|(x, y)| x * y).sum::<f64>();
                for (yy, x) in y[k..].iter_mut().zip(vk) {
                    *yy -= s * x;
                }
            }
            for i in (0..p).rev() {
                let s: f64 = (i + 1..p).map(|j| r(i, j) * pinv[j * n + t]).sum();
                pinv[i * n + t] = (y[i] - s) / r(i, i);
            }
        }
        let contrasts: Vec<Vec<f64>> = contrasts
            .iter()
            .map(|c| (0..p).map(|i| *c.get(i).unwrap_or(&0.0)).collect())
            .collect();
        let cc = contrasts
            .iter()
            .map(|c| {
                (0..n)
                    .map(|t| (0..p).map(|i| c[i] * pinv[i * n + t]).sum::<f64>().powi(2))
                    .sum()
            })
            .collect();
        Ok(Fit {
            d,
            pinv,
            cc,
            contrasts,
        })
    }

    /// t per contrast, and the lag-1 autocorrelation of the residuals.
    fn t(&self, y: &[f64], ts: &mut [f64]) -> f64 {
        let (n, p) = (self.d.n, self.d.p);
        let beta: Vec<f64> = (0..p)
            .map(|i| {
                self.pinv[i * n..(i + 1) * n]
                    .iter()
                    .zip(y)
                    .map(|(a, b)| a * b)
                    .sum()
            })
            .collect();
        let res: Vec<f64> = (0..n)
            .map(|r| y[r] - (0..p).map(|c| self.d.at(r, c) * beta[c]).sum::<f64>())
            .collect();
        let ss: f64 = res.iter().map(|x| x * x).sum();
        let s2 = ss / (n - p) as f64;
        for ((t, c), cc) in ts.iter_mut().zip(&self.contrasts).zip(&self.cc) {
            let num: f64 = c.iter().zip(&beta).map(|(a, b)| a * b).sum();
            // ponytail: zero residual variance (constant series) gives t 0, not NumPy's inf/nan
            *t = if s2 > 0.0 {
                num / (s2 * cc).sqrt()
            } else {
                0.0
            };
        }
        res.windows(2).map(|w| w[0] * w[1]).sum::<f64>() / ss
    }
}

/// scipy.ndimage 'reflect' boundary: (d c b a | a b c d | d c b a).
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    let m = i.rem_euclid(2 * n);
    (if m < n { m } else { 2 * n - 1 - m }) as usize
}

/// scipy.ndimage.gaussian_filter on a float32 volume (truncate 4, reflect): each axis pass is computed in f64
/// and stored as float32, as scipy does for float32 input.
pub fn gaussian_filter(vol: &mut [f32], dims: [usize; 3], sigma: [f64; 3]) {
    let stride = [1, dims[0], dims[0] * dims[1]];
    let mut line = vec![];
    for axis in 0..3 {
        let sd = sigma[axis];
        if sd <= 1e-15 {
            continue;
        }
        let radius = (4.0 * sd + 0.5) as isize;
        let mut w: Vec<f64> = (-radius..=radius)
            .map(|x| (-0.5 / (sd * sd) * (x * x) as f64).exp())
            .collect();
        let sum: f64 = w.iter().sum();
        w.iter_mut().for_each(|x| *x /= sum);
        let len = dims[axis];
        let others: Vec<usize> = (0..vol.len())
            .filter(|i| (i / stride[axis]) % len == 0)
            .collect();
        for base in others {
            line.clear();
            line.extend((0..len).map(|k| vol[base + k * stride[axis]] as f64));
            for k in 0..len {
                let s: f64 = w
                    .iter()
                    .enumerate()
                    .map(|(j, wj)| wj * line[reflect(k as isize + j as isize - radius, len)])
                    .sum();
                vol[base + k * stride[axis]] = s as f32;
            }
        }
    }
}

/// Sigma in voxels of a FWHM in mm.
pub fn sigma(fwhm: f64, zooms: [f64; 3]) -> [f64; 3] {
    zooms.map(|z| fwhm / (8.0 * 2f64.ln()).sqrt() / z)
}

/// glm.py brain mask: temporal mean > 0.2 x its 98th percentile (NumPy linear interpolation).
pub fn mask(data: &[f32], nvox: usize, nvol: usize) -> Vec<bool> {
    let mean: Vec<f32> = (0..nvox)
        .map(|i| ((0..nvol).map(|t| data[t * nvox + i] as f64).sum::<f64>() / nvol as f64) as f32)
        .collect();
    let mut sorted = mean.clone();
    sorted.sort_by(f32::total_cmp);
    let pos = 0.98 * (nvox - 1) as f64;
    let (lo, frac) = (pos.floor() as usize, pos - pos.floor());
    let hi = (lo + 1).min(nvox - 1);
    let p98 = sorted[lo] as f64 + frac * (sorted[hi] as f64 - sorted[lo] as f64);
    mean.iter().map(|&m| m as f64 > 0.2 * p98).collect()
}

/// NumPy `np.round(x, 2)` on float32.
fn round2_f32(x: f32) -> f32 {
    (x * 100.0f32).round_ties_even() / 100.0f32
}

/// t maps (one per contrast, over the whole grid) of `data` (4D, all volumes) within `mask`, and the smoothed
/// lag-1 autocorrelation map. AR(1): rho smoothed within the mask (normalised convolution), quantised to 0.01
/// (as nilearn) and capped at 0.9; each group refit after Prais-Winsten whitening.
#[allow(clippy::too_many_arguments)] // mirrors glm.py tstat()
pub fn tstat(
    data: &[f32],
    dims: [usize; 3],
    mask: &[bool],
    d: &Mat,
    drop: usize,
    zooms: [f64; 3],
    ar1: bool,
    rho_fwhm: f64,
    contrasts: &[Vec<f64>],
) -> Result<(Vec<Vec<f32>>, Vec<f32>), String> {
    let nvox = dims.iter().product::<usize>();
    let vox: Vec<usize> = (0..nvox).filter(|&i| mask[i]).collect();
    if vox.is_empty() {
        return Err("empty brain mask".into());
    }
    let n = d.n;
    let series =
        |i: usize| -> Vec<f64> { (0..n).map(|t| data[(t + drop) * nvox + i] as f64).collect() };
    let fit = Fit::new(d.clone(), contrasts)?;
    let nc = contrasts.len();
    let mut tv = vec![0.0; vox.len() * nc];
    let mut rho = vec![0f32; nvox];
    for (k, &i) in vox.iter().enumerate() {
        let r1 = fit.t(&series(i), &mut tv[k * nc..(k + 1) * nc]);
        if ar1 {
            rho[i] = r1 as f32;
        }
    }
    if ar1 {
        let sig = sigma(rho_fwhm, zooms);
        gaussian_filter(&mut rho, dims, sig);
        let mut m: Vec<f32> = mask.iter().map(|&b| b as u8 as f32).collect();
        gaussian_filter(&mut m, dims, sig);
        for (r, mm) in rho.iter_mut().zip(&m) {
            *r /= mm.max(1e-6f32);
        }
        let q: Vec<f32> = vox
            .iter()
            .map(|&i| round2_f32(rho[i]).clamp(0.0, 0.9f32))
            .collect();
        let mut levels = q.clone();
        levels.sort_by(f32::total_cmp);
        levels.dedup();
        let mut ts = vec![0.0; nc];
        for a in levels {
            let w0 = (1.0f32 - a * a).sqrt() as f64; // Prais-Winsten keeps the first volume (float32, as NumPy)
            let a = a as f64;
            let whiten = |x: &mut [f64], stride: usize| {
                for r in (1..n).rev() {
                    for c in 0..stride {
                        x[r * stride + c] -= a * x[(r - 1) * stride + c];
                    }
                }
                x[..stride].iter_mut().for_each(|v| *v *= w0);
            };
            let mut dw = d.clone();
            whiten(&mut dw.v, d.p);
            let fw = Fit::new(dw, contrasts)?;
            for (k, &i) in vox.iter().enumerate().filter(|(k, _)| q[*k] == a as f32) {
                let mut y = series(i);
                whiten(&mut y, 1);
                fw.t(&y, &mut ts);
                tv[k * nc..(k + 1) * nc].copy_from_slice(&ts);
            }
        }
        for (i, r) in rho.iter_mut().enumerate() {
            if !mask[i] {
                *r = 0.0;
            }
        }
    }
    let maps = (0..nc)
        .map(|c| {
            let mut t = vec![0f32; nvox];
            for (k, &i) in vox.iter().enumerate() {
                t[i] = tv[k * nc + c] as f32;
            }
            t
        })
        .collect();
    Ok((maps, rho))
}

/// ln Gamma(x), Lanczos (g 7, 9 terms), x > 0.
fn ln_gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        return (std::f64::consts::PI / (std::f64::consts::PI * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let t = x + 7.5;
    let s = G[0] + (1..9).map(|i| G[i] / (x + i as f64)).sum::<f64>();
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + s.ln()
}

/// Regularised incomplete beta I_x(a, b) (continued fraction, modified Lentz).
fn beta_inc(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    if x > (a + 1.0) / (a + b + 2.0) {
        return 1.0 - beta_inc(b, a, 1.0 - x);
    }
    let front =
        (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp() / a;
    let tiny = 1e-300;
    let (mut f, mut c, mut d) = (1.0, 1.0, 0.0);
    for i in 0..400 {
        let m = (i / 2) as f64;
        let num = if i == 0 {
            1.0
        } else if i % 2 == 0 {
            m * (b - m) * x / ((a + 2.0 * m - 1.0) * (a + 2.0 * m))
        } else {
            -(a + m) * (a + b + m) * x / ((a + 2.0 * m) * (a + 2.0 * m + 1.0))
        };
        d = 1.0 + num * d;
        d = if d.abs() < tiny { tiny } else { d };
        d = 1.0 / d;
        c = 1.0 + num / c;
        c = if c.abs() < tiny { tiny } else { c };
        f *= c * d;
        if (1.0 - c * d).abs() < 1e-16 {
            break;
        }
    }
    front * (f - 1.0)
}

/// Student t survival function P(T > t), t >= 0.
pub fn t_sf(t: f64, df: f64) -> f64 {
    0.5 * beta_inc(df / 2.0, 0.5, df / (df + t * t))
}

/// Student t inverse survival function for p in (0, 0.5]: bisection to the last bit.
pub fn t_isf(p: f64, df: f64) -> f64 {
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    while t_sf(hi, df) > p {
        hi *= 2.0;
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if mid <= lo || mid >= hi {
            break;
        }
        if t_sf(mid, df) > p {
            lo = mid
        } else {
            hi = mid
        }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn student_t_matches_scipy() {
        // scipy.stats.t.isf(0.001, df), recorded by fastprep.py runs
        assert!((t_isf(0.001, 136.0) - 3.1512389323787033).abs() < 1e-10);
        assert!((t_isf(0.025, 10.0) - 2.228138851986275).abs() < 1e-10);
        assert!((t_sf(3.0, 136.0) - 0.0016060339022432363).abs() < 1e-15);
    }

    #[test]
    fn gaussian_filter_matches_scipy_reflect() {
        // scipy.ndimage.gaussian_filter1d([0, 0, 1, 0, 0], 1) along x: weights of radius 4, reflected edges
        let mut v = vec![0f32, 0.0, 1.0, 0.0, 0.0];
        gaussian_filter(&mut v, [5, 1, 1], [1.0, 0.0, 0.0]);
        let want = [
            0.0584229901432991,
            0.24210527539253235,
            0.3989434838294983,
            0.24210527539253235,
            0.0584229901432991,
        ];
        assert!(
            v.iter()
                .zip(want)
                .all(|(a, b)| (*a as f64 - b).abs() < 1e-7),
            "{v:?}"
        );
        assert!((v.iter().sum::<f32>() - 1.0).abs() < 1e-6); // reflect conserves mass
    }

    #[test]
    fn ar1_null_keeps_nominal_false_positive_rate() {
        // pure AR(1) noise (rho 0.4), no signal: prewhitened t must hold the nominal 5% false-positive rate
        let (n, dims) = (200usize, [20usize, 20, 10]);
        let nvox = dims.iter().product::<usize>();
        let mut seed = 1u64;
        let mut normal = || {
            let mut u = || {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((seed >> 11) as f64 + 0.5) / (1u64 << 53) as f64
            };
            (-2.0 * u().ln()).sqrt() * (2.0 * std::f64::consts::PI * u()).cos()
        };
        let mut data = vec![0f32; n * nvox];
        for i in 0..nvox {
            let mut e = 0.0;
            for t in 0..n {
                e = 0.4 * e + normal();
                data[t * nvox + i] = e as f32;
            }
        }
        let mut v = vec![0.0; n * 2];
        for t in 0..n {
            v[t * 2] = ((t / 20) % 2) as f64; // 20-volume blocks
            v[t * 2 + 1] = 1.0;
        }
        let d = Mat { n, p: 2, v };
        let mask = vec![true; nvox];
        let fp = |ar1| {
            let (t, _) =
                tstat(&data, dims, &mask, &d, 0, [1.0; 3], ar1, 50.0, &[vec![1.0]]).unwrap();
            t[0].iter().filter(|x| x.abs() > 1.97).count() as f64 / nvox as f64
        };
        let (ols, ar) = (fp(false), fp(true));
        assert!(ols > 0.09 && 0.03 < ar && ar < 0.07, "{ols} {ar}");
    }
}
