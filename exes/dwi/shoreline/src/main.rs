// SPDX-License-Identifier: Apache-2.0
//! `shoreline`: head motion, eddy-current, susceptibility and slice outlier correction of a
//! diffusion series (see the library documentation). The options follow FSL eddy's names
//! where they mean the same thing, so that existing scripts translate directly.

use std::io::Write;

use dwi_ec_distortion::{Model, SecondLevel};
use dwi_pe_field::{PhaseEncoding, TopupCoefficients};
use dwi_shoreline::volume::Grid;
use dwi_shoreline::{Acquisition, Input, Options, nifti};

const USAGE: &str = "usage: shoreline --imain=DWI --mask=MASK --acqp=FILE --index=FILE --bvecs=FILE --bvals=FILE --out=BASE
  [--topup=BASE | --field=HZ.nii.gz [--field_mat=FLIRT.mat]] [--niter=5] [--fwhm=0[,..]] [--flm=quadratic|linear|movement]
  [--slm=linear|quadratic|none] [--repol] [--ol_nstd=4] [--ol_nvox=250] [--ol_type=sw|gw|both [--mb=N]] [--ol_pos] [--ol_sqr] [--ol_standardise=slice|shell] [--dont_sep_offs_move]
  [--dont_peas] [--dont_anchor_shells] [--dont_detrend_offset] [--linear_iterations=1] [--coarse_fwhm=8,4|none] [--model=auto|shore|gp] [--resamp=jac|lsr] [--mporder=N --slspec=FILE|--json=FILE [--s2v_niter=5] [--s2v_lambda=1]] [--estimate_move_by_susceptibility [--mbs_lambda=100] [--mbs_ksp=10]] [--lsr_lambda=0.01] [--ff=N] [--interp=spline|trilinear] [--gn_steps=2] [--gn_tol=0.05] [--dont_mask_output] [--nthr=N]";

fn main() {
    if let Err(e) = run() {
        eprintln!("shoreline: {e}");
        std::process::exit(1);
    }
}

fn text(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

fn numbers(path: &str) -> Result<Vec<Vec<f64>>, String> {
    text(path)?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            l.split_whitespace()
                .map(|v| {
                    v.parse::<f64>()
                        .map_err(|_| format!("{path}: '{v}' is not a number"))
                })
                .collect()
        })
        .collect()
}

fn run() -> Result<(), String> {
    let mut args = std::collections::HashMap::new();
    for a in std::env::args().skip(1) {
        let a = a.trim_start_matches('-').to_string();
        match a.split_once('=') {
            Some((k, v)) => args.insert(k.to_string(), v.to_string()),
            None => args.insert(a, String::new()),
        };
    }
    check_flags(&args)?;
    let get = |k: &str| {
        args.get(k)
            .cloned()
            .ok_or_else(|| format!("--{k} is required\n{USAGE}"))
    };
    let threads: usize = args.get("nthr").and_then(|t| t.parse().ok()).unwrap_or(0);
    if threads > 0 {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()
            .map_err(|e| e.to_string())?;
    }
    let start = std::time::Instant::now();
    let out = get("out")?;
    let mut log_file =
        std::fs::File::create(format!("{out}.log")).map_err(|e| format!("{out}.log: {e}"))?;
    let mut log = |line: String| {
        let line = format!("[{:7.1} s] {line}", start.elapsed().as_secs_f64());
        eprintln!("{line}");
        let _ = writeln!(log_file, "{line}");
    };

    let (image, mut volumes) = nifti::read_series(&get("imain")?)?;
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
    let mask_image = nifti::read(&get("mask")?)?;
    if mask_image.data.len() != n {
        return Err("--mask does not match the series' grid.".into());
    }
    let mask: Vec<bool> = mask_image.data.iter().map(|&m| m > 0.0).collect();
    let bvals: Vec<f64> = numbers(&get("bvals")?)?.concat();
    let bvals_in = bvals.clone();
    let rows = numbers(&get("bvecs")?)?;
    let bvecs: Vec<[f64; 3]> = if rows.len() == 3 {
        (0..rows[0].len())
            .map(|i| [rows[0][i], rows[1][i], rows[2][i]])
            .collect()
    } else {
        rows.iter().map(|r| [r[0], r[1], r[2]]).collect()
    };
    let flip = dwi_pe_field::fsl_flips_x(&image.affine);
    let acqp = text(&get("acqp")?)?;
    let acqp: Vec<&str> = acqp.lines().filter(|l| !l.trim().is_empty()).collect();
    let index: Vec<usize> = numbers(&get("index")?)?
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
    if bvals.len() != nv || bvecs.len() != nv || acquisitions.len() != nv {
        return Err(format!(
            "{nv} volumes, but {} b-values, {} directions, {} indices",
            bvals.len(),
            bvecs.len(),
            index.len()
        ));
    }
    let field_hz = if let Some(base) = args.get("topup") {
        let coef = nifti::read(&format!("{base}_fieldcoef.nii.gz"))?;
        let c = TopupCoefficients::new(
            [coef.dims[0], coef.dims[1], coef.dims[2]],
            coef.pixdim,
            &coef.data,
        )?;
        let hz = c.evaluate(dims, flip)?;
        Some(hz.into_iter().map(|h| h as f32).collect())
    } else if let Some(path) = args.get("field") {
        let f = nifti::read(path)?;
        let matrix = match args.get("field_mat") {
            Some(m) => {
                let rows = numbers(m)?;
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
        None | Some("sw") => dwi_shoreline::OutlierType::Slice,
        Some("gw") => dwi_shoreline::OutlierType::Group,
        Some("both") => dwi_shoreline::OutlierType::Both,
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
        None | Some("jac") => dwi_shoreline::Resampling::Jacobian,
        Some("lsr") => dwi_shoreline::Resampling::LeastSquares,
        Some(o) => return Err(format!("--resamp={o} is not supported")),
    };
    if let Some(v) = args.get("lsr_lambda") {
        options.lsr_lambda = v.parse().map_err(|_| "--lsr_lambda")?;
    }
    options.model = match args.get("model").map(String::as_str) {
        None | Some("auto") => dwi_shoreline::PredictionModel::Auto,
        Some("shore") => dwi_shoreline::PredictionModel::Shore,
        Some("gp") => dwi_shoreline::PredictionModel::GaussianProcess,
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
        None | Some("spline") => dwi_shoreline::Interpolation::Spline,
        Some("trilinear") => dwi_shoreline::Interpolation::Trilinear,
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
        slice_times: slice_times(&args, dims[2])?,
        slice_groups: slice_groups(&args, dims[2])?,
    };
    let result = dwi_shoreline::run(&input, &options, &mut log)?;

    let corrected: Vec<&[f32]> = result.corrected.iter().map(|v| v.as_slice()).collect();
    nifti::write_series(
        &format!("{out}.nii.gz"),
        &image,
        &[dims[0], dims[1], dims[2], corrected.len()],
        &corrected,
    )?;
    // One row per output volume (a restored pair takes its first volume's direction).
    let all = dwi_shoreline::rotate_bvecs(&bvecs, &result.params, flip);
    let rotated: Vec<[f64; 3]> = result.sources.iter().map(|s| all[s[0]]).collect();
    let out_bvals: Vec<String> = result
        .sources
        .iter()
        .map(|s| format!("{}", bvals_in[s[0]]))
        .collect();
    write(&format!("{out}.bvals"), &(out_bvals.join(" ") + "\n"))?;
    let mut s = String::new();
    for c in 0..3 {
        let row: Vec<String> = rotated.iter().map(|g| format!("{:.6}", g[c])).collect();
        s += &row.join(" ");
        s += "\n";
    }
    write(&format!("{out}.rotated_bvecs"), &s)?;
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
    write(&format!("{out}.parameters"), &s)?;
    let s: String = result
        .movement_rms
        .iter()
        .map(|r| format!("{:.6} {:.6}\n", r[0], r[1]))
        .collect();
    write(&format!("{out}.movement_rms"), &s)?;
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
        write(&format!("{out}.outlier_map"), &o)?;
        write(
            &format!("{out}.outlier_n_stdev_map"),
            &(stdev_header.to_string() + &rows(&map.n_stdev)),
        )?;
        write(
            &format!("{out}.outlier_n_sqr_stdev_map"),
            &(stdev_header.to_string() + &rows(&map.n_sqr_stdev)),
        )?;
        write(
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
    let grid = dwi_shoreline::volume::Grid {
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
fn check_flags(args: &std::collections::HashMap<String, String>) -> Result<(), String> {
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
    for key in args.keys() {
        if let Some((_, why)) = IGNORED.iter().find(|(k, _)| k == key) {
            eprintln!("shoreline: --{key} ignored: {why}");
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
    Ok(())
}

/// The multiband groups: slices with the same time in `--slspec`/`--json`, or with `--mb=N`
/// slice k and the slices n/N, 2n/N, ... after it (eddy's convention).
fn slice_groups(
    args: &std::collections::HashMap<String, String>,
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
    let Some(times) = slice_times(args, slices)? else {
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
    args: &std::collections::HashMap<String, String>,
    slices: usize,
) -> Result<Option<Vec<f64>>, String> {
    if let Some(path) = args.get("slspec") {
        let groups = numbers(path)?;
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
        let json = text(path)?;
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

fn write(path: &str, s: &str) -> Result<(), String> {
    std::fs::write(path, s).map_err(|e| format!("{path}: {e}"))
}
