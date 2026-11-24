//! Experimental enantiomorphic healing (`--features heal`), after SYNcro.py's `normalize`: the scan is mirrored
//! left-right, Greedy aligns the mirror to the scan (affine from the identity), and the lesion, dilated two voxels
//! and smoothed with a 3 mm FWHM Gaussian, mixes the aligned mirror into the scan. SynthSR then reads the healed
//! scan; every output is still resampled from the original.
//!
//! Unlike SYNcro.py (SSD on a skull-stripped MRI), the alignment uses NMI, and for CT a copy clipped to a brain
//! window: on CQ500-CT-4 SSD (raw or windowed) and NMI on raw Hounsfield units stayed at the identity, while the
//! mirror needed about 8.5 degrees of yaw (brute-force search agreed).

use super::{ITERATIONS, Runner, put, read_all};
use crate::geometry::{Grid, resample_nearest, same_geometry};
use crate::volume::{self, Volume, read};
use neurodesk_pipeline_host::{Host, join};

const DILATE_VOXELS: i64 = 2;
const FEATHER_FWHM_MM: f64 = 3.0;
/// Hounsfield window of the CT copy Greedy aligns: brain, blood and CSF keep their contrast, bone and air saturate.
const CT_WINDOW: (f32, f32) = (-100.0, 200.0);
/// A mirror alignment is near rigid; an axis scaled outside this range is a runaway fit (SOOP sub-683's 6 mm
/// TRACE scan reached x172 through-plane), so healing is skipped rather than blending a misplaced mirror.
const SCALE_LIMITS: (f64, f64) = (0.8, 1.25);

/// Writes work/healed.nii, the scan with the aligned mirror mixed in under the feathered lesion, and returns its
/// path; `None` when the mirror alignment is rejected and SynthSR should read the unhealed scan.
pub(super) async fn heal<H: Host>(
    r: &mut Runner<'_, H>,
    primary_path: &str,
    lesion_path: &str,
    fill: f32,
    ct: bool,
) -> Result<Option<String>, String> {
    let h = r.h;
    let work = |name: &str| join(&r.o.work, name);
    let (fixed, moving) = (work("mirror-fixed.nii"), work("mirror-moving.nii"));
    let (mirror_path, matrix, aligned, healed) = (
        work("mirror.nii"),
        work("mirror.mat"),
        work("mirror-aligned.nii"),
        work("healed.nii"),
    );
    let scan = read(&read_all(h, primary_path).await?)?;
    let mirrored = mirror(&scan);
    put(h, &mirror_path, &volume::write(&mirrored, "Mirrored scan")).await?;
    let (fixed, moving) = if ct {
        let windowed = Volume {
            data: scan
                .data
                .iter()
                .map(|x| x.clamp(CT_WINDOW.0, CT_WINDOW.1))
                .collect(),
            ..scan
        };
        put(h, &fixed, &volume::write(&windowed, "Windowed scan")).await?;
        let windowed_mirror = mirror(&windowed);
        put(
            h,
            &moving,
            &volume::write(&windowed_mirror, "Windowed mirror"),
        )
        .await?;
        (fixed, moving)
    } else {
        (primary_path.to_string(), mirror_path.clone())
    };
    drop(mirrored);
    let argv = r.greedy(&[
        "-a",
        "-m",
        "NMI",
        "-i",
        &fixed,
        &moving,
        "-o",
        &matrix,
        "-ia-identity",
        "-n",
        ITERATIONS,
    ]);
    r.step(argv, vec![], std::slice::from_ref(&matrix), false)
        .await?;
    let scales = axis_scales(&String::from_utf8_lossy(&read_all(h, &matrix).await?))?;
    if scales
        .iter()
        .any(|s| !(SCALE_LIMITS.0..=SCALE_LIMITS.1).contains(s))
    {
        h.log(&format!(
            "heal: mirror alignment rejected (axis scales {:.2} {:.2} {:.2}); continuing without healing",
            scales[0], scales[1], scales[2]
        ));
        return Ok(None);
    }
    r.greedy_reslice(
        primary_path,
        &mirror_path,
        &aligned,
        &[&matrix],
        false,
        fill,
    )
    .await?;
    let aligned = read(&read_all(h, &aligned).await?)?;
    let lesion = on_scan_grid(&read(&read_all(h, lesion_path).await?)?, &scan)?;
    let weights = feather(&lesion);
    let data = scan
        .data
        .iter()
        .zip(&aligned.data)
        .zip(&weights)
        .map(|((&s, &m), &w)| s * (1.0 - w) + m * w)
        .collect();
    let healed_scan = Volume { data, ..scan };
    put(h, &healed, &volume::write(&healed_scan, "Healed scan")).await?;
    Ok(Some(healed))
}

/// The lesion, binarized at 0.5, on the scan's grid. Input validation accepts a lesion one voxel larger or shifted
/// (`compatible_mask_geometry`), and the weights are zipped with the scan by index.
fn on_scan_grid(lesion: &Volume<f32>, scan: &Volume<f32>) -> Result<Volume<u8>, String> {
    let binary = Volume {
        data: lesion.data.iter().map(|&v| u8::from(v >= 0.5)).collect(),
        dims: lesion.dims,
        affine: lesion.affine,
    };
    if same_geometry(scan, &binary) {
        return Ok(binary);
    }
    let grid = Grid {
        dims: scan.dims,
        affine: scan.affine,
    };
    resample_nearest(&binary, &grid)
}

/// The lengths of the linear part's columns in a Greedy matrix file (four rows of four numbers).
// ponytail: column norms, not singular values; shear-only runaways would pass, none seen.
fn axis_scales(text: &str) -> Result<[f64; 3], String> {
    let m: Vec<f64> = text
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    if m.len() != 16 {
        return Err(format!(
            "mirror.mat: expected 16 numbers, found {}",
            m.len()
        ));
    }
    Ok([0, 1, 2].map(|c| (0..3).map(|r| m[4 * r + c].powi(2)).sum::<f64>().sqrt()))
}

/// Flips the voxel axis that runs left-right (the one whose direction points most along world x, whatever the
/// spacing: a 6 mm oblique slice axis can have a larger x entry than a 1 mm left-right axis); the affine is kept.
fn mirror(v: &Volume<f32>) -> Volume<f32> {
    let along_x = |a: usize| {
        v.affine[0][a].abs() / (0..3).map(|r| v.affine[r][a].powi(2)).sum::<f64>().sqrt()
    };
    let axis = (0..3)
        .max_by(|&a, &b| along_x(a).total_cmp(&along_x(b)))
        .unwrap();
    let [nx, ny, _] = v.dims;
    let stride = [1, nx, nx * ny][axis];
    let n = v.dims[axis];
    let data = (0..v.data.len())
        .map(|i| {
            let c = i / stride % n;
            v.data[i - c * stride + (n - 1 - c) * stride]
        })
        .collect::<Vec<_>>();
    Volume {
        data,
        dims: v.dims,
        affine: v.affine,
    }
}

/// The mixing weights: the lesion dilated to every voxel within two voxels (Euclidean), then smoothed as
/// scipy.ndimage.gaussian_filter does (truncate 4 sigma, reflected borders).
fn feather(lesion: &Volume<u8>) -> Vec<f32> {
    let d = lesion.dims.map(|n| n as i64);
    let index = |x: i64, y: i64, z: i64| (x + d[0] * (y + d[1] * z)) as usize;
    let mut w = vec![0f32; lesion.data.len()];
    let r = DILATE_VOXELS;
    for z in 0..d[2] {
        for y in 0..d[1] {
            for x in 0..d[0] {
                if lesion.data[index(x, y, z)] == 0 {
                    continue;
                }
                for k in -r..=r {
                    for j in -r..=r {
                        for i in -r..=r {
                            let (a, b, c) = (x + i, y + j, z + k);
                            if i * i + j * j + k * k <= r * r
                                && (0..d[0]).contains(&a)
                                && (0..d[1]).contains(&b)
                                && (0..d[2]).contains(&c)
                            {
                                w[index(a, b, c)] = 1.0;
                            }
                        }
                    }
                }
            }
        }
    }
    let sigma_mm = FEATHER_FWHM_MM / (2.0 * (2.0 * 2f64.ln()).sqrt());
    for axis in 0..3 {
        let spacing = (0..3)
            .map(|row| lesion.affine[row][axis].powi(2))
            .sum::<f64>()
            .sqrt();
        smooth_axis(&mut w, lesion.dims, axis, sigma_mm / spacing);
    }
    w
}

/// One separable Gaussian pass along `axis`, scipy's kernel and `reflect` border (d c b a | a b c d).
fn smooth_axis(data: &mut [f32], dims: [usize; 3], axis: usize, sigma: f64) {
    let radius = (4.0 * sigma + 0.5) as i64;
    let mut kernel: Vec<f64> = (-radius..=radius)
        .map(|x| (-0.5 * (x * x) as f64 / (sigma * sigma)).exp())
        .collect();
    let sum: f64 = kernel.iter().sum();
    kernel.iter_mut().for_each(|k| *k /= sum);
    let n = dims[axis] as i64;
    let stride = [1, dims[0], dims[0] * dims[1]][axis];
    let reflect = |mut i: i64| {
        let period = 2 * n;
        i = i.rem_euclid(period);
        if i >= n { period - 1 - i } else { i }
    };
    let mut line = vec![0f32; n as usize];
    for start in 0..data.len() {
        if start / stride % n as usize != 0 {
            continue;
        }
        for (c, v) in line.iter_mut().enumerate() {
            *v = data[start + c * stride];
        }
        if line.iter().all(|&v| v == 0.0) {
            continue;
        }
        for c in 0..n {
            let value: f64 = kernel
                .iter()
                .enumerate()
                .map(|(t, k)| k * line[reflect(c + t as i64 - radius) as usize] as f64)
                .sum();
            data[start + c as usize * stride] = value as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An accepted lesion one voxel short on x lands on the scan's 8x8x8 grid, voxels in place.
    #[test]
    fn lesion_border_is_resampled_onto_the_scan() {
        let affine = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ];
        let scan = Volume {
            data: vec![0f32; 512],
            dims: [8, 8, 8],
            affine,
        };
        let mut data = vec![0f32; 448];
        data[3 + 7 * (2 + 8 * 5)] = 1.0;
        let lesion = Volume {
            data,
            dims: [7, 8, 8],
            affine,
        };
        let on = on_scan_grid(&lesion, &scan).unwrap();
        assert_eq!(on.data.len(), 512);
        let set: Vec<usize> = (0..512).filter(|&i| on.data[i] == 1).collect();
        assert_eq!(set, [3 + 8 * (2 + 8 * 5)]);
    }

    /// 1x1x6 mm voxels tilted 15 degrees: the slice axis's x entry (6 sin 15 = 1.55) exceeds the left-right one.
    #[test]
    fn mirror_picks_left_right_by_direction_not_spacing() {
        let (c, s) = (15f64.to_radians().cos(), 15f64.to_radians().sin());
        let v = Volume {
            data: (0..12).map(|i| i as f32).collect(),
            dims: [3, 2, 2],
            affine: [
                [c, 0.0, 6.0 * s, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [-s, 0.0, 6.0 * c, 0.0],
            ],
        };
        assert_eq!(
            mirror(&v).data,
            [2., 1., 0., 5., 4., 3., 8., 7., 6., 11., 10., 9.]
        );
    }

    #[test]
    fn mirror_flips_the_left_right_axis() {
        let v = Volume {
            data: (0..12).map(|i| i as f32).collect(),
            dims: [3, 2, 2],
            affine: [
                [-1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
            ],
        };
        assert_eq!(
            mirror(&v).data,
            [2., 1., 0., 5., 4., 3., 8., 7., 6., 11., 10., 9.]
        );
    }

    /// SOOP sub-683's runaway mirror affine (12 dof, 6 mm slices) against its rigid solution.
    #[test]
    fn axis_scales_flag_a_runaway_mirror_fit() {
        let runaway = "1.148 1.185 -54.23 -79.25\n-0.164 1.368 -22.79 -40.96\n-0.305 -2.830 153.5 233.2\n0 0 0 1\n";
        let rigid =
            "0.970 0.030 -0.241 2.12\n-0.027 0.999 0.017 -0.37\n0.242 -0.010 0.970 2.25\n0 0 0 1\n";
        assert!(axis_scales(runaway).unwrap()[2] > 100.0);
        assert!(
            axis_scales(rigid)
                .unwrap()
                .iter()
                .all(|s| (s - 1.0).abs() < 0.01)
        );
    }

    /// scipy.ndimage.gaussian_filter(np.eye(1, 9, 4)[0], 1.0): truncate 4 sigma, reflected borders.
    #[test]
    fn smoothing_matches_scipy() {
        let mut line = [0f32; 9];
        line[4] = 1.0;
        smooth_axis(&mut line, [9, 1, 1], 0, 1.0);
        let scipy = [0.00013383, 0.00443186, 0.05399112, 0.24197144, 0.39894346];
        for (c, s) in scipy.iter().enumerate() {
            assert!((line[c] - s).abs() < 1e-6 && (line[8 - c] - s).abs() < 1e-6);
        }
    }
}
