// SPDX-License-Identifier: Apache-2.0
//! The `shoreline` command line as a library function: eddy-style options in, eddy-style
//! files out, through `Files`, so that the native binary (the file system) and WebAssembly
//! (files held in memory) run the same code.

use std::collections::HashMap;

use dwi_ec_distortion::{Model, SecondLevel};
use dwi_pe_field::{PhaseEncoding, TopupCoefficients};

use crate::volume::Grid;
use crate::{Acquisition, Input, Options, nifti};

/// Where the command line reads its inputs and writes its outputs.
pub trait Files {
    /// The bytes of the file at `path`.
    fn read(&self, path: &str) -> Result<Vec<u8>, String>;
    /// The bytes of the file at `path`, which is not read again (held in memory, it can be
    /// handed over instead of copied).
    fn take(&mut self, path: &str) -> Result<Vec<u8>, String> {
        self.read(path)
    }
    /// Writes `bytes` to the file at `path`.
    fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), String>;
}

/// The file system.
pub struct FileSystem;

impl Files for FileSystem {
    fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(|e| format!("{path}: {e}"))
    }

    fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), String> {
        std::fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
    }
}

pub const USAGE: &str = "usage: shoreline --imain=DWI --mask=MASK --acqp=FILE --index=FILE --bvecs=FILE --bvals=FILE --out=BASE
  [--topup=BASE | --field=HZ.nii.gz [--field_mat=FLIRT.mat]] [--niter=5] [--fwhm=0[,..]] [--flm=quadratic|linear|movement]
  [--slm=linear|quadratic|none] [--repol] [--ol_nstd=4] [--ol_nvox=250] [--ol_type=sw|gw|both [--mb=N]] [--ol_pos] [--ol_sqr] [--ol_standardise=slice|shell] [--dont_sep_offs_move]
  [--dont_peas] [--dont_anchor_shells] [--dont_detrend_offset] [--linear_iterations=1] [--coarse_fwhm=8,4|none] [--model=auto|shore|gp] [--resamp=jac|lsr] [--mporder=N --slspec=FILE|--json=FILE [--s2v_niter=5] [--s2v_lambda=1]] [--estimate_move_by_susceptibility [--mbs_lambda=100] [--mbs_ksp=10]] [--lsr_lambda=0.01] [--ff=N] [--interp=spline|trilinear] [--gn_steps=2] [--gn_tol=0.05] [--dont_mask_output] [--nthr=N]";

/// Runs the command line on `argv` (without the program name). Each progress line goes to
/// `sink` and, with the others, to `<out>.log` (also when the run fails, once `--out` is
/// known).
pub fn run(
    argv: &[String],
    files: &mut dyn Files,
    sink: &mut dyn FnMut(&str),
) -> Result<(), String> {
    let args = parse(argv);
    let notes = check_flags(&args)?;
    let out = args
        .get("out")
        .cloned()
        .ok_or_else(|| format!("--out is required\n{USAGE}"))?;
    let start = crate::now();
    let mut text_log = String::new();
    let result = {
        let mut log = |line: String| {
            let line = format!("[{:7.1} s] {line}", crate::now() - start);
            sink(&line);
            text_log.push_str(&line);
            text_log.push('\n');
        };
        for note in notes {
            log(note);
        }
        correct(&args, &out, files, &mut log)
    };
    files.write(&format!("{out}.log"), text_log.into_bytes())?;
    result
}

/// `--key=value` and `--flag` arguments.
pub fn parse(argv: &[String]) -> HashMap<String, String> {
    let mut args = HashMap::new();
    for a in argv {
        let a = a.trim_start_matches('-').to_string();
        match a.split_once('=') {
            Some((k, v)) => args.insert(k.to_string(), v.to_string()),
            None => args.insert(a, String::new()),
        };
    }
    args
}

fn text(files: &dyn Files, path: &str) -> Result<String, String> {
    String::from_utf8(files.read(path)?).map_err(|_| format!("{path} is not text"))
}

fn numbers(files: &dyn Files, path: &str) -> Result<Vec<Vec<f64>>, String> {
    text(files, path)?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            l.split_whitespace()
                .map(|v| {
                    v.parse::<f64>()
                        .ok()
                        .filter(|x| x.is_finite())
                        .ok_or_else(|| format!("{path}: '{v}' is not a number"))
                })
                .collect()
        })
        .collect()
}

/// The gradient directions of `nv` volumes from the rows of a bvecs file: FSL's 3 × N, or
/// N × 3. With 3 volumes the two are the same shape, and the file is read as FSL's.
fn directions(rows: &[Vec<f64>], nv: usize, path: &str) -> Result<Vec<[f64; 3]>, String> {
    if rows.len() == 3 && rows.iter().all(|r| r.len() == nv) {
        Ok((0..nv)
            .map(|i| [rows[0][i], rows[1][i], rows[2][i]])
            .collect())
    } else if rows.len() == nv && rows.iter().all(|r| r.len() == 3) {
        Ok(rows.iter().map(|r| [r[0], r[1], r[2]]).collect())
    } else {
        let lengths: Vec<String> = rows.iter().map(|r| r.len().to_string()).collect();
        Err(format!(
            "{path}: expected 3 rows of {nv} directions (or {nv} rows of 3), found {} rows of {} values.",
            rows.len(),
            lengths.join(", ")
        ))
    }
}

fn correct(
    args: &HashMap<String, String>,
    out: &str,
    files: &mut dyn Files,
    log: &mut dyn FnMut(String),
) -> Result<(), String> {
    let get = |k: &str| {
        args.get(k)
            .cloned()
            .ok_or_else(|| format!("--{k} is required\n{USAGE}"))
    };
    let imain = get("imain")?;
    let (image, mut volumes) = nifti::decode_series(files.take(&imain)?, &imain)?;
    if image.dims.len() < 4 {
        return Err("--imain must be a 4D series.".into());
    }
    // Voxels without a value (NaN or infinite, as some conversions write) are taken as 0, as
    // outside the field of view.
    let missing: usize = volumes
        .iter_mut()
        .flat_map(|v| v.iter_mut())
        .filter(|x| !x.is_finite())
        .map(|x| *x = 0.0)
        .count();
    if missing > 0 {
        log(format!("{missing} voxels without a value set to 0"));
    }
    let dims = [image.dims[0], image.dims[1], image.dims[2]];
    let nv = image.dims[3];
    let n = dims.iter().product::<usize>();
    let grid = Grid {
        dims,
        voxel_size: image.pixdim,
    };
    let mask_path = get("mask")?;
    let mask_image = nifti::decode(files.read(&mask_path)?, &mask_path)?;
    if mask_image.data.len() != n {
        return Err("--mask does not match the series' grid.".into());
    }
    let mask: Vec<bool> = mask_image.data.iter().map(|&m| m > 0.0).collect();
    let bvals: Vec<f64> = numbers(&*files, &get("bvals")?)?.concat();
    let bvals_in = bvals.clone();
    let bvecs_path = get("bvecs")?;
    let bvecs = directions(&numbers(&*files, &bvecs_path)?, nv, &bvecs_path)?;
    let flip = dwi_pe_field::fsl_flips_x(&image.affine);
    let acqp = text(&*files, &get("acqp")?)?;
    let acqp: Vec<&str> = acqp.lines().filter(|l| !l.trim().is_empty()).collect();
    let index: Vec<usize> = numbers(&*files, &get("index")?)?
        .concat()
        .iter()
        .map(|&i| i as usize)
        .collect();
    let index = if index.len() == 1 {
        vec![index[0]; nv]
    } else {
        index
    };
    let acquisitions = index
        .iter()
        .map(|&i| {
            let line = acqp
                .get(i.wrapping_sub(1))
                .ok_or_else(|| format!("--index refers to acqp row {i}"))?;
            let values: Vec<f64> = line
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            if values.len() != 4 {
                return Err(format!("acqp row '{line}' does not have four numbers"));
            }
            let pe = PhaseEncoding::from_datain(&format!(
                "{} {} {} 1",
                values[0], values[1], values[2]
            ))?;
            let axis = pe.voxel_axis(&image.affine);
            let mut v = pe.vector;
            if flip {
                v[0] = -v[0];
            }
            Ok(Acquisition {
                pe_axis: axis,
                pe_sign: v[axis].signum(),
                readout_time: values[3],
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if bvals.len() != nv || acquisitions.len() != nv {
        return Err(format!(
            "{nv} volumes, but {} b-values, {} indices",
            bvals.len(),
            index.len()
        ));
    }
    let field_hz = if let Some(base) = args.get("topup") {
        let path = format!("{base}_fieldcoef.nii.gz");
        let coef = nifti::decode(files.read(&path)?, &path)?;
        let c = TopupCoefficients::new(
            [coef.dims[0], coef.dims[1], coef.dims[2]],
            coef.pixdim,
            &coef.data,
        )?;
        let hz = c.evaluate(dims, flip)?;
        Some(hz.into_iter().map(|h| h as f32).collect())
    } else if let Some(path) = args.get("field") {
        let mut f = nifti::decode(files.read(path)?, path)?;
        // As in --imain, a voxel without a value is taken as outside the field: 0 Hz.
        let missing = f
            .data
            .iter_mut()
            .filter(|x| !x.is_finite())
            .map(|x| *x = 0.0)
            .count();
        if missing > 0 {
            log(format!(
                "--field: {missing} voxels without a value set to 0 Hz"
            ));
        }
        let matrix = match args.get("field_mat") {
            Some(m) => {
                let rows = numbers(&*files, m)?;
                if rows.len() < 4 || rows.iter().take(4).any(|r| r.len() != 4) {
                    return Err(format!("{m}: expected a 4 × 4 matrix."));
                }
                Some(std::array::from_fn(|i| std::array::from_fn(|j| rows[i][j])))
            }
            None => None,
        };
        if f.data.len() == n && matrix.is_none() {
            Some(f.data)
        } else {
            Some(field_on_series(&f, &image, dims, matrix)?)
        }
    } else {
        None
    };

    let mut options = Options::default();
    if let Some(v) = args.get("niter") {
        options.iterations = v.parse().map_err(|_| "--niter")?;
    }
    if let Some(v) = args.get("fwhm") {
        options.fwhm = v
            .split(',')
            .map(|x| x.parse::<f64>().map_err(|_| "--fwhm".to_string()))
            .collect::<Result<_, _>>()?;
    }
    options.ec_model = match args.get("flm").map(String::as_str) {
        None | Some("quadratic") => Some(Model::Quadratic),
        Some("linear") => Some(Model::Linear),
        Some("movement") => None,
        Some(o) => return Err(format!("--flm={o} is not supported")),
    };
    options.second_level = match args.get("slm").map(String::as_str) {
        None | Some("none") => None,
        Some("linear") => Some(SecondLevel::Linear),
        Some("quadratic") => Some(SecondLevel::Quadratic),
        Some(o) => return Err(format!("--slm={o} is not supported")),
    };
    options.repol = args.contains_key("repol");
    if let Some(v) = args.get("ol_nstd") {
        options.outliers.n_std = v.parse().map_err(|_| "--ol_nstd")?;
    }
    options.outliers.per_slice_position = match args.get("ol_standardise").map(String::as_str) {
        None | Some("slice") => true,
        Some("shell") => false,
        Some(o) => return Err(format!("--ol_standardise={o} is not supported")),
    };
    if let Some(v) = args.get("ol_nvox") {
        options.outliers.min_voxels = v.parse().map_err(|_| "--ol_nvox")?;
    }
    options.outliers.positive = args.contains_key("ol_pos");
    options.outliers.squared = args.contains_key("ol_sqr");
    options.outlier_type = match args.get("ol_type").map(String::as_str) {
        None | Some("sw") => crate::OutlierType::Slice,
        Some("gw") => crate::OutlierType::Group,
        Some("both") => crate::OutlierType::Both,
        Some(o) => return Err(format!("--ol_type={o}: expected sw, gw or both")),
    };
    options.mask_output = !args.contains_key("dont_mask_output");
    options.separate_offset = !args.contains_key("dont_sep_offs_move");
    options.peas = !args.contains_key("dont_peas");
    options.robust = args.contains_key("robust");
    options.initial_repol = !args.contains_key("dont_initial_repol");
    options.coarse_repol = !args.contains_key("dont_coarse_repol");
    options.anchor_shells = !args.contains_key("dont_anchor_shells");
    options.detrend_offset = !args.contains_key("dont_detrend_offset");
    options.resampling = match args.get("resamp").map(String::as_str) {
        None | Some("jac") => crate::Resampling::Jacobian,
        Some("lsr") => crate::Resampling::LeastSquares,
        Some(o) => return Err(format!("--resamp={o} is not supported")),
    };
    if let Some(v) = args.get("lsr_lambda") {
        options.lsr_lambda = v.parse().map_err(|_| "--lsr_lambda")?;
    }
    options.model = match args.get("model").map(String::as_str) {
        None | Some("auto") => crate::PredictionModel::Auto,
        Some("shore") => crate::PredictionModel::Shore,
        Some("gp") => crate::PredictionModel::GaussianProcess,
        Some(o) => return Err(format!("--model={o} is not supported")),
    };
    options.local_b0 = !args.contains_key("global_b0");
    options.rotate_gradients = args.contains_key("rotate_gradients");
    options.first_ec_only = args.contains_key("first_ec_only");
    if let Some(v) = args.get("self_weight_from") {
        options.self_weight_from = v.parse().map_err(|_| "--self_weight_from")?;
    }
    if let Some(v) = args.get("self_weight") {
        options.self_weight = Some(v.parse().map_err(|_| "--self_weight")?);
    }
    if let Some(v) = args.get("ff") {
        options.gp_fudge = Some(v.parse().map_err(|_| "--ff")?);
    }
    options.mbs = args.contains_key("estimate_move_by_susceptibility");
    if let Some(v) = args.get("mbs_lambda") {
        options.mbs_lambda = v.parse().map_err(|_| "--mbs_lambda")?;
    }
    if let Some(v) = args.get("mbs_niter") {
        options.mbs_iterations = v.parse().map_err(|_| "--mbs_niter")?;
    }
    if let Some(v) = args.get("mbs_ksp") {
        options.mbs_spacing = v.parse().map_err(|_| "--mbs_ksp")?;
    }
    if let Some(v) = args.get("mporder") {
        options.mporder = v.parse().map_err(|_| "--mporder")?;
    }
    if let Some(v) = args.get("s2v_niter") {
        options.s2v_iterations = v.parse().map_err(|_| "--s2v_niter")?;
    }
    if let Some(v) = args.get("s2v_lambda") {
        options.s2v_lambda = v.parse().map_err(|_| "--s2v_lambda")?;
    }
    if let Some(v) = args.get("s2v_fwhm") {
        options.s2v_fwhm = v.parse().map_err(|_| "--s2v_fwhm")?;
    }
    if let Some(v) = args.get("coarse_fwhm") {
        options.coarse_fwhm = if v.is_empty() || v == "none" {
            Vec::new()
        } else {
            v.split(',')
                .map(|x| x.parse::<f64>().map_err(|_| "--coarse_fwhm".to_string()))
                .collect::<Result<_, _>>()?
        };
    }
    if let Some(v) = args.get("linear_iterations") {
        options.linear_iterations = v.parse().map_err(|_| "--linear_iterations")?;
    }
    options.interpolation = match args.get("interp").map(String::as_str) {
        None | Some("spline") => crate::Interpolation::Spline,
        Some("trilinear") => crate::Interpolation::Trilinear,
        Some(o) => return Err(format!("--interp={o} is not supported")),
    };
    if let Some(v) = args.get("slm_power") {
        options.slm_power = v.parse().map_err(|_| "--slm_power")?;
    }
    if let Some(v) = args.get("gn_tol") {
        options.gn_tolerance = v.parse().map_err(|_| "--gn_tol")?;
    }
    if let Some(v) = args.get("gn_steps") {
        options.gauss_newton_steps = v.parse().map_err(|_| "--gn_steps")?;
    }
    log(format!(
        "{nv} volumes, grid {dims:?}, voxel {:?} mm, field {}, {} threads",
        grid.voxel_size,
        if field_hz.is_some() { "yes" } else { "no" },
        rayon::current_num_threads()
    ));

    let input = Input {
        grid,
        volumes,
        bvals,
        // Along the voxel axes: FSL reverses x for a positive-determinant affine.
        bvecs: bvecs
            .iter()
            .map(|g| if flip { [-g[0], g[1], g[2]] } else { *g })
            .collect(),
        mask,
        acquisitions,
        field_hz,
        slice_times: slice_times(&*files, args, dims[2])?,
        slice_groups: slice_groups(&*files, args, dims[2])?,
    };
    let result = crate::run(&input, &options, &mut |line| log(line))?;

    let corrected: Vec<&[f32]> = result.corrected.iter().map(|v| v.as_slice()).collect();
    let path = format!("{out}.nii.gz");
    let bytes = nifti::encode_series(
        &path,
        &image,
        &[dims[0], dims[1], dims[2], corrected.len()],
        &corrected,
    )?;
    drop(corrected);
    drop(result.corrected);
    files.write(&path, bytes)?;
    // One row per output volume (a restored pair takes its first volume's direction).
    let all = crate::rotate_bvecs(&bvecs, &result.params, flip);
    let rotated: Vec<[f64; 3]> = result.sources.iter().map(|s| all[s[0]]).collect();
    let out_bvals: Vec<String> = result
        .sources
        .iter()
        .map(|s| format!("{}", bvals_in[s[0]]))
        .collect();
    write(
        files,
        &format!("{out}.bvals"),
        &(out_bvals.join(" ") + "\n"),
    )?;
    let mut s = String::new();
    for c in 0..3 {
        let row: Vec<String> = rotated.iter().map(|g| format!("{:.6}", g[c])).collect();
        s += &row.join(" ");
        s += "\n";
    }
    write(files, &format!("{out}.rotated_bvecs"), &s)?;
    let mut s = String::new();
    // Every row as long as the longest (b0 volumes: eddy-current terms 0), as eddy's.
    let width = result.params.iter().map(|p| p.ec.len()).max().unwrap_or(0);
    for p in &result.params {
        let mut row: Vec<String> = p
            .rigid
            .translation
            .iter()
            .chain(&p.rigid.rotation)
            .map(|x| format!("{x:.6}"))
            .collect();
        row.extend(p.ec.iter().map(|x| format!("{x:.6}")));
        row.resize(6 + width, format!("{:.6}", 0.0));
        s += &row.join(" ");
        s += "\n";
    }
    write(files, &format!("{out}.parameters"), &s)?;
    let s: String = result
        .movement_rms
        .iter()
        .map(|r| format!("{:.6} {:.6}\n", r[0], r[1]))
        .collect();
    write(files, &format!("{out}.movement_rms"), &s)?;
    if let Some(map) = &result.outliers {
        let rows = |m: &Vec<Vec<f64>>| -> String {
            m.iter()
                .map(|r| {
                    r.iter()
                        .map(|x| {
                            // As eddy's: 0 for b0 volumes and slices without a statistic.
                            if x.is_finite() {
                                format!("{x:.4}")
                            } else {
                                "0".into()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                        + "\n"
                })
                .collect()
        };
        // eddy's header lines, which tools reading its maps skip.
        let map_header = "One row per scan, one column per slice. Outlier: 1, Non-outlier: 0\n";
        let stdev_header = "One row per scan, one column per slice. b0s set to zero\n";
        let o: String = std::iter::once(map_header.to_string())
            .chain(map.outlier.iter().map(|r| {
                r.iter()
                    .map(|&b| if b { "1" } else { "0" })
                    .collect::<Vec<_>>()
                    .join(" ")
                    + "\n"
            }))
            .collect();
        write(files, &format!("{out}.outlier_map"), &o)?;
        write(
            files,
            &format!("{out}.outlier_n_stdev_map"),
            &(stdev_header.to_string() + &rows(&map.n_stdev)),
        )?;
        write(
            files,
            &format!("{out}.outlier_n_sqr_stdev_map"),
            &(stdev_header.to_string() + &rows(&map.n_sqr_stdev)),
        )?;
        write(
            files,
            &format!("{out}.outlier_report"),
            &(map.report().join("\n") + "\n"),
        )?;
    }
    log("done".into());
    Ok(())
}

/// A field map (Hz) on another grid, sampled on the series' grid (trilinear; 0 Hz outside
/// it). As eddy's `--field_mat`, the matrix maps the field's FSL coordinates (voxel × voxel
/// size, x reversed when the affine's determinant is positive) to the series'; without it
/// they are the same.
fn field_on_series(
    field: &nifti::Image,
    series: &nifti::Image,
    dims: [usize; 3],
    matrix: Option<[[f64; 4]; 4]>,
) -> Result<Vec<f32>, String> {
    let field_dims = [field.dims[0], field.dims[1], field.dims[2]];
    let volume = field_dims.iter().product::<usize>();
    if field.data.len() < volume {
        return Err("--field: the image is shorter than its dimensions.".into());
    }
    let to_fsl = |image: &nifti::Image, d: [usize; 3], v: [f64; 3]| -> [f64; 3] {
        let flip = dwi_pe_field::fsl_flips_x(&image.affine);
        let x = if flip { d[0] as f64 - 1.0 - v[0] } else { v[0] };
        [
            x * image.pixdim[0],
            v[1] * image.pixdim[1],
            v[2] * image.pixdim[2],
        ]
    };
    let field_flip = dwi_pe_field::fsl_flips_x(&field.affine);
    // Series FSL coordinates to field FSL coordinates: the inverse of the matrix.
    let m = matrix.unwrap_or([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let a: [[f64; 3]; 3] = std::array::from_fn(|i| [m[i][0], m[i][1], m[i][2]]);
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if det.abs() < 1e-12 {
        return Err("--field_mat is singular.".into());
    }
    let inv: [[f64; 3]; 3] = std::array::from_fn(|i| {
        std::array::from_fn(|j| {
            let (r0, r1) = ((j + 1) % 3, (j + 2) % 3);
            let (c0, c1) = ((i + 1) % 3, (i + 2) % 3);
            (a[r0][c0] * a[r1][c1] - a[r0][c1] * a[r1][c0]) / det
        })
    });
    let grid = crate::volume::Grid {
        dims: field_dims,
        voxel_size: field.pixdim,
    };
    let [nx, ny, _] = dims;
    Ok((0..dims.iter().product::<usize>())
        .map(|v| {
            let ijk = [v % nx, (v / nx) % ny, v / (nx * ny)].map(|c| c as f64);
            let p = to_fsl(series, dims, ijk);
            let d: [f64; 3] = std::array::from_fn(|i| p[i] - m[i][3]);
            let q: [f64; 3] =
                std::array::from_fn(|i| inv[i][0] * d[0] + inv[i][1] * d[1] + inv[i][2] * d[2]);
            let mut x: [f64; 3] = std::array::from_fn(|i| q[i] / field.pixdim[i]);
            if field_flip {
                x[0] = field_dims[0] as f64 - 1.0 - x[0];
            }
            grid.trilinear(&field.data[..volume], x).unwrap_or(0.0) as f32
        })
        .collect())
}

/// eddy's options that change nothing here (with why), and those this tool does not have.
const IGNORED: [(&str, &str); 15] = [
    ("data_is_shelled", "shells are found from the b-values"),
    ("sep_offs_move", "on by default"),
    ("verbose", "progress is always logged"),
    ("very_verbose", "progress is always logged"),
    ("v", "progress is always logged"),
    ("nvoxhp", "the hyperparameters are fitted on 1500 voxels"),
    ("initrand", "the hyperparameter voxels are fixed"),
    ("hypar", "the hyperparameters are fitted"),
    ("wss", "the hyperparameters are fitted by cross-validation"),
    ("cnr_maps", "not written"),
    ("residuals", "not written"),
    ("write_slice_stats", "not written"),
    ("write_predictions", "not written"),
    ("dfields", "not written"),
    ("fields", "not written"),
];
const UNSUPPORTED: [(&str, &str); 3] = [
    ("b0_only", "every volume is corrected"),
    ("fep", "empty planes are not filled"),
    ("rep_noise", "outliers are replaced by the prediction"),
];

/// Refuses options this tool does not know, so that an eddy command line never runs with an
/// option silently dropped; logs eddy's options that change nothing here.
fn check_flags(args: &HashMap<String, String>) -> Result<Vec<String>, String> {
    const KNOWN: &[&str] = &[
        "imain",
        "mask",
        "acqp",
        "index",
        "bvecs",
        "bvals",
        "out",
        "topup",
        "field",
        "field_mat",
        "niter",
        "fwhm",
        "flm",
        "slm",
        "repol",
        "ol_nstd",
        "ol_nvox",
        "ol_standardise",
        "ol_pos",
        "ol_sqr",
        "ol_type",
        "mb",
        "mb_offs",
        "dont_sep_offs_move",
        "dont_peas",
        "dont_anchor_shells",
        "dont_detrend_offset",
        "linear_iterations",
        "coarse_fwhm",
        "model",
        "resamp",
        "lsr_lambda",
        "mporder",
        "slspec",
        "json",
        "s2v_niter",
        "s2v_lambda",
        "s2v_fwhm",
        "s2v_interp",
        "estimate_move_by_susceptibility",
        "mbs_niter",
        "mbs_lambda",
        "mbs_ksp",
        "slm_power",
        "ff",
        "interp",
        "gn_steps",
        "gn_tol",
        "nthr",
        "robust",
        "dont_initial_repol",
        "dont_coarse_repol",
        "global_b0",
        "rotate_gradients",
        "first_ec_only",
        "self_weight",
        "self_weight_from",
        "dont_mask_output",
        "ref_scan_no",
        "b0_flm",
        "b0_slm",
    ];
    let mut notes = Vec::new();
    let mut keys: Vec<&String> = args.keys().collect();
    keys.sort();
    for key in keys {
        if let Some((_, why)) = IGNORED.iter().find(|(k, _)| k == key) {
            notes.push(format!("--{key} ignored: {why}"));
        } else if let Some((_, why)) = UNSUPPORTED.iter().find(|(k, _)| k == key) {
            return Err(format!("--{key} is not supported: {why}."));
        } else if !KNOWN.contains(&key.as_str()) {
            return Err(format!("unknown option --{key}\n{USAGE}"));
        }
    }
    if args.get("ref_scan_no").is_some_and(|v| v != "0") {
        return Err("--ref_scan_no: the reference is always the first b0 volume.".into());
    }
    for key in ["b0_flm", "b0_slm"] {
        if args
            .get(key)
            .is_some_and(|v| v != "movement" && v != "none")
        {
            return Err(format!(
                "--{key}: b0 volumes are corrected for movement only."
            ));
        }
    }
    if args.get("mb_offs").is_some_and(|v| v != "0") {
        return Err("--mb_offs: give the slice groups with --slspec instead.".into());
    }
    if args
        .get("s2v_interp")
        .is_some_and(|v| v != "trilinear" && v != "spline")
    {
        return Err("--s2v_interp: expected trilinear or spline.".into());
    }
    Ok(notes)
}

/// The multiband groups: slices with the same time in `--slspec`/`--json`, or with `--mb=N`
/// slice k and the slices n/N, 2n/N, ... after it (eddy's convention).
fn slice_groups(
    files: &dyn Files,
    args: &HashMap<String, String>,
    slices: usize,
) -> Result<Option<Vec<Vec<usize>>>, String> {
    if let Some(mb) = args.get("mb") {
        let mb: usize = mb.parse().map_err(|_| "--mb")?;
        if mb == 0 || slices % mb != 0 {
            return Err(format!("--mb={mb} does not divide the {slices} slices"));
        }
        let per = slices / mb;
        return Ok(Some(
            (0..per)
                .map(|k| (0..mb).map(|j| k + j * per).collect())
                .collect(),
        ));
    }
    let Some(times) = slice_times(files, args, slices)? else {
        return Ok(None);
    };
    let mut groups: Vec<(f64, Vec<usize>)> = Vec::new();
    for (s, &t) in times.iter().enumerate() {
        match groups.iter_mut().find(|g| g.0 == t) {
            Some(g) => g.1.push(s),
            None => groups.push((t, vec![s])),
        }
    }
    Ok(Some(groups.into_iter().map(|g| g.1).collect()))
}

/// Slice acquisition times (0..1 within a volume) for `slices` slices: from an slspec file
/// (one row per slice group, in acquisition order) or the `SliceTiming` of a BIDS sidecar.
fn slice_times(
    files: &dyn Files,
    args: &HashMap<String, String>,
    slices: usize,
) -> Result<Option<Vec<f64>>, String> {
    if let Some(path) = args.get("slspec") {
        let groups = numbers(files, path)?;
        let mut times = vec![f64::NAN; slices];
        for (g, row) in groups.iter().enumerate() {
            for &sl in row {
                let sl = sl as usize;
                if sl >= slices {
                    return Err(format!("{path}: slice {sl} is outside the {slices} slices"));
                }
                times[sl] = g as f64 / groups.len() as f64;
            }
        }
        if times.iter().any(|t| t.is_nan()) {
            return Err(format!("{path} does not list every slice"));
        }
        return Ok(Some(times));
    }
    if let Some(path) = args.get("json") {
        let json = text(files, path)?;
        let key = json
            .find("\"SliceTiming\"")
            .ok_or_else(|| format!("{path} has no SliceTiming"))?;
        let open = json[key..]
            .find('[')
            .ok_or_else(|| format!("{path}: SliceTiming is not a list"))?
            + key;
        let close = json[open..]
            .find(']')
            .ok_or_else(|| format!("{path}: SliceTiming is not a list"))?
            + open;
        let t: Vec<f64> = json[open + 1..close]
            .split(',')
            .map(|v| {
                v.trim()
                    .parse::<f64>()
                    .map_err(|_| format!("{path}: '{v}' in SliceTiming is not a number"))
            })
            .collect::<Result<_, _>>()?;
        if t.len() != slices {
            return Err(format!(
                "{path}: SliceTiming has {} entries for {slices} slices",
                t.len()
            ));
        }
        // Scale by the volume's duration: the last slice time plus the smallest gap.
        let mut distinct = t.clone();
        distinct.sort_by(f64::total_cmp);
        distinct.dedup();
        let gap = distinct
            .windows(2)
            .map(|w| w[1] - w[0])
            .fold(f64::INFINITY, f64::min);
        let duration =
            distinct.last().copied().unwrap_or(0.0) + if gap.is_finite() { gap } else { 1.0 };
        return Ok(Some(
            t.iter().map(|&x| (x - distinct[0]) / duration).collect(),
        ));
    }
    Ok(None)
}

fn write(files: &mut dyn Files, path: &str, s: &str) -> Result<(), String> {
    files.write(path, s.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Memory(HashMap<String, Vec<u8>>);

    impl Files for Memory {
        fn read(&self, path: &str) -> Result<Vec<u8>, String> {
            self.0
                .get(path)
                .cloned()
                .ok_or_else(|| format!("{path}: no such file"))
        }

        fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), String> {
            self.0.insert(path.to_string(), bytes);
            Ok(())
        }
    }

    /// A 4 × 4 × 4 series of four volumes with its mask, acqp and index, and the gradient
    /// files given.
    fn inputs(bvals: &str, bvecs: &str) -> Memory {
        let mut header = vec![0u8; 348];
        header[0..4].copy_from_slice(&348i32.to_le_bytes());
        for (i, p) in [1.0f32, 2.0, 2.0, 2.0].iter().enumerate() {
            header[76 + 4 * i..80 + 4 * i].copy_from_slice(&p.to_le_bytes());
        }
        header[344..348].copy_from_slice(b"n+1\0");
        let like = nifti::Image {
            header,
            dims: vec![4, 4, 4],
            pixdim: [2.0; 3],
            affine: [[0.0; 4]; 4],
            intent_code: 0,
            data: Vec::new(),
        };
        let volume = vec![100.0f32; 64];
        let series = [volume.as_slice(); 4];
        let mut files = Memory::default();
        let mut add = |name: &str, bytes: Vec<u8>| files.0.insert(name.to_string(), bytes);
        add(
            "dwi.nii",
            nifti::encode_series("dwi.nii", &like, &[4, 4, 4, 4], &series).unwrap(),
        );
        add(
            "mask.nii",
            nifti::encode_series("mask.nii", &like, &[4, 4, 4], &[&[1.0; 64]]).unwrap(),
        );
        add("acqp", b"0 1 0 0.05\n".to_vec());
        add("index", b"1 1 1 1\n".to_vec());
        add("bvals", bvals.as_bytes().to_vec());
        add("bvecs", bvecs.as_bytes().to_vec());
        files
    }

    #[test]
    fn bvecs_in_either_orientation() {
        let fsl = vec![vec![1.0, 0.0], vec![0.0, 1.0], vec![0.0, 0.0]];
        let rows = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]];
        let expected = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        assert_eq!(directions(&fsl, 2, "bvecs").unwrap(), expected);
        assert_eq!(directions(&rows, 2, "bvecs").unwrap(), expected);
    }

    #[test]
    fn malformed_bvecs_are_refused() {
        // Three rows of unequal length, and N rows of two values: an error, not a panic.
        let short = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0], vec![0.0, 0.0, 1.0]];
        let error = directions(&short, 3, "bvecs").unwrap_err();
        assert!(error.contains("expected 3 rows of 3"), "{error}");
        let pairs = vec![vec![1.0, 0.0]; 20];
        let error = directions(&pairs, 20, "bvecs").unwrap_err();
        assert!(error.contains("20 rows of 2"), "{error}");
        assert!(directions(&[], 4, "bvecs").is_err());
    }

    #[test]
    fn malformed_gradient_files_are_input_errors() {
        let bvals = "0 1000 1000 1000\n";
        let fsl = "0 1 0 0\n0 0 1 0\n0 0 0 1\n";
        let expected_table = "bvecs: expected 3 rows of 4 directions (or 4 rows of 3)";
        for (bvals, bvecs, expected) in [
            (bvals, "0 1 0 0\n0 0 1\n0 0 0 1\n", expected_table),
            (bvals, "0 0 0\n1 0 0\n0 1\n0 0 1\n", expected_table),
            (
                bvals,
                "0 0 0 0\n1 0 0 0\n0 1 0 0\n0 0 1 0\n",
                expected_table,
            ),
            (bvals, "0 1 0 0\n0 0 1 0\n", expected_table),
            (
                bvals,
                "0 1 0 0\n0 0 nan 0\n0 0 0 1\n",
                "bvecs: 'nan' is not a number",
            ),
            ("0 1000 inf 1000\n", fsl, "bvals: 'inf' is not a number"),
        ] {
            let mut files = inputs(bvals, bvecs);
            let argv: Vec<String> = [
                "--imain=dwi.nii",
                "--mask=mask.nii",
                "--acqp=acqp",
                "--index=index",
                "--bvecs=bvecs",
                "--bvals=bvals",
                "--out=out",
            ]
            .map(String::from)
            .to_vec();
            let error = run(&argv, &mut files, &mut |_| {}).unwrap_err();
            assert!(error.starts_with(expected), "{bvecs:?}: {error}");
            assert!(files.0.contains_key("out.log"), "{bvecs:?}: no log");
        }
    }
}
