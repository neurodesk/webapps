//! The scalar Gibson-Lanni PSF (Gibson and Lanni 1991), by direct numerical integration of
//!
//! ```text
//! I(r, z) = | integral_0^1  J0(k NA r rho) exp(i k OPD(rho, z)) rho d rho |^2
//! ```
//!
//! over the normalised pupil radius `rho` (`NA rho = n sin(theta)` in every layer), with the
//! optical path difference of a point source at depth `zp` below the coverslip, imaged with the
//! nominal focal plane at depth `z`:
//!
//! ```text
//! OPD = zp sqrt(ns^2 - NA^2 rho^2) + ti sqrt(ni^2 - ...) + tg sqrt(ng^2 - ...)
//!       - tg0 sqrt(ng0^2 - ...) - ti0 sqrt(ni0^2 - ...)
//! ti  = zp - z + ni (ti0/ni0 + tg0/ng0 - tg/ng - zp/ns)
//! ```
//!
//! `ti` is the immersion thickness that puts the paraxial focus at `z = zp`, as in Aguet et al.
//! (2009, eq. 5) with the axial coordinate measured from the coverslip, which is psfmodels'
//! convention. Square roots are complex, so light beyond a layer's critical angle is evanescent.
//! The integrand is evaluated with composite 16-point Gauss-Legendre quadrature, split at every
//! critical radius, with enough segments to resolve the phase and Bessel oscillations; each
//! voxel takes the integral at its own radius, with no interpolation. All lengths are in
//! micrometres.

use std::collections::HashMap;
use std::f64::consts::PI;

/// Microscope parameters (micrometres and refractive indices), psfmodels' defaults.
#[derive(Clone, Debug)]
pub struct Microscope {
    /// Numerical aperture.
    pub na: f64,
    /// Coverslip refractive index, design and experimental.
    pub ng0: f64,
    pub ng: f64,
    /// Immersion medium refractive index, design and experimental.
    pub ni0: f64,
    pub ni: f64,
    /// Specimen refractive index.
    pub ns: f64,
    /// Working distance (immersion thickness), design value.
    pub ti0: f64,
    /// Coverslip thickness, experimental and design.
    pub tg: f64,
    pub tg0: f64,
}

impl Default for Microscope {
    fn default() -> Self {
        Microscope { na: 1.4, ng0: 1.515, ng: 1.515, ni0: 1.515, ni: 1.515, ns: 1.47, ti0: 150.0, tg: 170.0, tg0: 170.0 }
    }
}

/// `numpy.linspace(start, stop, num)`.
pub fn linspace(start: f64, stop: f64, num: usize) -> Vec<f64> {
    if num == 1 {
        return vec![start];
    }
    let step = (stop - start) / (num - 1) as f64;
    let mut y: Vec<f64> = (0..num).map(|i| i as f64 * step + start).collect();
    y[num - 1] = stop;
    y
}

/// Nominal focal depths centred on the point source, as psfmodels' `_centered_zv`.
pub fn centered_zv(nz: usize, dz: f64, pz: f64) -> Vec<f64> {
    let lim = (nz as f64 - 1.0) * dz / 2.0;
    linspace(-lim + pz, lim + pz, nz)
}

#[derive(Clone, Copy, Debug, Default)]
struct Complex {
    re: f64,
    im: f64,
}

/// Principal square root of a real number that may be negative.
fn csqrt(value: f64) -> Complex {
    if value >= 0.0 {
        Complex { re: value.sqrt(), im: 0.0 }
    } else {
        Complex { re: 0.0, im: (-value).sqrt() }
    }
}

/// Nodes and weights of n-point Gauss-Legendre quadrature on [-1, 1].
fn gauss_legendre(n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut nodes = vec![0.0; n];
    let mut weights = vec![0.0; n];
    for i in 0..n.div_ceil(2) {
        let mut x = (PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
        let mut derivative = 0.0;
        for _ in 0..100 {
            let (mut p0, mut p1) = (1.0, x);
            for k in 2..=n {
                let p2 = ((2 * k - 1) as f64 * x * p1 - (k - 1) as f64 * p0) / k as f64;
                p0 = p1;
                p1 = p2;
            }
            derivative = n as f64 * (x * p1 - p0) / (x * x - 1.0);
            let step = p1 / derivative;
            x -= step;
            if step.abs() < 1e-16 {
                break;
            }
        }
        nodes[i] = -x;
        nodes[n - 1 - i] = x;
        let w = 2.0 / ((1.0 - x * x) * derivative * derivative);
        weights[i] = w;
        weights[n - 1 - i] = w;
    }
    (nodes, weights)
}

const GL_ORDER: usize = 16;
/// The largest change in the integrand's phase across one quadrature segment (radians).
const SEGMENT_PHASE: f64 = 1.0;

/// The optical path difference at pupil radius `rho` for nominal focal depth `z`.
fn opd(mp: &Microscope, rho: f64, z: f64, zp: f64) -> Complex {
    let nr2 = mp.na * mp.na * rho * rho;
    let ti = zp - z + mp.ni * (mp.ti0 / mp.ni0 + mp.tg0 / mp.ng0 - mp.tg / mp.ng - zp / mp.ns);
    let terms = [(zp, mp.ns), (ti, mp.ni), (mp.tg, mp.ng), (-mp.tg0, mp.ng0), (-mp.ti0, mp.ni0)];
    terms.iter().fold(Complex::default(), |sum, &(thickness, n)| {
        let s = csqrt(n * n - nr2);
        Complex { re: sum.re + thickness * s.re, im: sum.im + thickness * s.im }
    })
}

/// Quadrature nodes and weights on [0, 1], split at every critical radius and fine enough
/// for a phase of `k OPD` over the focal depths `zv` and Bessel arguments up to `k NA r_max`.
fn quadrature(mp: &Microscope, k: f64, zv: &[f64], zp: f64, r_max: f64) -> (Vec<f64>, Vec<f64>) {
    let mut breaks = vec![0.0, 1.0];
    for n in [mp.ns, mp.ni, mp.ng, mp.ng0, mp.ni0] {
        let critical = n / mp.na;
        if critical > 0.0 && critical < 1.0 {
            breaks.push(critical);
        }
    }
    breaks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    breaks.dedup();
    let (unit_nodes, unit_weights) = gauss_legendre(GL_ORDER);
    let (z_low, z_high) = zv.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &z| (a.min(z), b.max(z)));
    let mut nodes = Vec::new();
    let mut weights = Vec::new();
    for pair in breaks.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        // Phase change across the interval at the extreme focal depths, plus the Bessel term.
        let mut swing = k * mp.na * r_max * (b - a);
        for z in [z_low, z_high] {
            let (pa, pb) = (opd(mp, a, z, zp), opd(mp, b, z, zp));
            swing = swing.max(k * mp.na * r_max * (b - a) + k * ((pb.re - pa.re).abs() + (pb.im - pa.im).abs()));
        }
        let segments = ((swing / SEGMENT_PHASE).ceil() as usize).max(4);
        // Halve the segments next to each end four more times: the integrand has a square-root
        // kink at a critical radius.
        let mut edges: Vec<f64> = (0..=segments).map(|i| a + (b - a) * i as f64 / segments as f64).collect();
        let h = (b - a) / segments as f64;
        for level in 1..=4 {
            let step = h / f64::powi(2.0, level);
            edges.push(a + step);
            edges.push(b - step);
        }
        edges.sort_by(|x, y| x.partial_cmp(y).unwrap());
        edges.dedup();
        for edge in edges.windows(2) {
            let (lo, hi) = (edge[0], edge[1]);
            let half = (hi - lo) / 2.0;
            for (x, w) in unit_nodes.iter().zip(&unit_weights) {
                nodes.push(lo + half * (x + 1.0));
                weights.push(half * w);
            }
        }
    }
    (nodes, weights)
}

/// The PSF intensity, unnormalised, at each radius in `radii` (rows) for each focal depth in
/// `zv` (columns): `out[ri * zv.len() + zi]`.
pub fn radial_profile(mp: &Microscope, wavelength: f64, radii: &[f64], zv: &[f64], zp: f64) -> Vec<f64> {
    let k = 2.0 * PI / wavelength;
    let r_max = radii.iter().cloned().fold(0.0, f64::max);
    let (nodes, weights) = quadrature(mp, k, zv, zp, r_max);
    // exp(i k OPD) rho w, per focal depth and node.
    let phase: Vec<Vec<Complex>> = zv
        .iter()
        .map(|&z| {
            nodes
                .iter()
                .zip(&weights)
                .map(|(&rho, &w)| {
                    let l = opd(mp, rho, z, zp);
                    let amplitude = (-k * l.im).exp() * rho * w;
                    let angle = k * l.re;
                    Complex { re: amplitude * angle.cos(), im: amplitude * angle.sin() }
                })
                .collect()
        })
        .collect();
    let mut out = vec![0.0; radii.len() * zv.len()];
    let mut bessel = vec![0.0; nodes.len()];
    for (ri, &r) in radii.iter().enumerate() {
        for (b, &rho) in bessel.iter_mut().zip(&nodes) {
            *b = libm::j0(k * mp.na * r * rho);
        }
        for (zi, row) in phase.iter().enumerate() {
            let (mut re, mut im) = (0.0, 0.0);
            for (b, p) in bessel.iter().zip(row) {
                re += b * p.re;
                im += b * p.im;
            }
            out[ri * zv.len() + zi] = re * re + im * im;
        }
    }
    out
}

/// How the sample was imaged.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Modality {
    /// Emission PSF only.
    Widefield,
    /// The product of the excitation and emission PSFs: a confocal pinhole much smaller than
    /// one Airy unit.
    Confocal { excitation_um: f64 },
}

/// A PSF request: an `nz x xy_size x xy_size` volume centred on a point source at depth `pz`.
#[derive(Clone, Debug)]
pub struct PsfSpec {
    pub microscope: Microscope,
    pub modality: Modality,
    pub emission_um: f64,
    pub dxy: f64,
    pub dz: f64,
    pub xy_size: usize,
    pub nz: usize,
    pub pz: f64,
}

/// One wavelength's PSF volume `[z][y][x]` (x fastest), unnormalised. The source sits on the
/// centre of pixel `(xy_size - 1) / 2` laterally and on the centre plane axially.
fn volume(spec: &PsfSpec, wavelength: f64) -> Vec<f64> {
    let n = spec.xy_size;
    let centre = (n as f64 - 1.0) / 2.0;
    // Distinct squared pixel distances, each integrated once.
    let mut index: HashMap<u64, usize> = HashMap::new();
    let mut radii = Vec::new();
    let mut pixel_radius = Vec::with_capacity(n * n);
    for row in 0..n {
        for col in 0..n {
            let (dx, dy) = (col as f64 - centre, row as f64 - centre);
            let squared = dx * dx + dy * dy;
            let id = *index.entry(squared.to_bits()).or_insert_with(|| {
                radii.push(spec.dxy * squared.sqrt());
                radii.len() - 1
            });
            pixel_radius.push(id);
        }
    }
    let zv = centered_zv(spec.nz, spec.dz, spec.pz);
    let profile = radial_profile(&spec.microscope, wavelength, &radii, &zv, spec.pz);
    let mut out = Vec::with_capacity(spec.nz * n * n);
    for zi in 0..spec.nz {
        out.extend(pixel_radius.iter().map(|&ri| profile[ri * spec.nz + zi]));
    }
    out
}

fn normalise_peak(values: &mut [f64]) {
    let max = values.iter().cloned().fold(0.0, f64::max);
    if max > 0.0 {
        values.iter_mut().for_each(|v| *v /= max);
    }
}

/// The PSF volume `[z][y][x]`, peak 1. A confocal PSF multiplies the excitation and emission
/// PSFs (each peak-normalised) and is renormalised to peak 1.
pub fn psf_volume(spec: &PsfSpec) -> Vec<f64> {
    let mut psf = volume(spec, spec.emission_um);
    normalise_peak(&mut psf);
    if let Modality::Confocal { excitation_um } = spec.modality {
        let mut excitation = volume(spec, excitation_um);
        normalise_peak(&mut excitation);
        psf.iter_mut().zip(&excitation).for_each(|(a, b)| *a *= b);
        normalise_peak(&mut psf);
    }
    psf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gauss_legendre_integrates_polynomials_exactly() {
        let (x, w) = gauss_legendre(GL_ORDER);
        assert!((w.iter().sum::<f64>() - 2.0).abs() < 1e-14);
        // x^30 integrates to 2/31 on [-1, 1].
        let integral: f64 = x.iter().zip(&w).map(|(x, w)| w * x.powi(30)).sum();
        assert!((integral - 2.0 / 31.0).abs() < 1e-14);
    }

    #[test]
    fn in_focus_index_matched_psf_is_an_airy_pattern() {
        // No aberration in focus: (2 J1(v) / v)^2 with v = 2 pi NA r / lambda.
        let mp = Microscope { ns: 1.515, ..Microscope::default() };
        let wavelength = 0.6;
        let radii: Vec<f64> = (0..60).map(|i| i as f64 * 0.01).collect();
        let profile = radial_profile(&mp, wavelength, &radii, &[0.0], 0.0);
        let peak = profile[0];
        for (r, value) in radii.iter().zip(&profile).skip(1) {
            let v = 2.0 * PI * mp.na * r / wavelength;
            let airy = (2.0 * libm::j1(v) / v).powi(2);
            assert!((value / peak - airy).abs() < 1e-12, "r {r}: {} vs {airy}", value / peak);
        }
    }

    #[test]
    fn on_axis_defocus_matches_the_closed_form() {
        // Index matched, on axis: the integral of exp(i k z sqrt(n^2 - NA^2 rho^2)) rho d rho
        // has the closed form below (substitute u = sqrt(n^2 - NA^2 rho^2)).
        let mp = Microscope { ns: 1.515, ..Microscope::default() };
        let (n, na, wavelength) = (mp.ni, mp.na, 0.52);
        let k = 2.0 * PI / wavelength;
        let zv = [-3.0, -1.1, 0.4, 2.5];
        let profile = radial_profile(&mp, wavelength, &[0.0], &zv, 0.0);
        let (u0, u1) = (n, (n * n - na * na).sqrt());
        for (zi, &z) in zv.iter().enumerate() {
            // integral_u1^u0 exp(-i k z u) u du / NA^2 (the OPD is -z u here).
            let a = -k * z;
            let antiderivative = |u: f64| -> (f64, f64) {
                // exp(i a u) (u / (i a) + 1 / a^2)
                let (c, s) = ((a * u).cos(), (a * u).sin());
                let (re, im) = (1.0 / (a * a), -u / a);
                (c * re - s * im, c * im + s * re)
            };
            let (p, q) = (antiderivative(u0), antiderivative(u1));
            let (re, im) = ((p.0 - q.0) / (na * na), (p.1 - q.1) / (na * na));
            let want = re * re + im * im;
            assert!((profile[zi] - want).abs() < 1e-12 * want.max(1e-6), "z {z}: {} vs {want}", profile[zi]);
        }
    }

    #[test]
    fn index_matched_psf_is_symmetric_in_z_and_peaks_at_the_centre() {
        let spec = PsfSpec {
            microscope: Microscope::default(),
            modality: Modality::Widefield,
            emission_um: 0.52,
            dxy: 0.1,
            dz: 0.2,
            xy_size: 9,
            nz: 7,
            pz: 0.0,
        };
        let psf = psf_volume(&spec);
        let plane = 81;
        for z in 0..3 {
            for i in 0..plane {
                let (a, b) = (psf[z * plane + i], psf[(6 - z) * plane + i]);
                assert!((a - b).abs() < 1e-9 * a.abs().max(1e-12), "z {z} i {i}: {a} vs {b}");
            }
        }
        assert_eq!(psf[3 * plane + 40], 1.0);
    }
}
