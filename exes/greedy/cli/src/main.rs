use std::{env, fs, path::Path};

use greedy_rs_core::{
    AffineMetric, Mat4, ScalarType, Transform, build_pyramid, decode_image, decode_vector_field,
    encode_image, encode_vector_field, image_centers, nmi_score_gradient_affine, read_matrix,
    register_affine, register_nmi_svf, reslice, score_affine, ssd_score_gradient,
};

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("greedy-rs: {message}");
    std::process::exit(2)
}

fn take(args: &[String], at: &mut usize, flag: &str) -> String {
    *at += 1;
    args.get(*at)
        .cloned()
        .unwrap_or_else(|| fail(format!("{flag} requires an argument")))
}

fn read(path: &str) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| fail(format!("{path}: {e}")))
}

fn transform(path: &str) -> Transform {
    if Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mat"))
    {
        Transform::Affine(
            read_matrix(&fs::read_to_string(path).unwrap_or_else(|e| fail(format!("{path}: {e}"))))
                .unwrap_or_else(|e| fail(e)),
        )
    } else {
        Transform::Warp(decode_vector_field(&read(path)).unwrap_or_else(|e| fail(e)))
    }
}

fn iterations(value: &str) -> [usize; 3] {
    let values = value
        .split('x')
        .map(str::parse::<usize>)
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|_| fail("-n must be three x-separated integers"));
    values
        .try_into()
        .unwrap_or_else(|_| fail("-n must contain exactly three levels"))
}

fn run_affine(args: &[String]) {
    let mut fixed = None;
    let mut moving = None;
    let mut output = None;
    let mut metric = AffineMetric::Ssd;
    let mut levels = [100, 50, 10];
    let mut dump_pyramid = false;
    let mut dump_prefix = String::new();
    let mut verbose = true;
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "-a" | "-ia-image-centers" | "-float" => {}
            "-dump-pyramid" => dump_pyramid = true,
            "-dump-prefix" => dump_prefix = take(args, &mut at, "-dump-prefix"),
            "-d" => {
                if take(args, &mut at, "-d") != "3" {
                    fail("only -d 3 is supported");
                }
            }
            "-V" => verbose = take(args, &mut at, "-V") != "0",
            "-m" => {
                metric = match take(args, &mut at, "-m").to_ascii_uppercase().as_str() {
                    "SSD" => AffineMetric::Ssd,
                    "NMI" => AffineMetric::Nmi,
                    value => fail(format!(
                        "unsupported affine metric {value}; expected SSD or NMI"
                    )),
                }
            }
            "-i" => {
                fixed = Some(take(args, &mut at, "-i"));
                moving = Some(take(args, &mut at, "-i"));
            }
            "-o" => output = Some(take(args, &mut at, "-o")),
            "-n" => levels = iterations(&take(args, &mut at, "-n")),
            flag => fail(format!("unsupported affine option {flag}")),
        }
        at += 1;
    }
    let fixed =
        decode_image(&read(&fixed.unwrap_or_else(|| {
            fail("affine registration requires -i FIXED MOVING")
        })))
        .unwrap_or_else(|e| fail(e));
    let moving =
        decode_image(&read(&moving.unwrap_or_else(|| {
            fail("affine registration requires -i FIXED MOVING")
        })))
        .unwrap_or_else(|e| fail(e));
    if dump_pyramid {
        for (name, image) in [("fixed", &fixed), ("moving", &moving)] {
            for (level, mut output) in build_pyramid(image.clone())
                .unwrap_or_else(|e| fail(e))
                .into_iter()
                .enumerate()
            {
                output.scalar_type = ScalarType::F32;
                let path = format!("{dump_prefix}dump_pyramid_group_00_{name}_{level:02}.nii.gz");
                fs::write(
                    &path,
                    encode_image(&output, true).unwrap_or_else(|e| fail(e)),
                )
                .unwrap_or_else(|e| fail(format!("{path}: {e}")));
            }
        }
    }
    let matrix =
        register_affine(fixed, moving, metric, levels, verbose).unwrap_or_else(|e| fail(e));
    let mut text = String::new();
    for row in matrix.0 {
        text.push_str(&format!("{} {} {} {}\n", row[0], row[1], row[2], row[3]));
    }
    let output = output.unwrap_or_else(|| fail("affine registration requires -o OUTPUT.mat"));
    fs::write(&output, text).unwrap_or_else(|e| fail(format!("{output}: {e}")));
}

fn run_deform(args: &[String]) {
    let mut fixed = None;
    let mut moving = None;
    let mut initial = None;
    let mut output = None;
    let mut levels = [100, 50, 10];
    let mut stationary = false;
    let mut verbose = true;
    let mut dump_moving = false;
    let mut dump_prefix = String::new();
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "-sv" => stationary = true,
            "-dump-moving" => dump_moving = true,
            "-dump-freq" | "-dump-frequency" => {
                take(args, &mut at, "-dump-freq");
            }
            "-dump-prefix" => dump_prefix = take(args, &mut at, "-dump-prefix"),
            "-float" => {}
            "-d" => {
                if take(args, &mut at, "-d") != "3" {
                    fail("only -d 3 is supported");
                }
            }
            "-V" => verbose = take(args, &mut at, "-V") != "0",
            "-m" => {
                if !take(args, &mut at, "-m").eq_ignore_ascii_case("NMI") {
                    fail("SV registration currently supports -m NMI only");
                }
            }
            "-i" => {
                fixed = Some(take(args, &mut at, "-i"));
                moving = Some(take(args, &mut at, "-i"));
            }
            "-it" => initial = Some(take(args, &mut at, "-it")),
            "-o" => output = Some(take(args, &mut at, "-o")),
            "-n" => levels = iterations(&take(args, &mut at, "-n")),
            flag => fail(format!("unsupported SV registration option {flag}")),
        }
        at += 1;
    }
    if !stationary {
        fail("deformable registration requires -sv");
    }
    let fixed = decode_image(&read(
        &fixed.unwrap_or_else(|| fail("SV registration requires -i FIXED MOVING")),
    ))
    .unwrap_or_else(|e| fail(e));
    let moving = decode_image(&read(
        &moving.unwrap_or_else(|| fail("SV registration requires -i FIXED MOVING")),
    ))
    .unwrap_or_else(|e| fail(e));
    let moving = if let Some(initial) = initial {
        reslice(&fixed.grid, &moving, &[transform(&initial)], None).unwrap_or_else(|e| fail(e))
    } else {
        moving
    };
    // Dumps mirror greedy -dump-moving: raw voxel-unit fields, one scalar
    // NIfTI per component, for stage-by-stage comparison.
    let dump = |name: &str, field: &greedy_rs_core::VectorField| {
        if !dump_moving {
            return;
        }
        for (axis, suffix) in ["x", "y", "z"].into_iter().enumerate() {
            let image = greedy_rs_core::NiftiImage {
                grid: field.grid.clone(),
                data: field.data.iter().map(|v| v[axis]).collect(),
                scalar_type: ScalarType::F32,
            };
            let path = format!("{dump_prefix}dump_{name}_{suffix}.nii.gz");
            fs::write(
                &path,
                encode_image(&image, true).unwrap_or_else(|e| fail(e)),
            )
            .unwrap_or_else(|e| fail(format!("{path}: {e}")));
        }
    };
    let warp = register_nmi_svf(fixed, moving, levels, verbose, dump).unwrap_or_else(|e| fail(e));
    let output = output.unwrap_or_else(|| fail("SV registration requires -o OUTPUT.nii.gz"));
    fs::write(
        &output,
        encode_vector_field(&warp, output.ends_with(".gz")).unwrap_or_else(|e| fail(e)),
    )
    .unwrap_or_else(|e| fail(format!("{output}: {e}")));
}

/// A small compatibility diagnostic for comparing a single affine objective
/// value against `greedy -metric`; it deliberately accepts only one `.mat`.
fn run_metric(args: &[String]) {
    let mut fixed = None;
    let mut moving = None;
    let mut initial = None;
    let mut pyramid_level = None;
    let mut print_gradient = false;
    let mut image_centres = false;
    let mut metric = AffineMetric::Ssd;
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "-metric" => {}
            "--gradient" => print_gradient = true,
            "-ia-image-centers" => image_centres = true,
            "-V" => {
                take(args, &mut at, "-V");
            }
            "-d" => {
                if take(args, &mut at, "-d") != "3" {
                    fail("only -d 3 is supported");
                }
            }
            "-m" => {
                metric = match take(args, &mut at, "-m").to_ascii_uppercase().as_str() {
                    "SSD" => AffineMetric::Ssd,
                    "NMI" => AffineMetric::Nmi,
                    value => fail(format!("unsupported metric {value}; expected SSD or NMI")),
                }
            }
            "-i" => {
                fixed = Some(take(args, &mut at, "-i"));
                moving = Some(take(args, &mut at, "-i"));
            }
            "-it" => initial = Some(take(args, &mut at, "-it")),
            "--pyramid-level" => {
                pyramid_level = Some(
                    take(args, &mut at, "--pyramid-level")
                        .parse::<usize>()
                        .ok()
                        .filter(|&level| level < 3)
                        .unwrap_or_else(|| fail("--pyramid-level must be 0, 1, or 2")),
                );
            }
            flag => fail(format!("unsupported metric option {flag}")),
        }
        at += 1;
    }
    let fixed = decode_image(&read(
        &fixed.unwrap_or_else(|| fail("metric requires -i FIXED MOVING")),
    ))
    .unwrap_or_else(|e| fail(e));
    let moving = decode_image(&read(
        &moving.unwrap_or_else(|| fail("metric requires -i FIXED MOVING")),
    ))
    .unwrap_or_else(|e| fail(e));
    let (fixed, moving) = if let Some(level) = pyramid_level {
        (
            build_pyramid(fixed.clone()).unwrap_or_else(|e| fail(e))[level].clone(),
            build_pyramid(moving.clone()).unwrap_or_else(|e| fail(e))[level].clone(),
        )
    } else {
        (fixed, moving)
    };
    let matrix = initial
        .map(|path| {
            read_matrix(&fs::read_to_string(&path).unwrap_or_else(|e| fail(format!("{path}: {e}"))))
                .unwrap_or_else(|e| fail(e))
        })
        .unwrap_or_else(|| {
            if image_centres {
                image_centers(&fixed.grid, &moving.grid)
            } else {
                Mat4::IDENTITY
            }
        });
    let value = score_affine(&fixed, &moving, matrix, metric).unwrap_or_else(|e| fail(e));
    println!(
        "Matrix: {:?}\nMetric Report:\n  Component 0: {value:.12}  Total = {value:.12}",
        matrix.0
    );
    if print_gradient {
        let (value, gradient) = match metric {
            AffineMetric::Ssd => ssd_score_gradient(&fixed, &moving, matrix),
            AffineMetric::Nmi => nmi_score_gradient_affine(&fixed, &moving, matrix),
        }
        .unwrap_or_else(|e| fail(e));
        let scale = [
            1.0,
            fixed.grid.dims[0] as f64,
            fixed.grid.dims[1] as f64,
            fixed.grid.dims[2] as f64,
        ];
        let gradient: [f64; 12] = std::array::from_fn(|index| {
            let value = if metric == AffineMetric::Nmi {
                -10_000.0 * gradient[index]
            } else {
                gradient[index]
            };
            value / scale[index % 4]
        });
        let cost = if metric == AffineMetric::Nmi {
            -10_000.0 * value
        } else {
            value
        };
        let norm = gradient
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt();
        println!(
            "Optimizer cost: {cost:.6}\nScaled gradient: {gradient:?}\nGradient norm: {norm:.6}"
        );
    }
}

fn main() {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    // Greedy's randomness (-seed, affine -jitter) has no Rust equivalent, so
    // only the deterministic settings are accepted; -double would double
    // image memory for no measured benefit.
    if let Some(at) = args.iter().position(|arg| arg == "-jitter") {
        if args.get(at + 1).map(String::as_str) != Some("0") {
            fail("only -jitter 0 is supported");
        }
        args.drain(at..at + 2);
    }
    if let Some(at) = args.iter().position(|arg| arg == "-threads") {
        let threads = args.get(at + 1).and_then(|value| value.parse().ok());
        greedy_rs_core::set_threads(
            threads.unwrap_or_else(|| fail("-threads requires an integer")),
        )
        .unwrap_or_else(|e| fail(e));
        args.drain(at..at + 2);
    }
    if args.iter().any(|arg| arg == "-seed") {
        fail("-seed is not supported; greedy-rs is deterministic");
    }
    if args.iter().any(|arg| arg == "-double") {
        fail("-double is not supported; images are always f32 with f64 reductions");
    }
    if args
        .iter()
        .any(|arg| arg == "--version" || arg == "-version")
    {
        println!("greedy-rs {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|arg| arg == "-metric") {
        run_metric(&args);
        return;
    }
    if args.iter().any(|arg| arg == "-a") {
        run_affine(&args);
        return;
    }
    if args.iter().any(|arg| arg == "-sv") {
        run_deform(&args);
        return;
    }
    let (mut fixed, mut reslices, mut verify, mut chain) = (None, Vec::new(), None, Vec::new());
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "-d" => {
                if take(&args, &mut at, "-d") != "3" {
                    fail("only -d 3 is supported");
                }
            }
            "-V" => {
                take(&args, &mut at, "-V");
            }
            "-float" => {}
            "-rf" => fixed = Some(take(&args, &mut at, "-rf")),
            "-rm" => {
                let moving = take(&args, &mut at, "-rm");
                let output = take(&args, &mut at, "-rm");
                reslices.push((moving, output));
            }
            "--verify-aligned" => verify = Some(take(&args, &mut at, "--verify-aligned")),
            "-r" => {
                at += 1;
                chain.extend(args[at..].iter().map(|s| transform(s)));
                break;
            }
            flag => fail(format!("unsupported reslice option {flag}")),
        }
        at += 1;
    }
    let fixed = fixed.unwrap_or_else(|| fail("reslice requires -rf FIXED"));
    if reslices.is_empty() {
        fail("reslice requires one or more -rm MOVING OUTPUT pairs");
    }
    if chain.is_empty() {
        fail("reslice requires -r followed by a transform chain");
    }
    let fixed = decode_image(&read(&fixed)).unwrap_or_else(|e| fail(e));
    let expected = verify
        .as_deref()
        .map(|path| decode_image(&read(path)).unwrap_or_else(|e| fail(e)));
    for (moving_path, output_path) in reslices {
        let moving = decode_image(&read(&moving_path)).unwrap_or_else(|e| fail(e));
        let output = reslice(
            &fixed.grid,
            &moving,
            &chain,
            expected.as_ref().map(|image| &image.grid),
        )
        .unwrap_or_else(|e| fail(e));
        fs::write(
            &output_path,
            encode_image(&output, output_path.ends_with(".gz")).unwrap_or_else(|e| fail(e)),
        )
        .unwrap_or_else(|e| fail(format!("{output_path}: {e}")));
    }
}
