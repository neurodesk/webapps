//! SYNcro's steps, as packages/syncro/src/pipeline.js ran them (55199029d): validate and de-shear the inputs,
//! synthesize a T1 (SynthSR), extract its brain (MindGrab), register it to MNI152 (Greedy or ANTs SyN), then
//! carry the scan, a pathological modality and a lesion map through the same transforms.

#[cfg(feature = "heal")]
mod heal;

use crate::geometry::{
    self, Grid, compatible_mask_geometry, has_shear, orthogonal_grid, same_geometry,
};
use crate::volume::{self, Volume, has_two_values, read, read_binary};
use neurodesk_pipeline_host::record::{self, Recorded};
use neurodesk_pipeline_host::{Host, Step, file_name, join};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Normalization {
    Greedy,
    Ants,
}

/// Where native SynthSR and MindGrab run; the browser drivers choose their own backends and ignore it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Device {
    Auto,
    Cpu,
    Metal,
    Cuda,
}

pub struct Options {
    /// Host paths. The output file names come from these files' names.
    pub input: String,
    pub lesion: Option<String>,
    pub pathological: Option<String>,
    pub template: String,
    pub out: String,
    pub work: String,
    pub ct: bool,
    pub normalization: Normalization,
    pub threads: usize,
    pub device: Device,
    pub keep_synth: bool,
    /// Enantiomorphic healing before SynthSR (experimental; needs the `heal` feature and a lesion).
    pub heal: bool,
    /// The tools' identities (native: path, version, SHA-256); a resume with different software reruns nothing
    /// and fails.
    pub software: Value,
}

/// FWHM 3 mm, as the web app's niimath call.
const LESION_SIGMA: f64 = 3.0 / 2.354820045;
const ITERATIONS: &str = "100x50x10";
const SEED: u32 = 42;

fn split_nifti_name(name: &str) -> Result<(String, String), String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let lower = base.to_ascii_lowercase();
    let ext = if lower.ends_with(".nii.gz") {
        7
    } else if lower.ends_with(".nii") {
        4
    } else {
        return Err("SYNcro inputs must be NIfTI images (.nii or .nii.gz).".into());
    };
    let (stem, extension) = base.split_at(base.len() - ext);
    Ok((stem.to_string(), extension.to_ascii_lowercase()))
}

fn named(prefix: &str, name: &str) -> Result<String, String> {
    let (stem, extension) = split_nifti_name(name)?;
    Ok(format!("{prefix}{stem}{extension}"))
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn read_all<H: Host>(h: &H, path: &str) -> Result<Vec<u8>, String> {
    let (size, _) = h.stat(path).ok_or_else(|| format!("{path}: not found"))?;
    h.read_range(path, 0, size as usize).await
}

/// Write a file the pipeline derives itself, unless it already holds these bytes: an unchanged file keeps its
/// timestamp, so the resume records of the steps that read it stay valid.
async fn put<H: Host>(h: &H, path: &str, bytes: &[u8]) -> Result<(), String> {
    if h.stat(path).is_some_and(|(n, _)| n == bytes.len() as u64)
        && read_all(h, path).await.is_ok_and(|b| b == bytes)
    {
        return Ok(());
    }
    h.write(path, bytes).await
}

fn darkest(data: &[f32]) -> f32 {
    data.iter().copied().fold(f32::INFINITY, f32::min)
}

struct Runner<'a, H: Host> {
    h: &'a H,
    o: &'a Options,
    timings: Map<String, Value>,
    commands: Vec<Value>,
}

impl<H: Host> Runner<'_, H> {
    /// Run one tool step (resumable) and keep its argv and environment for provenance.
    async fn step(
        &mut self,
        argv: Vec<String>,
        env: Vec<(&str, String)>,
        outputs: &[String],
        gpu: bool,
    ) -> Result<(), String> {
        self.step_reading(argv, env, outputs, gpu, &[]).await
    }

    /// `step`, for a tool that also reads files its argv does not name as plain arguments.
    async fn step_reading(
        &mut self,
        argv: Vec<String>,
        env: Vec<(&str, String)>,
        outputs: &[String],
        gpu: bool,
        extra_inputs: &[String],
    ) -> Result<(), String> {
        let env: Vec<(String, String)> = env.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        self.commands.push(json!({"argv": argv, "env": env}));
        let mut settings = Map::new();
        settings.insert("env".into(), json!(env));
        let recorded = Recorded {
            step: Step { argv, env, gpu },
            outputs,
            extra_inputs,
            settings,
            done_marker: None,
        };
        record::run(self.h, &self.o.work, recorded)
            .await
            .map(|_| ())
    }

    fn threads(&self) -> String {
        self.o.threads.to_string()
    }

    fn greedy(&self, rest: &[&str]) -> Vec<String> {
        let mut argv = vec![
            "greedy-rs".to_string(),
            "-threads".into(),
            self.threads(),
            "-d".into(),
            "3".into(),
        ];
        argv.extend(rest.iter().map(|s| s.to_string()));
        argv
    }

    /// niimath picks its output format from FSLOUTPUTTYPE, not the file name.
    fn niimath_env(&self, output: &str) -> Vec<(&'static str, String)> {
        let format = if output.to_ascii_lowercase().ends_with(".gz") {
            "NIFTI_GZ"
        } else {
            "NIFTI"
        };
        vec![
            ("FSLOUTPUTTYPE", format.into()),
            ("OMP_NUM_THREADS", self.threads()),
        ]
    }

    /// `greedy -rf FIXED -rm MOVING OUT -r CHAIN`, linear unless `nearest`, outside voxels `fill`.
    async fn greedy_reslice(
        &mut self,
        fixed: &str,
        moving: &str,
        out: &str,
        chain: &[&str],
        nearest: bool,
        fill: f32,
    ) -> Result<(), String> {
        let mut rest = vec!["-rf", fixed, "-rm", moving, out];
        if nearest {
            rest.extend(["-ri", "NN"]);
        }
        let fill = format!("{fill}");
        if fill != "0" {
            rest.extend(["-rb", &fill]);
        }
        rest.push("-r");
        rest.extend(chain);
        let argv = self.greedy(&rest);
        self.step(argv, vec![], &[out.to_string()], false).await
    }
}

/// Run SYNcro over the host's files and return its provenance. `stage` receives each stage name as it starts
/// (the web app's progress labels).
pub async fn run<H: Host>(h: &H, o: &Options, stage: &dyn Fn(&str)) -> Result<Value, String> {
    let t0 = h.now();
    let input_name = file_name(&o.input).to_string();
    if o.heal {
        if !cfg!(feature = "heal") {
            return Err(
                "This SYNcro was built without enantiomorphic healing (the heal feature).".into(),
            );
        }
        if o.lesion.is_none() {
            return Err("Healing needs a lesion map.".into());
        }
    }
    let compressed_name = |name: &str| name.to_ascii_lowercase().ends_with(".gz");
    let out = |name: &str| join(&o.out, name);
    let work = |name: &str| join(&o.work, name);

    // Output names, as the web app derives them.
    let names_synthetic = named("wbt1", &input_name)?;
    let names_primary = named("w", &input_name)?;
    let names_brain = named("wb", &input_name)?;
    let names_native = named("t1", &input_name)?;
    let names_pathological = o
        .pathological
        .as_deref()
        .map(|p| named("w", file_name(p)))
        .transpose()?;
    let names_lesion = o
        .lesion
        .as_deref()
        .map(|p| named("w", file_name(p)))
        .transpose()?;
    let mut planned: Vec<&String> = vec![&names_synthetic, &names_primary, &names_brain];
    if o.keep_synth {
        planned.push(&names_native);
    }
    planned.extend(names_pathological.iter().chain(names_lesion.iter()));
    let mut unique = planned.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != planned.len() {
        return Err(
            "Input basenames would create duplicate output names. Rename one input and try again."
                .into(),
        );
    }

    // Inputs: validation and de-shearing, before any tool runs.
    let input_bytes = read_all(h, &o.input).await?;
    let mut primary = read(&input_bytes)?;
    if has_two_values(&primary.data) {
        return Err("The primary scan must be a scalar image, not a binary mask.".into());
    }
    let template_bytes = read_all(h, &o.template).await?;
    let template = read(&template_bytes)?;
    let mut pathological = match &o.pathological {
        Some(p) => {
            let v = read(&read_all(h, p).await?)?;
            if has_two_values(&v.data) {
                return Err(
                    "The pathological modality scan must be a scalar image, not a binary mask."
                        .into(),
                );
            }
            Some(v)
        }
        None => None,
    };
    let mut lesion = match &o.lesion {
        Some(p) => Some(read_binary(&read_all(h, p).await?)?),
        None => None,
    };
    if let Some(l) = &lesion {
        let reference_ok = match &pathological {
            Some(p) => compatible_mask_geometry(p, l),
            None => compatible_mask_geometry(&primary, l),
        };
        if !reference_ok {
            let which = if pathological.is_some() {
                "pathological modality"
            } else {
                "primary"
            };
            return Err(format!("The lesion map must match the {which} scan grid."));
        }
    }
    let primary_grid = orthogonal_grid(primary.dims, &primary.affine)?;
    let pathological_grid = match &pathological {
        Some(p) => orthogonal_grid(p.dims, &p.affine)?,
        None => None,
    };
    // A lesion follows its scan's de-shearing; a sheared lesion on an orthogonal scan moves onto the scan grid.
    let lesion_grid: Option<Grid> = lesion.as_ref().and_then(|l| {
        let reference = pathological.as_ref().unwrap_or(&primary);
        let scan_grid = if pathological.is_some() {
            pathological_grid.clone()
        } else {
            primary_grid.clone()
        };
        scan_grid.or_else(|| {
            has_shear(&l.affine).then_some(Grid {
                dims: reference.dims,
                affine: reference.affine,
            })
        })
    });
    // Fill with the darkest voxel, not zero: sheared scans are mostly CT, where air is about -1000 HU.
    let mut primary_description = "Primary scan";
    if let Some(g) = &primary_grid {
        primary = geometry::resample_linear(&primary, g, darkest(&primary.data))?;
        primary_description = "Desheared primary scan";
    }
    if let (Some(g), Some(p)) = (&pathological_grid, pathological.as_mut()) {
        *p = geometry::resample_linear(p, g, darkest(&p.data))?;
    }
    if let (Some(g), Some(l)) = (&lesion_grid, lesion.as_mut()) {
        *l = geometry::resample_nearest(l, g)?;
    }

    // Resume: every input's name and content and the options must match the interrupted run.
    h.mkdirs(&o.work)?;
    if !o.out.is_empty() {
        h.mkdirs(&o.out)?;
    }
    let (input_hash, template_hash) = (sha256(&input_bytes), sha256(&template_bytes));
    let mut fingerprint = vec![json!([input_name, input_hash])];
    for p in [&o.pathological, &o.lesion].into_iter().flatten() {
        fingerprint.push(json!([file_name(p), sha256(&read_all(h, p).await?)]));
    }
    let run_record = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "inputs": fingerprint,
        "template": template_hash,
        "options": {"ct": o.ct, "normalization": format!("{:?}", o.normalization), "keepSynth": o.keep_synth, "heal": o.heal},
        "software": o.software,
    })
    .to_string();
    let record_path = work("syncro.json");
    if h.exists(&record_path) && h.read_text(&record_path, 1 << 20).await? != run_record {
        return Err("Checkpoint input, options or software differ.".into());
    }
    put(h, &record_path, run_record.as_bytes()).await?;

    // Every image a tool reads is the web app's float32 (or uint8 mask) encoding, so both hosts' tools see the
    // same voxels and datatypes.
    let template_path = work("template.nii");
    put(h, &template_path, &volume::write(&template, "MNI template")).await?;
    let primary_path = work("primary.nii");
    put(
        h,
        &primary_path,
        &volume::write(&primary, primary_description),
    )
    .await?;
    let pathological_path = work("pathological.nii");
    if let Some(p) = &pathological {
        put(
            h,
            &pathological_path,
            &volume::write(p, "Pathological modality scan"),
        )
        .await?;
    }
    let lesion_path = work("lesion.nii");
    if let Some(l) = &lesion {
        put(h, &lesion_path, &volume::write(l, "Lesion map")).await?;
    }

    // The tools read the work files; the decoded volumes are not needed again, and a browser's WebAssembly memory
    // never shrinks, so they go before the first tool runs.
    let fill = if o.ct {
        darkest(&primary.data).min(0.0)
    } else {
        0.0
    };
    let output_space = json!({"dims": template.dims, "affine": template.affine});
    let has_pathological = pathological.is_some();
    drop((
        primary,
        pathological,
        lesion,
        template,
        input_bytes,
        template_bytes,
    ));

    let mut r = Runner {
        h,
        o,
        timings: Map::new(),
        commands: vec![],
    };
    let mut stage_start = h.now();
    let mut begin = |r: &mut Runner<H>, name: &str, previous: Option<&str>| {
        if let Some(p) = previous {
            r.timings.insert(p.into(), json!(h.now() - stage_start));
        }
        stage_start = h.now();
        stage(name);
    };

    let pathological_matrix = work("pathological.mat");
    if has_pathological {
        begin(&mut r, "pathological-registration", None);
        let argv = r.greedy(&[
            "-a",
            "-m",
            "NMI",
            "-i",
            &primary_path,
            &pathological_path,
            "-o",
            &pathological_matrix,
            "-n",
            ITERATIONS,
            "-ia-image-centers",
        ]);
        r.step(
            argv,
            vec![],
            std::slice::from_ref(&pathological_matrix),
            false,
        )
        .await?;
    }

    begin(
        &mut r,
        "synthsr",
        has_pathological.then_some("pathological-registration"),
    );
    #[cfg(feature = "heal")]
    let (synthsr_input, healed) = if o.heal {
        // A lesion drawn on the pathological scan follows its affine onto the primary grid first (as SYNcro.py).
        let lesion_on_primary = if has_pathological {
            let onto = work("lesion-primary-grid.nii");
            r.greedy_reslice(
                &primary_path,
                &lesion_path,
                &onto,
                &[&pathological_matrix],
                // Nearest: a linear reslice of the uint8 lesion truncates border voxels (a one-slice lesion to 0).
                true,
                0.0,
            )
            .await?;
            onto
        } else {
            lesion_path.clone()
        };
        match heal::heal(&mut r, &primary_path, &lesion_on_primary, fill, o.ct).await? {
            Some(healed) => (healed, true),
            None => (primary_path.clone(), false),
        }
    } else {
        (primary_path.clone(), false)
    };
    #[cfg(not(feature = "heal"))]
    let (synthsr_input, healed) = (primary_path.clone(), false);
    let synthetic = work("t1.nii");
    let mut argv = vec!["synthsr".to_string(), synthsr_input, synthetic.clone()];
    if o.ct {
        argv.push("--ct".into());
    }
    // --force: a rerun replaces the previous run's JSON sidecar, which the record does not declare.
    argv.extend(["--threads".into(), r.threads(), "--force".into()]);
    match o.device {
        Device::Cpu => argv.extend(["--device".into(), "cpu".into()]),
        Device::Metal => argv.extend(["--device".into(), "metal".into()]),
        Device::Auto | Device::Cuda => {}
    }
    r.step(argv, vec![], std::slice::from_ref(&synthetic), true)
        .await?;
    if o.keep_synth {
        let bytes = read_all(h, &synthetic).await?;
        let bytes = if compressed_name(&names_native) {
            volume::gzip(&bytes)
        } else {
            bytes
        };
        put(h, &out(&names_native), &bytes).await?;
    }

    begin(&mut r, "mindgrab", Some("synthsr"));
    let (brain, mask) = (work("brain.nii"), work("mask.nii"));
    let mut argv = vec![
        "brainchop-mindgrab".to_string(),
        synthetic.clone(),
        "-o".into(),
        brain.clone(),
        "--mask".into(),
        mask.clone(),
    ];
    match o.device {
        Device::Cpu => argv.extend(["-cpu".into(), r.threads()]),
        Device::Metal => argv.extend(["-backend".into(), "metal".into()]),
        Device::Cuda => argv.extend(["-backend".into(), "cuda".into()]),
        Device::Auto => {}
    }
    r.step(
        argv,
        vec![("BC_NUM_THREADS", r.threads())],
        &[brain.clone(), mask.clone()],
        true,
    )
    .await?;
    let brain_f32 = work("brain-f32.nii");
    put(
        h,
        &brain_f32,
        &volume::write(
            &read(&read_all(h, &brain).await?)?,
            "MindGrab synthetic brain",
        ),
    )
    .await?;

    begin(&mut r, "registration", Some("mindgrab"));
    let warped_brain = out(&names_synthetic);
    let chain: Vec<String> = match o.normalization {
        Normalization::Greedy => {
            let (affine, warp) = (work("affine.mat"), work("warp.nii"));
            let argv = r.greedy(&[
                "-a",
                "-m",
                "NMI",
                "-i",
                &template_path,
                &brain_f32,
                "-o",
                &affine,
                "-n",
                ITERATIONS,
                "-ia-image-centers",
            ]);
            r.step(argv, vec![], std::slice::from_ref(&affine), false)
                .await?;
            let argv = r.greedy(&[
                "-m",
                "NMI",
                "-i",
                &template_path,
                &brain_f32,
                "-it",
                &affine,
                "-o",
                &warp,
                "-sv",
                "-n",
                ITERATIONS,
            ]);
            r.step(argv, vec![], std::slice::from_ref(&warp), false)
                .await?;
            r.greedy_reslice(
                &template_path,
                &brain_f32,
                &warped_brain,
                &[&warp, &affine],
                false,
                0.0,
            )
            .await?;
            vec![warp, affine]
        }
        Normalization::Ants => {
            let prefix = work("ants-");
            let warped = format!("{prefix}brain.nii.gz");
            let (fixed, moving) = (&template_path, &brain_f32);
            // ANTsPy 0.6.1 type_of_transform='SyN' with an explicit seed and float precision, as the WASM kernel.
            let argv: Vec<String> = [
                "antsRegistration",
                "--dimensionality",
                "3",
                "--float",
                "1",
                "--random-seed",
                &SEED.to_string(),
                "-r",
                &format!("[{fixed},{moving},1]"),
                "--metric",
                &format!("mattes[{fixed},{moving},1,32,regular,0.2]"),
                "--transform",
                "Affine[0.25]",
                "--convergence",
                "2100x1200x1200x0",
                "--smoothing-sigmas",
                "3x2x1x0",
                "--shrink-factors",
                "4x2x2x1",
                "--metric",
                &format!("mattes[{fixed},{moving},1,32]"),
                "--transform",
                "SyN[0.2,3,0]",
                "--convergence",
                "[40x20x0,1e-7,8]",
                "--smoothing-sigmas",
                "2x1x0",
                "--shrink-factors",
                "4x2x1",
                "-u",
                "0",
                "-z",
                "1",
                "--output",
                &format!("[{prefix},{warped}]"),
                "--verbose",
                "1",
            ]
            .map(String::from)
            .to_vec();
            let (warp, affine) = (
                format!("{prefix}1Warp.nii.gz"),
                format!("{prefix}0GenericAffine.mat"),
            );
            let env = vec![("ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS", r.threads())];
            // Its images appear only inside bracketed options, so the resume record names them explicitly.
            r.step_reading(
                argv,
                env,
                &[warped.clone(), warp.clone(), affine.clone()],
                false,
                &[template_path.clone(), brain_f32.clone()],
            )
            .await?;
            let bytes = read_all(h, &warped).await?;
            let bytes = if compressed_name(&names_synthetic) {
                bytes
            } else {
                volume::gunzip(&bytes)?
            };
            put(h, &warped_brain, &bytes).await?;
            vec![warp, affine]
        }
    };

    validate_registered_brain(
        &read(&read_all(h, &warped_brain).await?)?,
        &read(&read_all(h, &template_path).await?)?,
    )?;

    begin(&mut r, "resampling", Some("registration"));
    let chain_refs: Vec<&str> = chain.iter().map(String::as_str).collect();
    let apply = async |r: &mut Runner<'_, H>,
                       moving: &str,
                       output: &str,
                       nearest: bool,
                       fill: f32,
                       preceding: bool,
                       label: &str|
           -> Result<(), String> {
        match o.normalization {
            Normalization::Greedy => {
                let mut c = chain_refs.clone();
                if preceding {
                    c.push(&pathological_matrix);
                }
                r.greedy_reslice(&template_path, moving, output, &c, nearest, fill)
                    .await
            }
            Normalization::Ants => {
                // The pathological affine runs first, on Greedy, onto the primary grid (as the web app does).
                let moving = if preceding {
                    let onto = work(&format!("{label}-primary-grid.nii"));
                    r.greedy_reslice(
                        &primary_path,
                        moving,
                        &onto,
                        &[&pathological_matrix],
                        nearest,
                        fill,
                    )
                    .await?;
                    onto
                } else {
                    moving.to_string()
                };
                let argv: Vec<String> = [
                    "antsApplyTransforms",
                    "-d",
                    "3",
                    "--float",
                    "1",
                    "-i",
                    &moving,
                    "-r",
                    &template_path,
                    "-o",
                    output,
                    "-n",
                    if nearest { "NearestNeighbor" } else { "Linear" },
                    "-f",
                    &format!("{fill}"),
                    "-t",
                    chain_refs[0],
                    "-t",
                    chain_refs[1],
                ]
                .map(String::from)
                .to_vec();
                let env = vec![("ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS", r.threads())];
                r.step(argv, env, &[output.to_string()], false).await
            }
        }
    };
    apply(
        &mut r,
        &primary_path,
        &out(&names_primary),
        false,
        fill,
        false,
        "primary",
    )
    .await?;
    if let Some(name) = &names_pathological {
        apply(
            &mut r,
            &pathological_path,
            &out(name),
            false,
            0.0,
            true,
            "pathological",
        )
        .await?;
    }
    if let Some(name) = &names_lesion {
        let smoothed = work("lesion-smoothed.nii");
        let argv = vec![
            "niimath".into(),
            lesion_path.clone(),
            "-s".into(),
            format!("{LESION_SIGMA}"),
            smoothed.clone(),
            "-odt".into(),
            "float".into(),
        ];
        let env = r.niimath_env(&smoothed);
        r.step(argv, env, std::slice::from_ref(&smoothed), false)
            .await?;
        let warped = work("lesion-warped.nii");
        apply(
            &mut r,
            &smoothed,
            &warped,
            true,
            0.0,
            has_pathological,
            "lesion",
        )
        .await?;
        let output = out(name);
        let argv = vec![
            "niimath".into(),
            warped,
            "-thr".into(),
            "0.5".into(),
            "-bin".into(),
            output.clone(),
            "-odt".into(),
            "char".into(),
        ];
        let env = r.niimath_env(&output);
        r.step(argv, env, std::slice::from_ref(&output), false)
            .await?;
    }
    let masked = out(&names_brain);
    let argv = vec![
        "niimath".into(),
        out(&names_primary),
        "-mas".into(),
        warped_brain.clone(),
        masked.clone(),
        "-odt".into(),
        "input".into(),
    ];
    let env = r.niimath_env(&masked);
    r.step(argv, env, std::slice::from_ref(&masked), false)
        .await?;
    begin(&mut r, "complete", Some("resampling"));

    let mut outputs = vec![names_synthetic.clone(), names_primary.clone()];
    outputs.extend(names_pathological.iter().cloned());
    outputs.extend(names_lesion.iter().cloned());
    outputs.push(names_brain.clone());
    if o.keep_synth {
        outputs.insert(0, names_native.clone());
    }
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "ct": o.ct,
        "keepSynth": o.keep_synth,
        "healed": healed,
        "brainExtractor": "mindgrab",
        "normalization": match o.normalization { Normalization::Greedy => "greedy", Normalization::Ants => "ants" },
        "threads": o.threads,
        "desheared": {"primary": primary_grid.is_some(), "pathological": pathological_grid.is_some(), "lesion": lesion_grid.is_some()},
        "inputs": {
            "primary": input_name,
            "pathological": o.pathological.as_deref().map(file_name),
            "lesion": o.lesion.as_deref().map(file_name),
            "lesionSpace": if o.pathological.is_some() { "pathological" } else { "primary" },
        },
        "inputHash": input_hash,
        "templateHash": template_hash,
        "commands": r.commands,
        "timings": r.timings,
        "totalSeconds": h.now() - t0,
        "outputSpace": output_space,
        "outputs": outputs,
        "resamplingDatatype": "float32",
        "synthetic": true,
    }))
}

fn validate_registered_brain(brain: &Volume<f32>, template: &Volume<f32>) -> Result<(), String> {
    if !same_geometry(brain, template) {
        return Err(
            "Normalization failed: registered brain does not match the MNI template grid.".into(),
        );
    }
    let (mut support, mut overlap) = (0usize, 0usize);
    for (t, b) in template.data.iter().zip(&brain.data) {
        if *t > 0.0 {
            support += 1;
            if *b > 0.0 {
                overlap += 1;
            }
        }
    }
    if support == 0 {
        return Err("Invalid MNI template: no positive brain voxels.".into());
    }
    if (overlap as f64) / (support as f64) < 0.01 {
        return Err(format!(
            "Normalization failed: registered brain covers too little of the MNI template ({overlap}/{support} positive voxels, {:.2}%; minimum 1%). Check that the scan contains the brain and has the correct orientation, and inspect the registration.",
            100.0 * overlap as f64 / support as f64
        ));
    }
    Ok(())
}
