//! NODDI by AMICO (Daducci et al. 2015): a port of AMICO 1.5.4 (dmri-amico, BSD-3-Clause), the
//! last release under that licence. Each function names the AMICO function it ports.
//!
//! AMICO rotates each atom to the voxel's fibre direction with a 32761-direction lookup table of
//! spherical-harmonic coefficients. It keeps only the m = 0 (zonal) coefficient of each order,
//! so by the SH addition theorem the rotated atom at gradient g is
//! Σ_l c_l √((2l+1)/4π) P_l(g·n). This crate evaluates that sum for the exact direction n
//! instead of the nearest table direction; the atoms agree with AMICO's table to 4e-7 at the
//! table's directions.

pub mod lasso;
pub mod nnls;
pub mod special;
#[rustfmt::skip]
pub mod tables;

use dwi_tensor::Design;
use special::{erf, erfi, legendre};
use tables::{FIT_M0, GRAD_Z, N_HR, N_L};

/// The shared strict b0 threshold, in s/mm².
pub use dwi_gradients::B0_THRESHOLD;

/// models.NODDI defaults: parallel and isotropic diffusivity (mm²/s), and the atom grids.
pub const D_PAR: f64 = 1.7e-3;
pub const D_ISO: f64 = 3.0e-3;
pub const N_VF: usize = 12;
pub const N_OD: usize = 12;
pub const N_WM: usize = N_VF * N_OD;
/// models.NODDI.set_solver defaults (SPAMS lasso mode 2).
pub const LAMBDA1: f64 = 5e-1;
pub const LAMBDA2: f64 = 1e-3;

const GAMMA: f64 = 2.675987e8;

/// np.linspace(0.1, 0.99, 12).
pub fn ic_vfs() -> [f64; N_VF] {
    linspace(0.1, 0.99)
}

/// np.hstack(([0.03, 0.06], np.linspace(0.09, 0.99, 10))).
pub fn ic_ods() -> [f64; N_OD] {
    let tail: [f64; 10] = linspace(0.09, 0.99);
    let mut out = [0.0; N_OD];
    out[0] = 0.03;
    out[1] = 0.06;
    out[2..].copy_from_slice(&tail);
    out
}

/// numpy.linspace with endpoint: start + i·step, and the last value exactly `stop`.
fn linspace<const N: usize>(start: f64, stop: f64) -> [f64; N] {
    let step = (stop - start) / (N - 1) as f64;
    let mut out = [0.0; N];
    for (i, v) in out.iter_mut().enumerate() {
        *v = start + i as f64 * step;
    }
    out[N - 1] = stop;
    out
}

/// amico.util.fsl2scheme writes the table with "%.06f".
fn six_decimals(v: f64) -> f64 {
    format!("{v:.6}").parse().unwrap()
}

/// One shell of the acquisition (amico.scheme.Scheme.shells): its b-value and volume indices.
struct Shell {
    b: f64,
    volumes: Vec<usize>,
}

/// The atoms for one acquisition: zonal coefficients per shell, the normalisation and the
/// isotropic atom. models.NODDI.generate and resample.
pub struct Dictionary {
    bvals: Vec<f64>,
    /// Unit gradient directions; b0 volumes have the zero vector.
    dirs: Vec<[f64; 3]>,
    b0: Vec<usize>,
    dwi: Vec<usize>,
    shells: Vec<Shell>,
    /// Zonal coefficients c_l per atom and shell: zonal[atom][shell][l].
    zonal: Vec<Vec<[f64; N_L]>>,
    /// Isotropic atom per volume (1 at b0 volumes).
    iso: Vec<f64>,
    /// KERNELS['norms']: 1 / ‖atom at LUT direction 0 over the diffusion-weighted rows‖.
    norms: Vec<f64>,
    /// KERNELS['kappa'] and ['icvf'], kept as float32 values as AMICO stores them.
    kappa: Vec<f64>,
    icvf: Vec<f64>,
    design: Design,
}

/// The maps of one voxel.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NoddiFit {
    pub icvf: f64,
    pub od: f64,
    pub isovf: f64,
}

impl Dictionary {
    /// `bvals` in s/mm², `bvecs` one direction per volume. Shells are the distinct b-values
    /// at or above `B0_THRESHOLD`, without shell rounding.
    pub fn new(bvals: &[f64], bvecs: &[[f64; 3]]) -> Result<Self, String> {
        if bvals.len() != bvecs.len() {
            return Err("The bval and bvec files list different numbers of volumes.".into());
        }
        let bvals: Vec<f64> = bvals.iter().map(|&b| six_decimals(b)).collect();
        let raw: Vec<[f64; 3]> = bvecs.iter().map(|g| g.map(six_decimals)).collect();
        let b0: Vec<usize> = (0..bvals.len())
            .filter(|&i| bvals[i] < B0_THRESHOLD)
            .collect();
        let dwi: Vec<usize> = (0..bvals.len())
            .filter(|&i| bvals[i] >= B0_THRESHOLD)
            .collect();
        if b0.is_empty() {
            return Err("AMICO needs a b0 volume to normalise the signal.".into());
        }
        let mut dirs = vec![[0.0; 3]; bvals.len()];
        for &i in &dwi {
            let g = raw[i];
            let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            if norm < 0.5 {
                return Err(format!(
                    "Volume {i} has b = {} but no gradient direction.",
                    bvals[i]
                ));
            }
            dirs[i] = [g[0] / norm, g[1] / norm, g[2] / norm];
        }
        let mut shells: Vec<Shell> = Vec::new();
        for &i in &dwi {
            match shells.iter_mut().find(|s| s.b == bvals[i]) {
                Some(s) => s.volumes.push(i),
                None => shells.push(Shell {
                    b: bvals[i],
                    volumes: vec![i],
                }),
            }
        }
        let protocol = Protocol::new(&shells);
        let kappas = ic_ods().map(|od| 1.0 / (od * std::f64::consts::PI / 2.0).tan());
        let vfs = ic_vfs();
        let intra: Vec<Vec<f64>> = kappas.iter().map(|&k| protocol.intra(k)).collect();
        let mut zonal = Vec::with_capacity(N_WM);
        let mut kappa = Vec::with_capacity(N_WM);
        let mut icvf = Vec::with_capacity(N_WM);
        for (ki, &k) in kappas.iter().enumerate() {
            for &v in &vfs {
                let extra = protocol.extra(k, v);
                let signal: Vec<f64> = intra[ki]
                    .iter()
                    .zip(&extra)
                    .map(|(ic, ec)| v * ic + (1.0 - v) * ec)
                    .collect();
                zonal.push(
                    (0..shells.len())
                        .map(|s| zonal_coefficients(&signal[N_HR * s..N_HR * (s + 1)]))
                        .collect(),
                );
                kappa.push(k as f32 as f64);
                icvf.push(v as f32 as f64);
            }
        }
        let mut iso = vec![1.0; bvals.len()];
        for (s, shell) in shells.iter().enumerate() {
            let value = protocol.iso(s) as f32 as f64;
            for &i in &shell.volumes {
                iso[i] = value;
            }
        }
        let gradients = dwi_gradients::Gradients::new(bvals.clone(), raw.clone())?;
        let mut dict = Self {
            bvals,
            dirs,
            b0,
            dwi,
            shells,
            zonal,
            iso,
            norms: Vec::new(),
            kappa,
            icvf,
            design: Design::new(&gradients),
        };
        let at_dir0 = dict.atoms(tables::LUT_DIR0);
        dict.norms = (0..N_WM)
            .map(|a| {
                let sq: f64 = dict
                    .dwi
                    .iter()
                    .map(|&i| at_dir0[i * N_WM + a].powi(2))
                    .sum();
                1.0 / sq.sqrt()
            })
            .collect();
        Ok(dict)
    }

    pub fn volumes(&self) -> usize {
        self.bvals.len()
    }

    /// The LASSO normalisation of tissue atom `atom` (KERNELS['norms']).
    pub fn norm(&self, atom: usize) -> f64 {
        self.norms[atom]
    }

    /// The isotropic atom at volume `volume` (KERNELS['iso']).
    pub fn iso(&self, volume: usize) -> f64 {
        self.iso[volume]
    }

    /// The tissue atoms rotated to direction `n`, row-major (volume × atom), float32-rounded as
    /// AMICO's KERNELS['wm']. b0 rows are 1.
    pub fn atoms(&self, n: [f64; 3]) -> Vec<f64> {
        let mut out = vec![1.0; self.bvals.len() * N_WM];
        let mut p = [0.0f64; N_L];
        for (s, shell) in self.shells.iter().enumerate() {
            for &i in &shell.volumes {
                let g = self.dirs[i];
                let c = (g[0] * n[0] + g[1] * n[1] + g[2] * n[2]).clamp(-1.0, 1.0);
                for (li, value) in p.iter_mut().enumerate() {
                    let l = 2 * li;
                    *value =
                        legendre(l, c) * ((2 * l + 1) as f64 / (4.0 * std::f64::consts::PI)).sqrt();
                }
                for a in 0..N_WM {
                    let z = &self.zonal[a][s];
                    let v: f64 = z.iter().zip(&p).map(|(c, p)| c * p).sum();
                    out[i * N_WM + a] = v as f32 as f64;
                }
            }
        }
        out
    }

    /// The fibre direction AMICO uses: the principal eigenvector of dipy's WLS tensor fit of
    /// all volumes of the normalised signal.
    pub fn direction(&self, y: &[f64]) -> Option<[f64; 3]> {
        self.design.fit_dipy_wls(y).map(|t| t.evecs[0])
    }

    /// Normalises one voxel's samples by the mean b0 (Evaluation.load_data with
    /// doNormalizeSignal) and sets negative values to 0 (Evaluation.fit). Returns None when the
    /// mean b0 is not positive; AMICO then fits a zero signal.
    pub fn normalise(&self, signal: &[f64]) -> Option<Vec<f64>> {
        let mean_b0 = self.b0.iter().map(|&i| signal[i]).sum::<f64>() / self.b0.len() as f64;
        if mean_b0 <= 0.0 || !mean_b0.is_finite() {
            return None;
        }
        Some(signal.iter().map(|&s| (s / mean_b0).max(0.0)).collect())
    }

    /// models.NODDI.fit for one voxel: normalised signal `y` and fibre direction `n`.
    pub fn fit(&self, y: &[f64], n: [f64; 3]) -> NoddiFit {
        let rows = self.bvals.len();
        let cols = N_WM + 1;
        let wm = self.atoms(n);
        // Column-major A: tissue atoms, then the isotropic atom.
        let mut a = vec![0.0f64; rows * cols];
        for r in 0..rows {
            for c in 0..N_WM {
                a[c * rows + r] = wm[r * N_WM + c];
            }
            a[N_WM * rows + r] = self.iso[r];
        }
        // CSF partial volume from an NNLS fit on every atom.
        let x = nnls::nnls(&mut a.clone(), rows, cols, &mut y.to_vec());
        let x_iso = x[N_WM];
        let yy: Vec<f64> = (0..rows)
            .map(|r| (y[r] - x_iso * self.iso[r]).max(0.0))
            .collect();
        // Sparse tissue fit on the diffusion-weighted rows with normalised atoms.
        let m = self.dwi.len();
        let mut an = vec![0.0f64; m * N_WM];
        for (k, &r) in self.dwi.iter().enumerate() {
            for c in 0..N_WM {
                an[c * m + k] = wm[r * N_WM + c] * self.norms[c];
            }
        }
        let target: Vec<f64> = self.dwi.iter().map(|&r| yy[r]).collect();
        let sparse = lasso::lasso_nonneg(&an, m, N_WM, &target, LAMBDA1, LAMBDA2);
        // Debias: NNLS on the selected atoms and the isotropic atom.
        let selected: Vec<usize> = (0..N_WM)
            .filter(|&c| sparse[c] > 0.0)
            .chain([N_WM])
            .collect();
        let mut sub = Vec::with_capacity(rows * selected.len());
        for &c in &selected {
            sub.extend_from_slice(&a[c * rows..(c + 1) * rows]);
        }
        let xs = nnls::nnls(&mut sub, rows, selected.len(), &mut y.to_vec());
        let mut x = vec![0.0f64; cols];
        for (k, &c) in selected.iter().enumerate() {
            x[c] = xs[k];
        }
        let total: f64 = x.iter().sum();
        let xx: Vec<f64> = x.iter().map(|v| v / (total + 1e-16)).collect();
        let f_iso = xx[N_WM];
        let wm_total: f64 = xx[..N_WM].iter().sum();
        let xwm: Vec<f64> = xx[..N_WM].iter().map(|v| v / (wm_total + 1e-16)).collect();
        let f1: f64 = self.icvf.iter().zip(&xwm).map(|(a, b)| a * b).sum();
        let f2: f64 = self.icvf.iter().zip(&xwm).map(|(a, b)| (1.0 - a) * b).sum();
        let v = f1 / (f1 + f2 + 1e-16);
        let k: f64 = self.kappa.iter().zip(&xwm).map(|(a, b)| a * b).sum();
        let od = 2.0 / std::f64::consts::PI * 1.0f64.atan2(k);
        NoddiFit {
            icvf: v,
            od,
            isovf: f_iso,
        }
    }

    /// Normalises, finds the direction and fits one voxel. Voxels AMICO would see as a zero
    /// signal return zeros and no direction.
    pub fn fit_voxel(&self, signal: &[f64]) -> (NoddiFit, [f64; 3]) {
        let y = match self.normalise(signal) {
            Some(y) => y,
            None => vec![0.0; signal.len()],
        };
        let Some(n) = self.direction(&y) else {
            return (NoddiFit::default(), [0.0; 3]);
        };
        (self.fit(&y, n), n)
    }
}

/// The least-squares SH fit of one shell's 500 high-resolution samples, m = 0 terms only
/// (amico.lut.rotate_kernel: np.dot(AUX['fit'], K) then [idx_m0]).
fn zonal_coefficients(samples: &[f64]) -> [f64; N_L] {
    let mut out = [0.0; N_L];
    for (l, row) in FIT_M0.iter().enumerate() {
        out[l] = row.iter().zip(samples).map(|(a, b)| a * b).sum();
    }
    out
}

/// The PGSE timing AMICO assigns to each high-resolution shell (synthesis._scheme2noddi):
/// δ = Δ from the largest b at 40 mT/m, G scaled per shell.
struct Protocol {
    /// Per shell: (G, delta, smalldel).
    shells: Vec<(f64, f64, f64)>,
}

impl Protocol {
    fn new(shells: &[Shell]) -> Self {
        let max_b = shells.iter().map(|s| s.b).fold(f64::MIN, f64::max);
        let g_max = 0.04;
        let tmp = (3.0 * max_b * 1e6 / (2.0 * GAMMA * GAMMA * g_max * g_max)).powf(1.0 / 3.0);
        Self {
            shells: shells
                .iter()
                .map(|s| ((s.b / max_b).sqrt() * g_max, tmp, tmp))
                .collect(),
        }
    }

    /// (|q|², diffusion time) of a shell.
    fn q(&self, s: usize) -> (f64, f64) {
        let (g, delta, smalldel) = self.shells[s];
        let mod_q = GAMMA * smalldel * g;
        (mod_q * mod_q, delta - smalldel / 3.0)
    }

    /// NODDIIntraCellular.get_signal(dPar, kappa) on every high-resolution sample.
    fn intra(&self, kappa: f64) -> Vec<f64> {
        let d = D_PAR * 1e-6;
        let coeff = watson_sh_coeff(kappa);
        let mut e = Vec::with_capacity(N_HR * self.shells.len());
        for s in 0..self.shells.len() {
            let (q2, t) = self.q(s);
            let le_par = -q2 * t * d;
            let lpmp = 0.0 - le_par;
            let lgi = legendre_gaussian_integral(lpmp);
            for &z in GRAD_Z.iter() {
                let c = if z.abs() > 1.0 { z / z.abs() } else { z };
                let mut sum = 0.0;
                for i in 0..7 {
                    let sh = ((i + 1) as f64 - 0.75) / std::f64::consts::PI;
                    sum += lgi[i] * coeff[i] * (sh.sqrt() * legendre(2 * i, c));
                }
                e.push(sum);
            }
        }
        let floor = e
            .iter()
            .copied()
            .filter(|&v| v > 0.0)
            .fold(f64::INFINITY, f64::min);
        for v in e.iter_mut() {
            if *v <= 0.0 {
                *v = floor * 0.1;
            }
            *v *= 0.5;
        }
        e
    }

    /// NODDIExtraCellular.get_signal(dPar, kappa, v_ic): hindered diffusion with tortuosity.
    fn extra(&self, kappa: f64, v_ic: f64) -> Vec<f64> {
        let d_par = D_PAR * 1e-6;
        let d_perp = d_par * (1.0 - v_ic);
        let dw = watson_hindered_diffusion_coeff(d_par, d_perp, kappa);
        let mut e = Vec::with_capacity(N_HR * self.shells.len());
        for s in 0..self.shells.len() {
            let (q2, t) = self.q(s);
            let bval = t * q2;
            for &z in GRAD_Z.iter() {
                let c2 = z * z;
                e.push((-bval * ((dw[0] - dw[1]) * c2 + dw[1])).exp());
            }
        }
        e
    }

    /// NODDIIsotropic.get_signal(dIso) of one shell.
    fn iso(&self, s: usize) -> f64 {
        let (q2, t) = self.q(s);
        (-t * q2 * (D_ISO * 1e-6)).exp()
    }
}

/// NODDIIntraCellular._legendre_gaussian_integral(Lpmp, 6).
fn legendre_gaussian_integral(x: f64) -> [f64; 7] {
    let mut l = [0.0; 7];
    if x > 0.05 {
        let mut i = [0.0; 7];
        let sqrtx = x.sqrt();
        i[0] = std::f64::consts::PI.sqrt() * erf(sqrtx) / sqrtx;
        let dx = 1.0 / x;
        let emx = -(-x).exp();
        for k in 1..7 {
            i[k] = emx + (k as f64 - 0.5) * i[k - 1];
            i[k] *= dx;
        }
        l[0] = i[0];
        l[1] = -0.5 * i[0] + 1.5 * i[1];
        l[2] = 0.375 * i[0] - 3.75 * i[1] + 4.375 * i[2];
        l[3] = -0.3125 * i[0] + 6.5625 * i[1] - 19.6875 * i[2] + 14.4375 * i[3];
        l[4] = 0.2734375 * i[0] - 9.84375 * i[1] + 54.140625 * i[2] - 93.84375 * i[3]
            + 50.2734375 * i[4];
        l[5] = -(63. / 256.) * i[0] + (3465. / 256.) * i[1] - (30030. / 256.) * i[2]
            + (90090. / 256.) * i[3]
            - (109395. / 256.) * i[4]
            + (46189. / 256.) * i[5];
        l[6] = (231. / 1024.) * i[0] - (18018. / 1024.) * i[1] + (225225. / 1024.) * i[2]
            - (1021020. / 1024.) * i[3]
            + (2078505. / 1024.) * i[4]
            - (1939938. / 1024.) * i[5]
            + (676039. / 1024.) * i[6];
    } else {
        let x2 = x * x;
        let x3 = x2 * x;
        let x4 = x3 * x;
        let x5 = x4 * x;
        let x6 = x5 * x;
        l[0] = 2.0 - 2.0 * x / 3.0 + x2 / 5.0 - x3 / 21.0 + x4 / 108.0;
        l[1] = -4.0 * x / 15.0 + 4.0 * x2 / 35.0 - 2.0 * x3 / 63.0 + 2.0 * x4 / 297.0;
        l[2] = 8.0 * x2 / 315.0 - 8.0 * x3 / 693.0 + 4.0 * x4 / 1287.0;
        l[3] = -16.0 * x3 / 9009.0 + 16.0 * x4 / 19305.0;
        l[4] = 32.0 * x4 / 328185.0;
        l[5] = -64.0 * x5 / 14549535.0;
        l[6] = 128.0 * x6 / 760543875.0;
    }
    l
}

/// NODDIIntraCellular._watson_SH_coeff(kappa), including its large- and small-kappa branches.
fn watson_sh_coeff(kappa: f64) -> [f64; 7] {
    let pi = std::f64::consts::PI;
    let mut c = [0.0; 7];
    c[0] = 2.0 * pi.sqrt();
    let sk = kappa.sqrt();
    let sk2 = sk * kappa;
    let sk3 = sk2 * kappa;
    let sk4 = sk3 * kappa;
    let sk5 = sk4 * kappa;
    let sk6 = sk5 * kappa;
    let k2 = kappa.powi(2);
    let k3 = k2 * kappa;
    let k4 = k3 * kappa;
    let k5 = k4 * kappa;
    let k6 = k5 * kappa;
    let erfik = erfi(sk);
    let ierfik = 1.0 / erfik;
    let ek = kappa.exp();
    let dawsonk = 0.5 * pi.sqrt() * erfik / ek;
    if kappa > 0.1 {
        c[1] = 3.0 * sk - (3.0 + 2.0 * kappa) * dawsonk;
        c[1] = 5f64.sqrt() * c[1] * ek;
        c[1] = c[1] * ierfik / kappa;
        c[2] = (105.0 + 60.0 * kappa + 12.0 * k2) * dawsonk;
        c[2] = c[2] - 105.0 * sk + 10.0 * sk2;
        c[2] = 0.375 * c[2] * ek / k2;
        c[2] *= ierfik;
        c[3] = -3465.0 - 1890.0 * kappa - 420.0 * k2 - 40.0 * k3;
        c[3] *= dawsonk;
        c[3] = c[3] + 3465.0 * sk - 420.0 * sk2 + 84.0 * sk3;
        c[3] = c[3] * (13.0 * pi).sqrt() / 64.0 / k3;
        c[3] /= dawsonk;
        c[4] = 675675.0 + 360360.0 * kappa + 83160.0 * k2 + 10080.0 * k3 + 560.0 * k4;
        c[4] *= dawsonk;
        c[4] = c[4] - 675675.0 * sk + 90090.0 * sk2 - 23100.0 * sk3 + 744.0 * sk4;
        c[4] = 17f64.sqrt() * c[4] * ek;
        c[4] = c[4] / 512.0 / k4;
        c[4] *= ierfik;
        c[5] = -43648605.0
            - 22972950.0 * kappa
            - 5405400.0 * k2
            - 720720.0 * k3
            - 55440.0 * k4
            - 2016.0 * k5;
        c[5] *= dawsonk;
        c[5] = c[5] + 43648605.0 * sk - 6126120.0 * sk2 + 1729728.0 * sk3 - 82368.0 * sk4
            + 5104.0 * sk5;
        c[5] = (21.0 * pi).sqrt() * c[5] / 4096.0 / k5;
        c[5] /= dawsonk;
        c[6] = 7027425405.0
            + 3666482820.0 * kappa
            + 872972100.0 * k2
            + 122522400.0 * k3
            + 10810800.0 * k4
            + 576576.0 * k5
            + 14784.0 * k6;
        c[6] *= dawsonk;
        c[6] = c[6] - 7027425405.0 * sk + 1018467450.0 * sk2 - 302630328.0 * sk3 + 17153136.0 * sk4
            - 1553552.0 * sk5
            + 25376.0 * sk6;
        c[6] = 5.0 * c[6] * ek;
        c[6] = c[6] / 16384.0 / k6;
        c[6] *= ierfik;
    }
    if kappa > 30.0 {
        let lnkd = kappa.ln() - 30f64.ln();
        let lnkd2 = lnkd * lnkd;
        let lnkd3 = lnkd2 * lnkd;
        let lnkd4 = lnkd3 * lnkd;
        let lnkd5 = lnkd4 * lnkd;
        let lnkd6 = lnkd5 * lnkd;
        c[1] = 7.52308 + 0.411538 * lnkd - 0.214588 * lnkd2 + 0.0784091 * lnkd3 - 0.023981 * lnkd4
            + 0.00731537 * lnkd5
            - 0.0026467 * lnkd6;
        c[2] = 8.93718 + 1.62147 * lnkd - 0.733421 * lnkd2 + 0.191568 * lnkd3
            - 0.0202906 * lnkd4
            - 0.00779095 * lnkd5
            + 0.00574847 * lnkd6;
        c[3] = 8.87905 + 3.35689 * lnkd - 1.15935 * lnkd2 + 0.0673053 * lnkd3 + 0.121857 * lnkd4
            - 0.066642 * lnkd5
            + 0.0180215 * lnkd6;
        c[4] = 7.84352 + 5.03178 * lnkd - 1.0193 * lnkd2 - 0.426362 * lnkd3 + 0.328816 * lnkd4
            - 0.0688176 * lnkd5
            - 0.0229398 * lnkd6;
        c[5] = 6.30113 + 6.09914 * lnkd - 0.16088 * lnkd2 - 1.05578 * lnkd3
            + 0.338069 * lnkd4
            + 0.0937157 * lnkd5
            - 0.106935 * lnkd6;
        c[6] = 4.65678 + 6.30069 * lnkd + 1.13754 * lnkd2 - 1.38393 * lnkd3 - 0.0134758 * lnkd4
            + 0.331686 * lnkd5
            - 0.105954 * lnkd6;
    }
    if kappa <= 0.1 {
        c[1] = 4.0 / 3.0 * kappa + 8.0 / 63.0 * k2;
        c[1] *= (pi / 5.0).sqrt();
        c[2] = 8.0 / 21.0 * k2 + 32.0 / 693.0 * k3;
        c[2] *= pi.sqrt() * 0.2;
        c[3] = 16.0 / 693.0 * k3 + 32.0 / 10395.0 * k4;
        c[3] *= (pi / 13.0).sqrt();
        c[4] = 32.0 / 19305.0 * k4;
        c[4] *= (pi / 17.0).sqrt();
        c[5] = 64.0 * (pi / 21.0).sqrt() * k5 / 692835.0;
        c[6] = 128.0 * pi.sqrt() * k6 / 152108775.0;
    }
    c
}

/// NODDIExtraCellular._watson_hindered_diffusion_coeff.
fn watson_hindered_diffusion_coeff(d_par: f64, d_perp: f64, kappa: f64) -> [f64; 2] {
    let d_par_m_perp = d_par - d_perp;
    if kappa < 1e-5 {
        let d_par_p2_perp = d_par + 2.0 * d_perp;
        let k2 = kappa * kappa;
        [
            d_par_p2_perp / 3.0
                + 4.0 * d_par_m_perp * kappa / 45.0
                + 8.0 * d_par_m_perp * k2 / 945.0,
            d_par_p2_perp / 3.0
                - 2.0 * d_par_m_perp * kappa / 45.0
                - 4.0 * d_par_m_perp * k2 / 945.0,
        ]
    } else {
        let sk = kappa.sqrt();
        let dawsonf = 0.5 * (-kappa).exp() * std::f64::consts::PI.sqrt() * erfi(sk);
        let factor = sk / dawsonf;
        [
            (-d_par_m_perp + 2.0 * d_perp * kappa + d_par_m_perp * factor) / (2.0 * kappa),
            (d_par_m_perp + 2.0 * (d_par + d_perp) * kappa - d_par_m_perp * factor) / (4.0 * kappa),
        ]
    }
}
