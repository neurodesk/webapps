// SPDX-License-Identifier: Apache-2.0
//! Synthetic ground truth for the whole correction: a diffusion phantom moved by known rigid
//! transforms, distorted by a known susceptibility field and known eddy-current fields, and
//! with dropped slices. The phantom and the fields are continuous functions, so each
//! acquired voxel is computed exactly from the forward model; only the correction itself
//! interpolates.

use dwi_ec_distortion::Model;
use dwi_shoreline::rigid::Rigid;
use dwi_shoreline::volume::Grid;
use dwi_shoreline::{Acquisition, Input, Options, VolumeParams, run};
use std::f64::consts::PI;

const DIMS: [usize; 3] = [26, 36, 18];
const VOXEL: f64 = 2.0;
const READOUT: f64 = 0.05;
const PE_AXIS: usize = 1;

fn grid() -> Grid {
    Grid {
        dims: DIMS,
        voxel_size: [VOXEL; 3],
    }
}

/// A deterministic generator (SplitMix64, Box-Muller).
struct Rng(u64);

impl Rng {
    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gaussian(&mut self) -> f64 {
        let u = self.uniform().max(1e-300);
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * self.uniform()).cos()
    }

    fn symmetric(&mut self, scale: f64) -> f64 {
        (2.0 * self.uniform() - 1.0) * scale
    }
}

fn centre() -> [f64; 3] {
    std::array::from_fn(|a| (DIMS[a] as f64 - 1.0) / 2.0)
}

/// Voxel coordinates to the physical frame of `dwi_shoreline::rigid` (mm).
fn mm(x: [f64; 3]) -> [f64; 3] {
    let c = centre();
    std::array::from_fn(|a| (x[a] - c[a]) * VOXEL)
}

fn voxel_of(p: [f64; 3]) -> [f64; 3] {
    let c = centre();
    std::array::from_fn(|a| p[a] / VOXEL + c[a])
}

fn ellipsoid(p: [f64; 3]) -> f64 {
    p[0] * p[0] / 22.0f64.powi(2) + p[1] * p[1] / 25.0f64.powi(2) + p[2] * p[2] / 15.0f64.powi(2)
}

/// Brain-like b0 signal with a soft edge and structure along every axis (model space, mm).
fn b0_signal(p: [f64; 3]) -> f64 {
    let edge = 1.0 / (1.0 + ((ellipsoid(p) - 1.0) * 12.0).exp());
    edge * (600.0
        + 200.0 * (0.14 * p[0]).sin() * (0.11 * p[1]).cos()
        + 120.0 * (0.2 * p[2] + 0.09 * p[1]).sin())
}

/// The signal of direction `g` at b-value `b`: one tensor (FA about 0.45) whose orientation
/// turns in space. 3dSHORE (radial order 6) predicts a single tensor this anisotropic to
/// about 0.4 %; at FA 0.75 its leave-out error is about 3 % (median), and the spatial
/// pattern of that error biases the registration of the diffusion-weighted volumes.
fn signal(p: [f64; 3], b: f64, g: [f64; 3]) -> f64 {
    if b == 0.0 {
        return b0_signal(p);
    }
    let phi = 0.06 * p[0] + 0.04 * p[2];
    let e = [phi.cos(), phi.sin(), 0.3];
    let n = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt();
    let cos = (g[0] * e[0] + g[1] * e[1] + g[2] * e[2]) / n;
    let adc = 0.5e-3 + 0.8e-3 * cos * cos;
    b0_signal(p) * (-b * adc).exp()
}

/// Susceptibility field (Hz) in model space: a bump near the front of the "brain".
fn field_hz(p: [f64; 3]) -> f64 {
    let d2 = (p[0] - 3.0).powi(2) + (p[1] - 14.0).powi(2) + (p[2] + 4.0).powi(2);
    40.0 * (-d2 / (2.0 * 12.0f64.powi(2))).exp() - 8.0
}

/// How the field changes per radian about x and y (scaled to at most 1): smooth bumps near
/// the front and the base, where the field is strongest.
fn field_change(p: [f64; 3]) -> [f64; 2] {
    let bump = |c: [f64; 3], s: f64| {
        let d2 = (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2);
        (-d2 / (2.0 * s * s)).exp()
    };
    [
        bump([0.0, 15.0, -6.0], 12.0),
        -bump([5.0, 5.0, -10.0], 14.0),
    ]
}

/// The eddy-current field (Hz) at volume voxel coordinates `q`, terms as
/// `dwi_ec_distortion::Model::Quadratic` on coordinates scaled to -1..1 between voxel centres.
fn ec_hz(coefficients: &[f64], q: [f64; 3]) -> f64 {
    if coefficients.is_empty() {
        return 0.0;
    }
    let c = centre();
    let [x, y, z]: [f64; 3] = std::array::from_fn(|a| (q[a] - c[a]) / c[a]);
    let t = [1.0, x, y, z, x * x, y * y, z * z, x * y, x * z, y * z];
    t.iter().zip(coefficients).map(|(t, c)| t * c).sum()
}

/// Golden-spiral directions over the sphere (`extent` 2) or the upper half (`extent` 1).
fn spiral(n: usize, twist: f64, extent: f64) -> Vec<[f64; 3]> {
    (0..n)
        .map(|i| {
            let z = 1.0 - extent * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = i as f64 * PI * (3.0 - 5f64.sqrt()) + twist;
            [r * phi.cos(), r * phi.sin(), z]
        })
        .collect()
}

/// The acquisition: shells (b-value, directions), a b0 volume every `b0_every` volumes,
/// whether the series starts with a diffusion-weighted volume, the phase-encoding axis and
/// whether every other volume has the opposite polarity.
#[derive(Clone)]
struct Scheme {
    shells: Vec<(f64, usize)>,
    half_sphere: bool,
    b0_every: usize,
    dwi_first: bool,
    pe_axis: usize,
    alternate_polarity: bool,
    /// Every volume acquired twice in a row, with opposite polarities (for `--resamp=lsr`).
    paired: bool,
    /// Scale of the head motion (1: a drift of up to 2 mm and 2.5 degrees plus jitter).
    motion: f64,
    /// Movement within each volume (mm and degrees of each cosine coefficient, orders 1 and
    /// 2), acquired with interleaved slices.
    intra: f64,
    /// How much the field changes with rotations about x and y (Hz per radian at most).
    field_change: f64,
    /// The diffusion encodings (b-value, direction) in acquisition order, instead of shells.
    encodings: Option<Vec<(f64, [f64; 3])>>,
    /// Slices acquired together (multiband factor); a dropout takes out the whole group.
    multiband: usize,
}

impl Default for Scheme {
    fn default() -> Self {
        // 6 b0 volumes and 2 shells (32 and 64 directions, whole sphere) interleaved: 3dSHORE
        // needs about as many samples as its 72 coefficients in each leave-out fit.
        Self {
            shells: vec![(1000.0, 32), (2000.0, 64)],
            half_sphere: false,
            b0_every: 16,
            dwi_first: false,
            pe_axis: PE_AXIS,
            alternate_polarity: false,
            paired: false,
            motion: 1.0,
            intra: 0.0,
            field_change: 0.0,
            encodings: None,
            multiband: 1,
        }
    }
}

/// Diffusion spectrum imaging: the points of a Cartesian q-space grid within radius 3,
/// b_max at the edge (122 encodings on 9 distinct b-values with 6 to 30 directions each).
fn dsi_grid(b_max: f64) -> Vec<(f64, [f64; 3])> {
    let mut out = Vec::new();
    for i in -3i32..=3 {
        for j in -3i32..=3 {
            for k in -3i32..=3 {
                let r2 = i * i + j * j + k * k;
                if r2 == 0 || r2 > 9 {
                    continue;
                }
                let r = (r2 as f64).sqrt();
                out.push((
                    b_max * r2 as f64 / 9.0,
                    [i as f64 / r, j as f64 / r, k as f64 / r],
                ));
            }
        }
    }
    out
}

/// Encodings without shells: every volume its own b-value, spread evenly over a range, in
/// directions spread over the sphere.
fn spread_b(n: usize, b: (f64, f64)) -> Vec<(f64, [f64; 3])> {
    spiral(n, 0.3, 2.0)
        .into_iter()
        .enumerate()
        .map(|(i, g)| {
            (
                b.0 + (b.1 - b.0) * ((i * 37) % n) as f64 / (n - 1) as f64,
                g,
            )
        })
        .collect()
}

struct Phantom {
    input: Input,
    truth: Vec<VolumeParams>,
    /// (volume, slice) pairs that were dropped.
    dropped: Vec<(usize, usize)>,
}

fn phantom(dropouts: bool, ec_scale: f64, field_scale: f64) -> Phantom {
    phantom_with(&Scheme::default(), dropouts, ec_scale, field_scale)
}

fn phantom_with(scheme: &Scheme, dropouts: bool, ec_scale: f64, field_scale: f64) -> Phantom {
    let g = grid();
    let mut rng = Rng(20261019);
    let extent = if scheme.half_sphere { 1.0 } else { 2.0 };
    let sets: Vec<Vec<[f64; 3]>> = scheme
        .shells
        .iter()
        .enumerate()
        .map(|(i, &(_, n))| spiral(n, 0.3 + 0.8 * i as f64, extent))
        .collect();
    // Interleave the shells in proportion to their sizes.
    let total: usize = scheme.shells.iter().map(|s| s.1).sum();
    let mut taken = vec![0usize; sets.len()];
    let mut order: Vec<(f64, [f64; 3])> = scheme.encodings.clone().unwrap_or_default();
    for i in 0..if scheme.encodings.is_some() { 0 } else { total } {
        let s = (0..sets.len())
            .filter(|&s| taken[s] < sets[s].len())
            .min_by(|&a, &b| {
                let fa = taken[a] as f64 / sets[a].len() as f64;
                let fb = taken[b] as f64 / sets[b].len() as f64;
                fa.total_cmp(&fb)
            })
            .unwrap();
        let _ = i;
        order.push((scheme.shells[s].0, sets[s][taken[s]]));
        taken[s] += 1;
    }
    let mut bvals = Vec::new();
    let mut bvecs = Vec::new();
    let mut polarity = Vec::new();
    let copies = if scheme.paired { 2 } else { 1 };
    for (i, (b, gr)) in order.into_iter().enumerate() {
        if i % scheme.b0_every == usize::from(scheme.dwi_first) {
            for c in 0..copies {
                bvals.push(0.0);
                bvecs.push([0.0; 3]);
                polarity.push(if c == 1 { -1.0 } else { 1.0 });
            }
        }
        for c in 0..copies {
            bvals.push(b);
            bvecs.push(gr);
            polarity.push(if c == 1 { -1.0 } else { 1.0 });
        }
    }
    let nv = bvals.len();
    let first_b0 = bvals.iter().position(|&b| b == 0.0).unwrap();
    let pe_axis = scheme.pe_axis;
    let sign = |v: usize| -> f64 {
        if scheme.alternate_polarity && v % 2 == 1 {
            -1.0
        } else {
            polarity[v]
        }
    };
    // Eddy currents linear in g · b / b_max, as the second-level model assumes.
    let beta: Vec<[f64; 3]> = (0..10)
        .map(|k| {
            let scale = match k {
                // About ADNI's eddy estimates: offsets and edge values of a few Hz.
                0 => 10.0,
                1..=3 => 8.0,
                _ => 3.0,
            };
            [
                rng.symmetric(scale) * ec_scale,
                rng.symmetric(scale) * ec_scale,
                rng.symmetric(scale) * ec_scale,
            ]
        })
        .collect();
    // Head motion: a slow drift (as heads move) plus a small jitter per volume.
    let drift_t = [rng.symmetric(2.0), rng.symmetric(2.0), rng.symmetric(2.0)];
    let drift_r = [rng.symmetric(2.5), rng.symmetric(2.5), rng.symmetric(2.5)];
    let truth: Vec<VolumeParams> = (0..nv)
        .map(|v| {
            let s = v as f64 / (nv - 1) as f64;
            let rigid = if v == first_b0 {
                Rigid::default()
            } else {
                Rigid {
                    translation: std::array::from_fn(|a| {
                        scheme.motion * (drift_t[a] * s + rng.symmetric(0.4))
                    }),
                    rotation: std::array::from_fn(|a| {
                        (scheme.motion * (drift_r[a] * s + rng.symmetric(0.5))).to_radians()
                    }),
                }
            };
            let ec = if bvals[v] == 0.0 {
                Vec::new()
            } else {
                let q: [f64; 3] = std::array::from_fn(|a| bvecs[v][a] * bvals[v] / 2000.0);
                beta.iter()
                    .map(|b| b[0] * q[0] + b[1] * q[1] + b[2] * q[2])
                    .collect()
            };
            let s2v = if scheme.intra > 0.0 && v != first_b0 {
                (0..2)
                    .map(|k| {
                        let a = scheme.intra / (k + 1) as f64;
                        std::array::from_fn(|j| {
                            let c = rng.symmetric(a);
                            if j < 3 { c } else { c.to_radians() }
                        })
                    })
                    .collect()
            } else {
                Vec::new()
            };
            VolumeParams { rigid, ec, s2v }
        })
        .collect();
    let mut dropped = Vec::new();
    if dropouts {
        // Diffusion-weighted volumes at a few points of the series.
        for (fraction, s) in [(0.03, 7), (0.2, 9), (0.45, 8), (0.8, 10)] {
            let v = ((fraction * nv as f64) as usize..nv)
                .find(|&v| bvals[v] > 0.0 && !dropped.iter().any(|d: &(usize, usize)| d.0 == v))
                .unwrap();
            dropped.push((v, s));
        }
    }
    let times = slice_times(scheme.multiband);
    // A dropout takes out every slice acquired with the dropped one.
    let dropped_slice = |v: usize, slice: usize| {
        dropped
            .iter()
            .any(|&(dv, ds)| dv == v && times[ds] == times[slice])
    };
    let volumes: Vec<Vec<f32>> = (0..nv)
        .map(|v| {
            let p = &truth[v];
            let k = READOUT * sign(v);
            (0..g.voxels())
                .map(|i| {
                    let x = g.ijk(i).map(|a| a as f64);
                    // The head's position when this slice was acquired.
                    let r = p.rigid_at(times[g.ijk(i)[2]]);
                    let model = |q: [f64; 3]| -> [f64; 3] { voxel_of(r.apply(mm(q))) };
                    let change = |m: [f64; 3]| -> f64 {
                        let [dx, dy] = field_change(m);
                        scheme.field_change * (r.rotation[0] * dx + r.rotation[1] * dy)
                    };
                    let d = |q: [f64; 3]| -> f64 {
                        let m = mm(model(q));
                        k * (field_scale * field_hz(m) + change(m) + ec_hz(&p.ec, q))
                    };
                    let mut q = x;
                    for _ in 0..30 {
                        q[pe_axis] = x[pe_axis] - d(q);
                    }
                    let mut qh = q;
                    qh[pe_axis] += 1e-4;
                    let jacobian = 1.0 + (d(qh) - d(q)) / 1e-4;
                    let m = model(q);
                    // A rotated head sees the gradient turned with it.
                    let direction = dwi_shoreline::rigid::apply(&r.matrix(), bvecs[v]);
                    let mut y = signal(mm(m), bvals[v], direction) / jacobian;
                    if dropped_slice(v, g.ijk(i)[2]) {
                        y *= 0.4;
                    }
                    (y + 3.0 * rng.gaussian()) as f32
                })
                .collect()
        })
        .collect();
    let mask: Vec<bool> = (0..g.voxels())
        .map(|i| ellipsoid(mm(g.ijk(i).map(|a| a as f64))) < 1.0)
        .collect();
    let field: Vec<f32> = (0..g.voxels())
        .map(|i| (field_scale * field_hz(mm(g.ijk(i).map(|a| a as f64)))) as f32)
        .collect();
    Phantom {
        input: Input {
            grid: g,
            volumes,
            bvals,
            bvecs,
            mask,
            acquisitions: (0..nv)
                .map(|v| Acquisition {
                    pe_axis,
                    pe_sign: sign(v),
                    readout_time: READOUT,
                })
                .collect(),
            field_hz: Some(field),
            slice_times: Some(times),
            slice_groups: None,
        },
        truth,
        dropped,
    }
}

/// The gradient direction of volume `v` relative to the head (turned by its rotation): the
/// direction the true corrected image shows.
fn head_direction(p: &Phantom, v: usize) -> [f64; 3] {
    dwi_shoreline::rigid::apply(&p.truth[v].rigid.matrix(), p.input.bvecs[v])
}

/// Interleaved slices: the even ones, then the odd ones; times 0..1 within a volume.
/// Each slice's acquisition time within the volume: interleaved, with `multiband` slices
/// (k, k + n/multiband, ...) at once.
fn slice_times(multiband: usize) -> Vec<f64> {
    let n = DIMS[2];
    let per = n / multiband;
    let order: Vec<usize> = (0..per).step_by(2).chain((1..per).step_by(2)).collect();
    let mut times = vec![0.0; n];
    for (position, &first) in order.iter().enumerate() {
        for j in 0..multiband {
            times[first + j * per] = position as f64 / per as f64;
        }
    }
    times
}

fn options(repol: bool) -> Options {
    let mut o = Options {
        repol,
        ..Options::default()
    };
    o.ec_model = Some(Model::Quadratic);
    o.outliers.min_voxels = 100;
    o
}

/// RMS distance (mm) over the mask between where two transforms put the mask's points.
fn rms(mask: &[bool], a: &Rigid, b: &Rigid) -> f64 {
    let g = grid();
    let points: Vec<[f64; 3]> = (0..g.voxels())
        .filter(|&i| mask[i])
        .map(|i| mm(g.ijk(i).map(|a| a as f64)))
        .collect();
    let s: f64 = points
        .iter()
        .map(|&p| {
            let (x, y) = (a.apply(p), b.apply(p));
            (0..3).map(|i| (x[i] - y[i]).powi(2)).sum::<f64>()
        })
        .sum();
    (s / points.len() as f64).sqrt()
}

/// Median over the mask and the diffusion-weighted volumes of the eddy-current displacement
/// error (voxels), the field taken in each volume's true frame.
fn ec_error(mask: &[bool], truth: &[VolumeParams], estimate: &[VolumeParams]) -> f64 {
    let g = grid();
    let mut errors = Vec::new();
    for (t, e) in truth.iter().zip(estimate) {
        if t.ec.is_empty() {
            continue;
        }
        for i in (0..g.voxels()).filter(|&i| mask[i]).step_by(5) {
            let q = g.ijk(i).map(|a| a as f64);
            errors.push((READOUT * (ec_hz(&t.ec, q) - ec_hz(&e.ec, q))).abs());
        }
    }
    errors.sort_by(f64::total_cmp);
    errors[errors.len() / 2]
}

/// Relative RMS difference over the mask between the corrected volumes and the truth.
fn image_error(p: &Phantom, corrected: &[Vec<f32>]) -> f64 {
    let g = grid();
    let mut num = 0.0;
    let mut den = 0.0;
    for (v, c) in corrected.iter().enumerate() {
        for i in (0..g.voxels()).filter(|&i| p.input.mask[i]) {
            let s = signal(
                mm(g.ijk(i).map(|a| a as f64)),
                p.input.bvals[v],
                head_direction(p, v),
            );
            num += (c[i] as f64 - s).powi(2);
            den += s * s;
        }
    }
    (num / den).sqrt()
}

#[test]
fn motion_eddy_currents_and_field_are_recovered() {
    let p = phantom(false, 1.0, 1.0);
    let out = run(&p.input, &options(false), &mut |_| {}).unwrap();
    let mut motion: Vec<f64> = p
        .truth
        .iter()
        .zip(&out.params)
        .map(|(t, e)| rms(&p.input.mask, &t.rigid, &e.rigid))
        .collect();
    motion.sort_by(f64::total_cmp);
    let median = motion[motion.len() / 2];
    let worst = *motion.last().unwrap();
    let ec = ec_error(&p.input.mask, &p.truth, &out.params);
    // The floor is 3dSHORE's: its leave-out predictions of an anisotropic signal have a
    // spatially structured error that the registration partly follows (0.34 mm median here;
    // 0.19 mm with an isotropic signal, which it predicts exactly).
    assert!(
        median < 0.45 && worst < 0.9,
        "motion error median {median:.3} mm, worst {worst:.3} mm"
    );
    assert!(ec < 0.1, "eddy-current displacement error {ec:.3} voxels");
    let corrected = image_error(&p, &out.corrected);
    let uncorrected = image_error(&p, &p.input.volumes);
    assert!(
        corrected < 0.04 && corrected < uncorrected / 4.0,
        "image error {corrected:.4} (uncorrected {uncorrected:.4})"
    );
}

#[test]
fn dropped_slices_are_found_and_replaced() {
    let p = phantom(true, 1.0, 1.0);
    let out = run(&p.input, &options(true), &mut |_| {}).unwrap();
    let map = out.outliers.expect("outlier map");
    // In the volume's own space the dropped slice is `s`; motion is small, so it is found there.
    for &(v, s) in &p.dropped {
        assert!(map.outlier[v][s], "volume {v} slice {s} not found");
    }
    let flagged = map.count();
    assert!(
        flagged <= p.dropped.len() + 3,
        "{flagged} slices flagged for {} dropouts",
        p.dropped.len()
    );
    let corrected = image_error(&p, &out.corrected);
    assert!(
        corrected < 0.05,
        "image error with replaced slices {corrected:.4}"
    );
}

#[test]
fn multiband_groups_are_outliers_together() {
    // eddy's `--ol_type=gw`: the slices of a multiband group (here 3) are acquired at once,
    // so a dropout makes the whole group an outlier.
    let mut p = phantom(true, 1.0, 1.0);
    let slices = grid().dims[2];
    let per = slices / 3;
    p.input.slice_groups = Some((0..per).map(|k| vec![k, k + per, k + 2 * per]).collect());
    let o = Options {
        outlier_type: dwi_shoreline::OutlierType::Group,
        ..options(true)
    };
    let out = run(&p.input, &o, &mut |_| {}).unwrap();
    let map = out.outliers.expect("outlier map");
    for &(v, s) in &p.dropped {
        for t in [s % per, s % per + per, s % per + 2 * per] {
            assert!(
                map.outlier[v][t],
                "volume {v}: slice {t} of the group of {s}"
            );
        }
    }
    assert!(
        map.count() <= 3 * (p.dropped.len() + 1),
        "{} slices flagged for {} dropouts",
        map.count(),
        p.dropped.len()
    );
    let corrected = image_error(&p, &out.corrected);
    assert!(corrected < 0.05, "image error {corrected:.4}");
}

/// Median and worst motion error (mm), eddy-current error (voxels) and image error.
fn errors(p: &Phantom, o: &Options) -> (f64, f64, f64, f64, f64) {
    let out = run(&p.input, o, &mut |_| {}).unwrap();
    let mut motion: Vec<f64> = p
        .truth
        .iter()
        .zip(&out.params)
        .map(|(t, e)| rms(&p.input.mask, &t.rigid, &e.rigid))
        .collect();
    motion.sort_by(f64::total_cmp);
    let ec = if o.ec_model.is_some() {
        ec_error(&p.input.mask, &p.truth, &out.params)
    } else {
        0.0
    };
    (
        motion[motion.len() / 2],
        *motion.last().unwrap(),
        ec,
        image_error(p, &out.corrected),
        image_error(p, &p.input.volumes),
    )
}

#[test]
fn phase_encoding_along_x_with_both_polarities() {
    let scheme = Scheme {
        pe_axis: 0,
        alternate_polarity: true,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 1.0);
    let (median, worst, ec, image, uncorrected) = errors(&p, &options(false));
    eprintln!("pe x: motion {median:.3} {worst:.3} ec {ec:.3} image {image:.4} ({uncorrected:.4})");
    assert!(
        median < 0.45 && worst < 1.5,
        "motion {median:.3} {worst:.3}"
    );
    assert!(ec < 0.1, "eddy currents {ec:.3}");
    assert!(
        image < 0.04 && image < uncorrected / 3.0,
        "image {image:.4} ({uncorrected:.4})"
    );
}

#[test]
fn few_directions_and_a_diffusion_weighted_first_volume() {
    // 3 b0 volumes and 15 directions on one shell, starting with a diffusion-weighted volume:
    // the Gaussian process predicts it (3dSHORE needs 72 volumes).
    let scheme = Scheme {
        shells: vec![(1000.0, 15)],
        b0_every: 6,
        dwi_first: true,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 1.0);
    let (median, worst, ec, image, uncorrected) = errors(&p, &options(false));
    eprintln!("few: motion {median:.3} {worst:.3} ec {ec:.3} image {image:.4} ({uncorrected:.4})");
    assert!(
        median < 0.45 && worst < 0.9,
        "motion {median:.3} {worst:.3}"
    );
    // The second-level model rests on 15 volumes here.
    assert!(ec < 0.25, "eddy currents {ec:.3}");
    assert!(
        image < 0.04 && image < uncorrected / 4.0,
        "image {image:.4} ({uncorrected:.4})"
    );
}

#[test]
fn half_sphere_sampling() {
    // eddy's second-level model needs the whole sphere; on a half sphere the correction must
    // still recover the motion and the image.
    let scheme = Scheme {
        half_sphere: true,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 1.0);
    let (median, worst, ec, image, uncorrected) = errors(&p, &options(false));
    eprintln!("half: motion {median:.3} {worst:.3} ec {ec:.3} image {image:.4} ({uncorrected:.4})");
    assert!(
        median < 0.55 && worst < 1.5,
        "motion {median:.3} {worst:.3}"
    );
    assert!(
        image < 0.04 && image < uncorrected / 3.0,
        "image {image:.4} ({uncorrected:.4})"
    );
}

#[test]
fn spectrum_imaging_and_b_values_without_shells() {
    // A DSI grid (9 b-values with 6 to 30 directions each) and every volume with its own
    // b-value: the correction must recover the motion and the image without shells.
    for (name, encodings) in [
        ("dsi", dsi_grid(3000.0)),
        ("spread", spread_b(100, (300.0, 3000.0))),
    ] {
        let scheme = Scheme {
            encodings: Some(encodings),
            ..Scheme::default()
        };
        let p = phantom_with(&scheme, false, 1.0, 1.0);
        let (median, worst, ec, image, uncorrected) = errors(&p, &options(false));
        eprintln!(
            "{name}: motion {median:.3} {worst:.3} ec {ec:.3} image {image:.4} ({uncorrected:.4})"
        );
        // The corners of the DSI grid (b = 3000) are predicted worst (3dSHORE's leave-out
        // error up to 0.17 on the true images), and so is the worst volume's motion.
        assert!(
            median < 0.55 && worst < 2.0,
            "{name}: motion {median:.3} {worst:.3}"
        );
        assert!(
            image < 0.04 && image < uncorrected / 3.0,
            "{name}: image {image:.4} ({uncorrected:.4})"
        );
    }
}

/// Writes phantoms for an external comparison (for example with FSL eddy) into
/// `SHORELINE_PHANTOM_DIR`: per scheme, raw little-endian float32 arrays (x fastest) of the
/// series, the true images, the mask and the field, and a JSON description.
#[test]
#[ignore]
fn export_phantoms() {
    let Ok(dir) = std::env::var("SHORELINE_PHANTOM_DIR") else {
        return;
    };
    let schemes = [
        ("standard", Scheme::default()),
        (
            "pe_x_both",
            Scheme {
                pe_axis: 0,
                alternate_polarity: true,
                ..Scheme::default()
            },
        ),
        (
            "few15",
            Scheme {
                shells: vec![(1000.0, 15)],
                b0_every: 6,
                dwi_first: true,
                ..Scheme::default()
            },
        ),
        (
            "single30",
            Scheme {
                shells: vec![(1000.0, 30)],
                b0_every: 8,
                ..Scheme::default()
            },
        ),
        (
            "half",
            Scheme {
                half_sphere: true,
                ..Scheme::default()
            },
        ),
        (
            "heavy",
            Scheme {
                motion: 3.0,
                ..Scheme::default()
            },
        ),
        (
            "few6",
            Scheme {
                shells: vec![(1000.0, 6)],
                b0_every: 3,
                ..Scheme::default()
            },
        ),
        (
            "few10",
            Scheme {
                shells: vec![(1000.0, 10)],
                b0_every: 5,
                ..Scheme::default()
            },
        ),
        (
            "few20",
            Scheme {
                shells: vec![(1000.0, 20)],
                b0_every: 7,
                ..Scheme::default()
            },
        ),
        (
            "few12b2000",
            Scheme {
                shells: vec![(2000.0, 12)],
                b0_every: 6,
                ..Scheme::default()
            },
        ),
        (
            "intra",
            Scheme {
                intra: 1.0,
                ..Scheme::default()
            },
        ),
        (
            "multiband",
            Scheme {
                intra: 1.0,
                multiband: 3,
                ..Scheme::default()
            },
        ),
        (
            "dsi",
            Scheme {
                encodings: Some(dsi_grid(3000.0)),
                ..Scheme::default()
            },
        ),
        (
            "nonshelled",
            Scheme {
                encodings: Some(spread_b(100, (300.0, 3000.0))),
                ..Scheme::default()
            },
        ),
    ];
    let g = grid();
    let raw = |path: String, values: &mut dyn Iterator<Item = f32>| {
        let bytes: Vec<u8> = values.flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(path, bytes).unwrap();
    };
    for (name, scheme) in schemes {
        let p = phantom_with(&scheme, true, 1.0, 1.0);
        let base = format!("{dir}/{name}");
        raw(
            format!("{base}_series.f32"),
            &mut p.input.volumes.iter().flatten().copied(),
        );
        let truth: Vec<f32> = (0..p.input.volumes.len())
            .flat_map(|v| {
                let phantom = &p;
                let direction = head_direction(phantom, v);
                (0..g.voxels()).map(move |i| {
                    signal(
                        mm(g.ijk(i).map(|a| a as f64)),
                        phantom.input.bvals[v],
                        direction,
                    ) as f32
                })
            })
            .collect();
        raw(format!("{base}_truth.f32"), &mut truth.into_iter());
        raw(
            format!("{base}_mask.f32"),
            &mut p.input.mask.iter().map(|&m| if m { 1.0 } else { 0.0 }),
        );
        raw(
            format!("{base}_field.f32"),
            &mut p.input.field_hz.as_ref().unwrap().iter().copied(),
        );
        let acq: Vec<String> = p
            .input
            .acquisitions
            .iter()
            .map(|a| format!("[{},{},{}]", a.pe_axis, a.pe_sign, a.readout_time))
            .collect();
        let bvecs: Vec<String> = p
            .input
            .bvecs
            .iter()
            .map(|b| format!("[{},{},{}]", b[0], b[1], b[2]))
            .collect();
        let dropped: Vec<String> = p
            .dropped
            .iter()
            .map(|d| format!("[{},{}]", d.0, d.1))
            .collect();
        let json = format!(
            "{{\"dims\":[{},{},{}],\"voxel\":{VOXEL},\"bvals\":{:?},\"bvecs\":[{}],\"acquisitions\":[{}],\"dropped\":[{}]}}",
            g.dims[0],
            g.dims[1],
            g.dims[2],
            p.input.bvals,
            bvecs.join(","),
            acq.join(","),
            dropped.join(",")
        );
        std::fs::write(format!("{base}.json"), json).unwrap();
        if scheme.intra > 0.0 || scheme.multiband > 1 {
            // The slice order, the slices acquired together on one row (eddy's --slspec).
            let times = slice_times(scheme.multiband);
            let mut order: Vec<usize> = (0..times.len()).collect();
            order.sort_by(|&a, &b| times[a].total_cmp(&times[b]).then(a.cmp(&b)));
            let rows: Vec<String> = order
                .chunk_by(|&a, &b| times[a] == times[b])
                .map(|g| {
                    g.iter()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect();
            std::fs::write(format!("{base}.slspec"), rows.join("\n") + "\n").unwrap();
        }
    }
}

#[test]
fn a_single_b0_volume() {
    // Older protocols acquire one b0 volume: it is the reference, and the diffusion-weighted
    // volumes start from it.
    let scheme = Scheme {
        b0_every: 1000,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 1.0);
    assert_eq!(p.input.bvals.iter().filter(|&&b| b == 0.0).count(), 1);
    let (median, worst, ec, image, uncorrected) = errors(&p, &options(false));
    eprintln!(
        "one b0: motion {median:.3} {worst:.3} ec {ec:.3} image {image:.4} ({uncorrected:.4})"
    );
    assert!(
        image < 0.04 && image < uncorrected / 4.0,
        "image {image:.4} ({uncorrected:.4})"
    );
}

#[test]
fn least_squares_restoration_of_pairs() {
    // Each volume twice, with opposite polarities, and a stronger field: the pairs restored
    // together beat each volume resampled on its own (eddy's --resamp=lsr against jac).
    let scheme = Scheme {
        shells: vec![(1000.0, 32), (2000.0, 48)],
        paired: true,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 2.0);
    let truth_error = |out: &dwi_shoreline::Output| -> f64 {
        let g = grid();
        let (mut num, mut den) = (0.0, 0.0);
        for (c, src) in out.corrected.iter().zip(&out.sources) {
            for i in (0..g.voxels()).filter(|&i| p.input.mask[i]) {
                let t = signal(
                    mm(g.ijk(i).map(|a| a as f64)),
                    p.input.bvals[src[0]],
                    head_direction(&p, src[0]),
                );
                num += (c[i] as f64 - t).powi(2);
                den += t * t;
            }
        }
        (num / den).sqrt()
    };
    let jac = run(&p.input, &options(false), &mut |_| {}).unwrap();
    let mut o = options(false);
    o.resampling = dwi_shoreline::Resampling::LeastSquares;
    let lsr = run(&p.input, &o, &mut |_| {}).unwrap();
    assert_eq!(lsr.corrected.len(), p.input.volumes.len() / 2);
    assert!(lsr.sources.iter().all(|s| s.len() == 2));
    let (ej, el) = (truth_error(&jac), truth_error(&lsr));
    eprintln!("jac {ej:.4} lsr {el:.4}");
    assert!(el < ej, "least squares {el:.4}, Jacobian {ej:.4}");
}

#[test]
fn movement_within_volumes() {
    // Each volume also moves while its (interleaved) slices are acquired: slice-to-volume
    // correction (eddy's --mporder) recovers the image better than volume-to-volume.
    let scheme = Scheme {
        intra: 1.0,
        ..Scheme::default()
    };
    let p = phantom_with(&scheme, false, 1.0, 1.0);
    let (_, _, _, volume, uncorrected) = errors(&p, &options(false));
    let mut o = options(false);
    o.mporder = 4;
    let (_, _, _, slices, _) = errors(&p, &o);
    eprintln!(
        "within volumes: volume-to-volume {volume:.4}, slice-to-volume {slices:.4} ({uncorrected:.4})"
    );
    assert!(
        slices < 0.9 * volume,
        "slice-to-volume {slices:.4}, volume-to-volume {volume:.4}"
    );
}

#[test]
fn field_changing_with_rotation() {
    // The field changes with pitch and roll (up to 600 Hz per radian, about 10 Hz per
    // degree) under three times the motion: estimating that change (eddy's
    // --estimate_move_by_susceptibility) corrects the image better, and without a change it
    // costs nothing.
    let changing = |change: f64| -> (f64, f64) {
        let scheme = Scheme {
            motion: 3.0,
            field_change: change,
            ..Scheme::default()
        };
        let p = phantom_with(&scheme, false, 1.0, 1.0);
        let (_, _, _, without, _) = errors(&p, &options(false));
        let mut o = options(false);
        o.mbs = true;
        let (_, _, _, with, _) = errors(&p, &o);
        (without, with)
    };
    let (without, with) = changing(600.0);
    eprintln!("field change: without {without:.4}, with {with:.4}");
    assert!(
        with < 0.95 * without,
        "with {with:.4}, without {without:.4}"
    );
    let (without, with) = changing(0.0);
    assert!(
        with < 1.01 * without,
        "no change: with {with:.4}, without {without:.4}"
    );
}
