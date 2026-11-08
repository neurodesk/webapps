//! The simulated `relion` tool of `--runner simulate`: no RELION program
//! runs. It checks every file the inputs reference, replays RELION-format log
//! lines and writes each command's outputs as small valid STAR and MRC files
//! that reference earlier jobs by project-relative path. The protocol's "The
//! simulated `relion` tool" section is the contract; the Node reference is
//! `test-utils/relion-simulator.mjs`. Files match it in names, blocks, columns
//! and MRC dimensions, not in bytes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use super::spec::{
    class_ranges, line_level, relion_outputs, resolve_input_paths, InputValue, Validated,
};
use super::star::{format_star, pairs, parse_star, Block, Cell, Parsed, Table};
use super::{SIMULATED_WARNING, SIMULATED_WARNING_PREFIX};
use crate::roots::{self, DataRoot};
use crate::tools::mrc::{self, MrcHeader};
use crate::tools::project::{SimulatedEnd, SimulatedRun};
use crate::tools::LogLevel;

const MICROGRAPH: usize = 64;
const BOX: usize = 32;
const POSITIONS: [(f64, f64); 4] = [(16.0, 16.0), (48.0, 16.0), (16.0, 48.0), (48.0, 48.0)];
const LABEL: &str = "SIMULATED by neurodesk-compute";
const OPTICS_GROUP: &str = "opticsGroup1";

/// STAR labels whose values name files.
pub const REFERENCE_LABELS: [&str; 15] = [
    "rlnMicrographMovieName",
    "rlnMicrographName",
    "rlnMicrographNameNoDW",
    "rlnMicrographMetadata",
    "rlnMicrographGainName",
    "rlnCtfPowerSpectrum",
    "rlnCtfImage",
    "rlnMicrographCoordinates",
    "rlnImageName",
    "rlnReferenceImage",
    "rlnModelStarFile",
    "rlnExperimentalDataStarFile",
    "rlnUnfilteredMapHalf1",
    "rlnUnfilteredMapHalf2",
    "rlnMaskName",
];

/// The level the simulator gives a line, as the tool parses it.
pub fn level(line: &str) -> LogLevel {
    if line.starts_with(SIMULATED_WARNING_PREFIX) {
        LogLevel::Warning
    } else {
        line_level(line)
    }
}

struct Job<'a> {
    project_dir: PathBuf,
    directory: &'a str,
    validated: &'a Validated,
    input_paths: BTreeMap<String, String>,
    roots: &'a [DataRoot],
}

struct Log<'a> {
    out: Vec<String>,
    err: Vec<String>,
    sink: &'a (dyn Fn(String) + Sync),
}

impl Log<'_> {
    fn say(&mut self, line: String) {
        if level(&line) == LogLevel::Error {
            self.err.push(line.clone());
        }
        self.out.push(line.clone());
        (self.sink)(line);
    }
}

/// Runs the simulated command; writes `run.out`, `run.err` and the exit marker.
pub fn run(validated: &Validated, run: &SimulatedRun<'_>) -> std::io::Result<SimulatedEnd> {
    let job = Job {
        project_dir: run.project_dir.canonicalize()?,
        directory: run.directory,
        validated,
        input_paths: resolve_input_paths(validated, run.directory),
        roots: run.data_roots,
    };
    let mut log = Log {
        out: Vec::new(),
        err: Vec::new(),
        sink: run.log,
    };
    let end = |log: &mut Log<'_>, marker: Option<&str>| {
        let lines = |lines: &[String]| {
            if lines.is_empty() {
                String::new()
            } else {
                format!("{}\n", lines.join("\n"))
            }
        };
        let written = job
            .write("run.out", lines(&log.out).as_bytes())
            .and_then(|()| job.write("run.err", lines(&log.err).as_bytes()))
            .and_then(|()| marker.map_or(Ok(()), |marker| job.write(marker, b"")));
        if let Err(error) = written {
            (log.sink)(format!("ERROR: Could not write the job's log: {error}"));
        }
    };
    let fail = |log: &mut Log<'_>, message: String| {
        log.say(format!("ERROR: {message}"));
        end(log, Some("RELION_JOB_EXIT_FAILURE"));
        Ok(SimulatedEnd::Failed(message))
    };

    let ranks = run.launch.ranks.unwrap_or(1);
    let mut lines = vec![launch_line(&run.command.main, ranks)];
    lines.extend(
        run.command
            .follow_up
            .iter()
            .map(|step| launch_line(step, 1)),
    );
    for line in lines {
        log.say(format!("Simulated run of: {line}"));
    }
    log.say(SIMULATED_WARNING.to_string());
    if let Err(message) = job.check_references() {
        return fail(&mut log, message);
    }
    for line in synthetic_log(validated) {
        if (run.cancelled)() {
            end(&mut log, None);
            return Ok(SimulatedEnd::Cancelled);
        }
        log.say(line);
        (run.pause)();
    }
    if (run.cancelled)() {
        end(&mut log, None);
        return Ok(SimulatedEnd::Cancelled);
    }
    match job.write_outputs() {
        Ok(summary) => summary.into_iter().for_each(|line| log.say(line)),
        Err(message) => return fail(&mut log, message),
    }
    let missing = match job.missing_outputs() {
        Ok(missing) => missing,
        Err(message) => return fail(&mut log, message),
    };
    if !missing.is_empty() {
        return fail(
            &mut log,
            format!("required outputs are missing: {}", missing.join(", ")),
        );
    }
    end(&mut log, Some("RELION_JOB_EXIT_SUCCESS"));
    Ok(SimulatedEnd::Exited(0))
}

/// One command line as the log shows it, with the MPI launcher when `ranks`
/// is above 1. Empty words and words with whitespace or shell characters are
/// double-quoted.
pub fn launch_line(argv: &[String], ranks: u32) -> String {
    let quote = |word: &String| {
        if word.is_empty() {
            return "\"\"".to_string();
        }
        if word
            .chars()
            .any(|character| character.is_whitespace() || "\"'`$\\".contains(character))
        {
            let mut quoted = String::from("\"");
            for character in word.chars() {
                if "\"\\$`".contains(character) {
                    quoted.push('\\');
                }
                quoted.push(character);
            }
            quoted.push('"');
            return quoted;
        }
        word.clone()
    };
    let words: Vec<String> = argv.iter().map(quote).collect();
    let launcher = if ranks > 1 {
        format!("mpirun --bind-to none -np {ranks} ")
    } else {
        String::new()
    };
    format!("{launcher}{}", words.join(" "))
}

fn bar(done: usize, total: usize) -> String {
    format!(
        "{:>6.2}/{:>6.2} sec {}~~(,_,\">",
        done as f64 * 0.5,
        total as f64 * 0.5,
        ".".repeat(60 * done / total)
    )
}

/// The lines the command prints, in RELION's formats.
pub fn synthetic_log(validated: &Validated) -> Vec<String> {
    let heading = match validated.command.as_str() {
        "motioncorr" => Some(" Correcting beam-induced motions using our own implementation ..."),
        "ctffind" => Some(
            " Estimating CTF parameters using Alexis Rohou's and Niko Grigorieff's CTFFIND4.1 ...",
        ),
        "autopick" => Some(" Autopicking ..."),
        "extract" => Some(" Extracting particles from the micrographs ..."),
        _ => None,
    };
    if let Some(heading) = heading {
        let mut lines = vec![heading.to_string(), "000/??? sec ~~(,_,\">".to_string()];
        lines.extend((1..=4).map(|done| bar(done, 4)));
        return lines;
    }
    match validated.command.as_str() {
        command @ ("class2d" | "initialmodel") => {
            let total = validated.int(if command == "class2d" {
                "nrIterGrad"
            } else {
                "nrIter"
            });
            let quarter = |numerator: i64| ((numerator * total) as f64 / 4.0 + 0.5).floor() as i64;
            let mut iterations: Vec<i64> = Vec::new();
            for iteration in [1, quarter(1), quarter(2), quarter(3), total] {
                if iteration >= 1 && !iterations.contains(&iteration) {
                    iterations.push(iteration);
                }
            }
            let mut lines: Vec<String> = iterations
                .iter()
                .map(|iteration| {
                    format!(
                        " Gradient optimisation iteration {iteration} of {total} (Step size 0.5)"
                    )
                })
                .collect();
            if command == "initialmodel" {
                lines.push(" Aligning the initial model to its symmetry axes ...".into());
            }
            lines
        }
        "refine3d" => {
            let mut lines = Vec::new();
            for iteration in 1..=5 {
                lines.push(format!(" Auto-refine: Iteration= {iteration}"));
                lines.push(format!(
                    " Auto-refine: Resolution= {} (no gain for 0 iter) ",
                    super::spec::relion_number(20.0 / f64::from(iteration))
                ));
            }
            lines.push(" Auto-refine: Refinement has converged, entering last iteration where two halves will be combined...".into());
            lines
        }
        "import" => vec![" Importing files ...".into()],
        "select" => vec![" Selecting particles ...".into()],
        "maskcreate" => vec!["== Lowpass filtering initial map ...".into()],
        _ => vec!["== Reading input half-reconstructions ...".into()],
    }
}

/// A value's file and image index: `000003@stack.mrcs` and `file.ctf:mrc`.
fn parse_reference(value: &str) -> (Option<u64>, &str) {
    let (index, rest) = match value.split_once('@') {
        Some((digits, rest))
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (digits.parse().ok(), rest)
        }
        _ => (None, value),
    };
    let path = rest
        .strip_suffix(":mrcs")
        .or_else(|| rest.strip_suffix(":mrc"))
        .unwrap_or(rest);
    (index, path)
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) => name[..dot].to_string(),
        None => name.to_string(),
    }
}

// `path.join`: components joined and `.`/`..` resolved lexically.
fn join_lexically(base: &Path, rest: &[&str]) -> PathBuf {
    let mut path = base.to_path_buf();
    for component in rest {
        match *component {
            "" | "." => {}
            ".." => {
                path.pop();
            }
            name => path.push(name),
        }
    }
    path.components()
        .collect::<Vec<Component<'_>>>()
        .iter()
        .collect()
}

fn find<'a>(blocks: &'a [Parsed], name: &str, file: &str) -> Result<&'a Parsed, String> {
    blocks
        .iter()
        .find(|block| block.name == name)
        .ok_or_else(|| format!("{file} has no data_{name} block"))
}

fn disk(n: usize, cx: f64, cy: f64, radius: f64, value: f32) -> Vec<f32> {
    let mut data = vec![0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            if (x as f64 - cx).powi(2) + (y as f64 - cy).powi(2) <= radius * radius {
                data[y * n + x] = value;
            }
        }
    }
    data
}

fn sphere(n: usize, radius: f64, edge: f64, scale: f64) -> Vec<f32> {
    let mut data = vec![0f32; n * n * n];
    let centre = n as f64 / 2.0;
    for z in 0..n {
        for y in 0..n {
            for x in 0..n {
                let distance = ((x as f64 - centre).powi(2)
                    + (y as f64 - centre).powi(2)
                    + (z as f64 - centre).powi(2))
                .sqrt();
                let value = if distance <= radius {
                    1.0
                } else if distance < radius + edge {
                    0.5 + 0.5 * (std::f64::consts::PI * (distance - radius) / edge).cos()
                } else {
                    0.0
                };
                data[(z * n + y) * n + x] = (value * scale) as f32;
            }
        }
    }
    data
}

fn micrograph() -> Vec<f32> {
    let mut data = vec![0f32; MICROGRAPH * MICROGRAPH];
    for (cx, cy) in POSITIONS {
        for (value, blob) in data.iter_mut().zip(disk(MICROGRAPH, cx, cy, 8.0, -1.0)) {
            *value += blob;
        }
    }
    data
}

fn image_stack(count: usize, radius_of: impl Fn(usize) -> f64) -> Vec<f32> {
    let half = BOX as f64 / 2.0;
    (0..count)
        .flat_map(|index| disk(BOX, half, half, radius_of(index), 1.0))
        .collect()
}

/// The synthetic FSC at `shell` of a 32-voxel box.
pub fn synthetic_fsc(shell: f64) -> f64 {
    let half = BOX as f64 / 2.0;
    1.0 / (1.0 + ((shell - 0.625 * half) / (0.09375 * half)).exp())
}

/// Where the synthetic FSC crosses `threshold`, in Å.
pub fn fsc_resolution(angpix: f64, threshold: f64) -> f64 {
    for shell in 1..=BOX / 2 {
        let shell = shell as f64;
        let value = synthetic_fsc(shell);
        if value < threshold {
            let previous = synthetic_fsc(shell - 1.0);
            let crossing = shell - 1.0 + (previous - threshold) / (previous - value);
            return BOX as f64 * angpix / crossing;
        }
    }
    2.0 * angpix
}

fn shell_rows(angpix: f64, values_of: impl Fn(f64) -> Vec<f64>) -> Vec<Vec<Cell>> {
    (0..=BOX / 2)
        .map(|shell| {
            let shell = shell as f64;
            let resolution = shell / (BOX as f64 * angpix);
            let mut row = vec![
                Cell::Num(shell),
                Cell::Num(resolution),
                Cell::Num(if shell == 0.0 {
                    999.0
                } else {
                    1.0 / resolution
                }),
            ];
            row.extend(values_of(shell).into_iter().map(Cell::Num));
            row
        })
        .collect()
}

fn model_general(
    dimensionality: f64,
    classes: f64,
    angpix: f64,
    resolution: f64,
    extra: Vec<(&str, Cell)>,
) -> Block {
    let mut list = vec![
        ("rlnReferenceDimensionality", Cell::Num(dimensionality)),
        ("rlnDataDimensionality", Cell::Num(2.0)),
        ("rlnOriginalImageSize", Cell::Num(BOX as f64)),
        ("rlnCurrentResolution", Cell::Num(resolution)),
        ("rlnCurrentImageSize", Cell::Num(BOX as f64)),
        ("rlnPaddingFactor", Cell::Num(2.0)),
        ("rlnPixelSize", Cell::Num(angpix)),
        ("rlnNrClasses", Cell::Num(classes)),
        ("rlnNrBodies", Cell::Num(1.0)),
        ("rlnNrGroups", Cell::Num(1.0)),
        ("rlnNrOpticsGroups", Cell::Num(1.0)),
    ];
    list.extend(extra);
    pairs("model_general", list)
}

fn optimiser_general(root: String, model: String, data: String, extra: Vec<(&str, Cell)>) -> Block {
    let mut list = vec![
        ("rlnOutputRootName", Cell::Text(root)),
        ("rlnModelStarFile", Cell::Text(model)),
        ("rlnExperimentalDataStarFile", Cell::Text(data)),
    ];
    list.extend(extra);
    pairs("optimiser_general", list)
}

fn class_counts(particles: &Table, classes: usize) -> Result<Vec<usize>, String> {
    let index = particles.index("rlnClassNumber")?;
    let mut counts = vec![0; classes];
    for row in &particles.rows {
        let number = row.get(index).map_or(f64::NAN, Cell::number);
        if number >= 1.0 && (number as usize) <= classes {
            counts[number as usize - 1] += 1;
        }
    }
    Ok(counts)
}

fn computed<'a>(
    label: &'a str,
    value_of: impl Fn(&[Cell], usize) -> Cell + 'a,
) -> super::star::ColumnValue<'a> {
    (label, Box::new(value_of))
}

fn constant(label: &str, value: f64) -> super::star::ColumnValue<'_> {
    computed(label, move |_, _| Cell::Num(value))
}

fn stat_columns<'a>() -> Vec<super::star::ColumnValue<'a>> {
    vec![
        constant("rlnNormCorrection", 1.0),
        constant("rlnLogLikeliContribution", 1000.0),
        constant("rlnMaxValueProbDistribution", 0.9),
        constant("rlnNrOfSignificantSamples", 1.0),
    ]
}

fn modulo(index: usize, step: usize, modulus: usize) -> f64 {
    ((index * step) % modulus) as f64
}

impl Job<'_> {
    fn job_file(&self, name: &str) -> PathBuf {
        self.project_dir.join(self.directory).join(name)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        let path = self.job_file(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, bytes)
    }

    fn put(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.write(name, bytes)
            .map_err(|error| format!("could not write {}/{name}: {error}", self.directory))
    }

    fn put_star(&self, name: &str, blocks: &[Block]) -> Result<(), String> {
        self.put(name, format_star(blocks).as_bytes())
    }

    fn put_mrc(
        &self,
        name: &str,
        size: (usize, usize, usize),
        data: &[f32],
        angpix: f64,
        stack: bool,
    ) -> Result<(), String> {
        self.put(
            name,
            &mrc::write(size.0, size.1, size.2, data, angpix, stack, LABEL),
        )
    }

    fn put_volume(&self, name: &str, data: &[f32], angpix: f64) -> Result<(), String> {
        self.put_mrc(name, (BOX, BOX, BOX), data, angpix, false)
    }

    fn root(&self, id: &str) -> Option<&DataRoot> {
        self.roots.iter().find(|root| root.id == id)
    }

    /// The canonical host file a job-visible path names, or why there is none.
    fn locate(&self, reference: &str) -> Result<PathBuf, String> {
        let (base, target) = if let Some(rest) = reference.strip_prefix("/data/") {
            let mut parts = rest.split('/');
            let id = parts.next().unwrap_or("");
            let root = self
                .root(id)
                .ok_or_else(|| format!("names data root {id}, which the server does not have"))?;
            let rest: Vec<&str> = parts.collect();
            (root.path.clone(), join_lexically(&root.path, &rest))
        } else if reference.starts_with('/') {
            return Err("is an absolute path outside /project and /data".into());
        } else {
            let parts: Vec<&str> = reference.split('/').collect();
            (
                self.project_dir.clone(),
                join_lexically(&self.project_dir, &parts),
            )
        };
        let canonical = target
            .canonicalize()
            .map_err(|_| "does not exist".to_string())?;
        // Import links its data-root directory into the project
        // (`<dir>data`), so a project path may resolve into a data root, as it
        // does in the container.
        let allowed = canonical.starts_with(&base)
            || self
                .roots
                .iter()
                .any(|root| canonical.starts_with(&root.path));
        if !allowed {
            return Err("lies outside the project and the data roots".into());
        }
        if !canonical.is_file() {
            return Err("is not a regular file".into());
        }
        Ok(canonical)
    }

    fn read_star(&self, reference: &str) -> Result<Vec<Parsed>, String> {
        let path = self
            .locate(reference)
            .map_err(|problem| format!("{reference} {problem}"))?;
        let text =
            std::fs::read_to_string(&path).map_err(|error| format!("{reference}: {error}"))?;
        parse_star(&text)
    }

    fn read_mrc(&self, reference: &str) -> Result<MrcHeader, String> {
        let path = self
            .locate(reference)
            .map_err(|problem| format!("{reference} {problem}"))?;
        header_of(&path).ok_or_else(|| format!("{reference} is not an MRC file"))
    }

    fn input(&self, name: &str) -> Result<&str, String> {
        self.input_paths
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| format!("no path for input {name}"))
    }

    /// The first file the job needs that is missing, as an error message.
    fn check_references(&self) -> Result<(), String> {
        let mut checker = Checker {
            job: self,
            scanned: HashSet::new(),
            headers: HashMap::new(),
        };
        for (name, value) in self.validated.ordered_inputs() {
            let from = format!("inputs.{name}");
            if let InputValue::DataRoot {
                root,
                path,
                pattern,
            } = value
            {
                let root = self.root(root).ok_or_else(|| {
                    format!("{from} names data root {root}, which the server does not have")
                })?;
                roots::match_pattern(root, path, pattern)
                    .map_err(|error| format!("{from}: {error}"))?;
                continue;
            }
            let path = self.input(name)?;
            let mrc_like = path.ends_with(".mrc") || path.ends_with(".mrcs");
            if path.ends_with(".star") {
                checker.scan(path, &from)?;
            } else if mrc_like && !path.starts_with("/data/") {
                checker.require_mrc(path, &from)?;
            } else {
                checker.need(path, &from)?;
            }
        }
        if self.validated.command == "postprocess" {
            let (half1, half2) = half_maps(self.input("halfMap")?);
            let first = checker.require_mrc(&half1, "inputs.halfMap")?;
            let second = checker.require_mrc(&half2, "inputs.halfMap")?;
            let mask = checker.require_mrc(self.input("mask")?, "inputs.mask")?;
            if first.nx != second.nx || first.nx != mask.nx {
                return Err("the half maps and the mask differ in size".into());
            }
        }
        Ok(())
    }

    fn missing_outputs(&self) -> Result<Vec<String>, String> {
        Ok(relion_outputs(self.validated)?
            .into_iter()
            .filter(|(_, required)| *required)
            .map(|(path, _)| path)
            .filter(|path| self.locate(&format!("{}/{path}", self.directory)).is_err())
            .collect())
    }

    fn write_outputs(&self) -> Result<Vec<String>, String> {
        match self.validated.command.as_str() {
            "import" => self.import(),
            "motioncorr" => self.motioncorr(),
            "ctffind" => self.ctffind(),
            "autopick" => self.autopick(),
            "extract" => self.extract(),
            "class2d" => self.class2d(),
            "select" => self.select(),
            "initialmodel" => self.initialmodel(),
            "refine3d" => self.refine3d(),
            "maskcreate" => self.maskcreate(),
            "postprocess" => self.postprocess(),
            command => Err(format!("no simulation for {command}")),
        }
    }

    fn import(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let Some(InputValue::DataRoot {
            root,
            path,
            pattern,
        }) = options.inputs.get("movies")
        else {
            return Err("inputs.movies is not a data root reference".into());
        };
        let data_root = self.root(root).ok_or_else(|| {
            format!("inputs.movies names data root {root}, which the server does not have")
        })?;
        let matched = roots::match_pattern(data_root, path, pattern)
            .map_err(|error| format!("inputs.movies: {error}"))?;
        // Real import first runs `ln -sfn /data/<root>/<path> <dir>data`,
        // because relion_import refuses absolute paths; the STAR file names
        // the link.
        let target = if matched.directory.is_empty() {
            data_root.path.clone()
        } else {
            data_root.path.join(&matched.directory)
        };
        let link = self.project_dir.join(self.directory).join("data");
        let _ = std::fs::remove_file(&link);
        symlink_dir(&target, &link)
            .map_err(|error| format!("could not link {}/data: {error}", self.directory))?;
        let files: Vec<String> = matched
            .names
            .iter()
            .map(|name| format!("{}/data/{name}", self.directory))
            .collect();
        let mut optics_columns = vec![
            "rlnOpticsGroupName",
            "rlnOpticsGroup",
            "rlnMicrographOriginalPixelSize",
            "rlnVoltage",
            "rlnSphericalAberration",
            "rlnAmplitudeContrast",
        ];
        let mut optics_row = vec![
            Cell::from(OPTICS_GROUP),
            Cell::Num(1.0),
            Cell::Num(options.number("angpix")),
            Cell::Num(options.number("kV")),
            Cell::Num(options.number("Cs")),
            Cell::Num(options.number("Q0")),
        ];
        let rows = |files: &[String]| -> Vec<Vec<Cell>> {
            files
                .iter()
                .map(|file| vec![Cell::from(file.as_str()), Cell::Num(1.0)])
                .collect()
        };
        if options.flag("isMultiframe") {
            self.put_star(
                "movies.star",
                &[
                    Block::Loop(Table::new("optics", &optics_columns, vec![optics_row])),
                    Block::Loop(Table::new(
                        "movies",
                        &["rlnMicrographMovieName", "rlnOpticsGroup"],
                        rows(&files),
                    )),
                ],
            )?;
            return Ok(vec![format!(" Imported {} movies", files.len())]);
        }
        optics_columns.push("rlnMicrographPixelSize");
        optics_row.push(Cell::Num(options.number("angpix")));
        self.put_star(
            "micrographs.star",
            &[
                Block::Loop(Table::new("optics", &optics_columns, vec![optics_row])),
                Block::Loop(Table::new(
                    "micrographs",
                    &["rlnMicrographName", "rlnOpticsGroup"],
                    rows(&files),
                )),
            ],
        )?;
        Ok(vec![format!(" Imported {} micrographs", files.len())])
    }

    fn motioncorr(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let input = self.input("movies")?;
        let blocks = self.read_star(input)?;
        let optics = &find(&blocks, "optics", input)?.table;
        let movies = &find(&blocks, "movies", input)?.table;
        let first = optics
            .rows
            .first()
            .ok_or_else(|| format!("{input} has no optics group"))?;
        let original = optics
            .cell(first, "rlnMicrographOriginalPixelSize")?
            .number();
        let voltage = optics.text(first, "rlnVoltage")?;
        let bin = options.number("binFactor");
        let angpix = original * bin;
        let gain = self.input_paths.get("gain");
        let (no_dw, power) = (options.flag("doSaveNoDW"), options.flag("doSavePs"));
        let size = (MICROGRAPH, MICROGRAPH, 1);
        let mut rows = Vec::new();
        for row in &movies.rows {
            let movie = movies.text(row, "rlnMicrographMovieName")?;
            let name = stem(&movie);
            self.put_mrc(
                &format!("Movies/{name}.mrc"),
                size,
                &micrograph(),
                angpix,
                false,
            )?;
            let mut general = vec![
                ("rlnImageSizeX", Cell::Num(MICROGRAPH as f64)),
                ("rlnImageSizeY", Cell::Num(MICROGRAPH as f64)),
                ("rlnImageSizeZ", Cell::Num(24.0)),
                ("rlnMicrographMovieName", Cell::from(movie.as_str())),
            ];
            if let Some(gain) = gain {
                general.push(("rlnMicrographGainName", Cell::from(gain.as_str())));
            }
            general.extend([
                ("rlnMicrographBinning", Cell::Num(bin)),
                ("rlnMicrographOriginalPixelSize", Cell::Num(original)),
                (
                    "rlnMicrographDoseRate",
                    Cell::Num(options.number("dosePerFrame")),
                ),
                (
                    "rlnMicrographPreExposure",
                    Cell::Num(options.number("preExposure")),
                ),
                ("rlnVoltage", Cell::from(voltage.as_str())),
                (
                    "rlnMicrographStartFrame",
                    Cell::Num(options.number("firstFrameSum")),
                ),
                ("rlnMotionModelVersion", Cell::Num(0.0)),
            ]);
            self.put_star(&format!("Movies/{name}.star"), &[pairs("general", general)])?;
            let mut out = vec![Cell::Text(format!("{dir}/Movies/{name}.mrc"))];
            if no_dw {
                self.put_mrc(
                    &format!("Movies/{name}_noDW.mrc"),
                    size,
                    &micrograph(),
                    angpix,
                    false,
                )?;
                out.push(Cell::Text(format!("{dir}/Movies/{name}_noDW.mrc")));
            }
            out.extend([
                Cell::Text(format!("{dir}/Movies/{name}.star")),
                movies.cell(row, "rlnOpticsGroup")?.clone(),
                Cell::Num(0.5),
                Cell::Num(0.25),
                Cell::Num(0.25),
            ]);
            if power {
                let spectrum = disk(MICROGRAPH, 32.0, 32.0, 20.0, 1.0);
                self.put_mrc(
                    &format!("Movies/{name}_PS.mrc"),
                    size,
                    &spectrum,
                    angpix,
                    false,
                )?;
                out.push(Cell::Text(format!("{dir}/Movies/{name}_PS.mrc")));
            }
            rows.push(out);
        }
        let mut columns = vec!["rlnMicrographName"];
        if no_dw {
            columns.push("rlnMicrographNameNoDW");
        }
        columns.extend([
            "rlnMicrographMetadata",
            "rlnOpticsGroup",
            "rlnAccumMotionTotal",
            "rlnAccumMotionEarly",
            "rlnAccumMotionLate",
        ]);
        if power {
            columns.push("rlnCtfPowerSpectrum");
        }
        let count = rows.len();
        self.put_star(
            "corrected_micrographs.star",
            &[
                Block::Loop(
                    optics.with_columns("optics", vec![constant("rlnMicrographPixelSize", angpix)]),
                ),
                Block::Loop(Table::new("micrographs", &columns, rows)),
            ],
        )?;
        Ok(vec![format!(" Motion-corrected {count} movies")])
    }

    fn ctffind(&self) -> Result<Vec<String>, String> {
        let dir = self.directory;
        let input = self.input("micrographs")?;
        let blocks = self.read_star(input)?;
        let optics = &find(&blocks, "optics", input)?.table;
        let micrographs = &find(&blocks, "micrographs", input)?.table;
        let first = optics
            .rows
            .first()
            .ok_or_else(|| format!("{input} has no optics group"))?;
        let angpix = optics.cell(first, "rlnMicrographPixelSize")?.number();
        let name_index = micrographs.index("rlnMicrographName")?;
        let name_of = move |row: &[Cell]| match row.get(name_index) {
            Some(Cell::Text(text)) => stem(text),
            _ => String::new(),
        };
        let mut entries = vec![
            computed("rlnCtfImage", move |row, _| {
                Cell::Text(format!("{dir}/Movies/{}.ctf:mrc", name_of(row)))
            }),
            computed("rlnDefocusU", |_, index| {
                Cell::Num(15000.0 + 1000.0 * index as f64)
            }),
            computed("rlnDefocusV", |_, index| {
                Cell::Num(14800.0 + 1000.0 * index as f64)
            }),
            constant("rlnCtfAstigmatism", 200.0),
            constant("rlnDefocusAngle", 30.0),
            constant("rlnCtfFigureOfMerit", 0.15),
            constant("rlnCtfMaxResolution", 4.0),
        ];
        if self.validated.flag("doPhaseshift") {
            entries.push(constant("rlnPhaseShift", self.validated.number("phaseMin")));
        }
        for row in &micrographs.rows {
            let ctf = disk(MICROGRAPH, 32.0, 32.0, 24.0, 1.0);
            self.put_mrc(
                &format!("Movies/{}.ctf", name_of(row)),
                (MICROGRAPH, MICROGRAPH, 1),
                &ctf,
                angpix,
                false,
            )?;
        }
        let count = micrographs.rows.len();
        self.put_star(
            "micrographs_ctf.star",
            &[
                Block::Loop(optics.renamed("optics")),
                Block::Loop(micrographs.with_columns("micrographs", entries)),
            ],
        )?;
        Ok(vec![format!(" Estimated the CTF of {count} micrographs")])
    }

    fn autopick(&self) -> Result<Vec<String>, String> {
        let input = self.input("micrographs")?;
        let blocks = self.read_star(input)?;
        let micrographs = &find(&blocks, "micrographs", input)?.table;
        let mut rows = Vec::new();
        for row in &micrographs.rows {
            let micrograph = micrographs.text(row, "rlnMicrographName")?;
            let coordinates = format!("Movies/{}_autopick.star", stem(&micrograph));
            let picks = POSITIONS
                .iter()
                .enumerate()
                .map(|(index, (x, y))| {
                    vec![
                        Cell::Num(*x),
                        Cell::Num(*y),
                        Cell::Num(0.0),
                        Cell::Num(1.0 - 0.1 * index as f64),
                        Cell::Num(-999.0),
                    ]
                })
                .collect();
            self.put_star(
                &coordinates,
                &[Block::Loop(Table::new(
                    "",
                    &[
                        "rlnCoordinateX",
                        "rlnCoordinateY",
                        "rlnClassNumber",
                        "rlnAutopickFigureOfMerit",
                        "rlnAnglePsi",
                    ],
                    picks,
                ))],
            )?;
            rows.push(vec![
                Cell::Text(micrograph),
                Cell::Text(format!("{}/{coordinates}", self.directory)),
            ]);
        }
        let count = rows.len();
        self.put_star(
            "autopick.star",
            &[Block::Loop(Table::new(
                "coordinate_files",
                &["rlnMicrographName", "rlnMicrographCoordinates"],
                rows,
            ))],
        )?;
        Ok(vec![format!(
            " Picked {} particles from {count} micrographs",
            count * POSITIONS.len()
        )])
    }

    fn extract(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let input = self.input("micrographs")?;
        let blocks = self.read_star(input)?;
        let optics = &find(&blocks, "optics", input)?.table;
        let micrographs = &find(&blocks, "micrographs", input)?.table;
        let coordinates_input = self.input("coordinates")?;
        let coordinate_blocks = self.read_star(coordinates_input)?;
        let files = &find(&coordinate_blocks, "coordinate_files", coordinates_input)?.table;
        let mut coordinates_of = HashMap::new();
        for row in &files.rows {
            coordinates_of
                .entry(files.text(row, "rlnMicrographName")?)
                .or_insert(files.text(row, "rlnMicrographCoordinates")?);
        }
        let first = optics
            .rows
            .first()
            .ok_or_else(|| format!("{input} has no optics group"))?;
        let micrograph_angpix = optics.cell(first, "rlnMicrographPixelSize")?.number();
        let angpix = if options.flag("doRescale") {
            micrograph_angpix * (options.number("extractSize") / options.number("rescale"))
        } else {
            micrograph_angpix
        };
        let ctf_columns = [
            "rlnCtfMaxResolution",
            "rlnCtfFigureOfMerit",
            "rlnDefocusU",
            "rlnDefocusV",
            "rlnDefocusAngle",
        ];
        let mut rows = Vec::new();
        for micrograph_row in &micrographs.rows {
            let micrograph = micrographs.text(micrograph_row, "rlnMicrographName")?;
            let Some(coordinates) = coordinates_of.get(&micrograph) else {
                continue;
            };
            let pick_blocks = self.read_star(coordinates)?;
            let picks = &find(&pick_blocks, "", coordinates)?.table;
            let stack = format!("Movies/{}.mrcs", stem(&micrograph));
            let count = picks.rows.len();
            let data = image_stack(count, |index| 6.0 + (index % 3) as f64);
            self.put_mrc(&stack, (BOX, BOX, count), &data, angpix, true)?;
            for (index, pick) in picks.rows.iter().enumerate() {
                let mut row = vec![
                    picks.cell(pick, "rlnCoordinateX")?.clone(),
                    picks.cell(pick, "rlnCoordinateY")?.clone(),
                    picks.cell(pick, "rlnAutopickFigureOfMerit")?.clone(),
                    Cell::Num(0.0),
                    Cell::Num(-999.0),
                    Cell::Text(format!("{:06}@{dir}/{stack}", index + 1)),
                    Cell::Text(micrograph.clone()),
                    micrographs.cell(micrograph_row, "rlnOpticsGroup")?.clone(),
                ];
                for label in ctf_columns {
                    row.push(micrographs.cell(micrograph_row, label)?.clone());
                }
                row.extend([Cell::Num(0.0), Cell::Num(1.0), Cell::Num(0.0)]);
                rows.push(row);
            }
        }
        let mut columns = vec![
            "rlnCoordinateX",
            "rlnCoordinateY",
            "rlnAutopickFigureOfMerit",
            "rlnClassNumber",
            "rlnAnglePsi",
            "rlnImageName",
            "rlnMicrographName",
            "rlnOpticsGroup",
        ];
        columns.extend(ctf_columns);
        columns.extend(["rlnCtfBfactor", "rlnCtfScalefactor", "rlnPhaseShift"]);
        let count = rows.len();
        self.put_star(
            "particles.star",
            &[
                Block::Loop(optics.with_columns(
                    "optics",
                    vec![
                        constant("rlnImagePixelSize", angpix),
                        constant("rlnImageSize", BOX as f64),
                        constant("rlnImageDimensionality", 2.0),
                        constant("rlnCtfDataAreCtfPremultiplied", 0.0),
                    ],
                )),
                Block::Loop(Table::new("particles", &columns, rows)),
            ],
        )?;
        Ok(vec![format!(" Extracted {count} particles")])
    }

    fn read_particles(&self, reference: &str) -> Result<(Table, Table, f64), String> {
        let blocks = self.read_star(reference)?;
        let optics = find(&blocks, "optics", reference)?.table.clone();
        let particles = find(&blocks, "particles", reference)?.table.clone();
        let first = optics
            .rows
            .first()
            .ok_or_else(|| format!("{reference} has no optics group"))?;
        let angpix = optics.cell(first, "rlnImagePixelSize")?.number();
        Ok((optics, particles, angpix))
    }

    fn class2d(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let iteration = format!("{:03}", options.int("nrIterGrad"));
        let root = format!("{dir}/run_it{iteration}");
        let classes = options.int("nrClasses").max(1) as usize;
        let (optics, particles, angpix) = self.read_particles(self.input("particles")?)?;
        let mut entries = vec![
            computed("rlnClassNumber", move |_, index| {
                Cell::Num(((index % classes) + 1) as f64)
            }),
            computed("rlnAnglePsi", |_, index| Cell::Num(modulo(index, 37, 360))),
            constant("rlnOriginXAngst", 0.0),
            constant("rlnOriginYAngst", 0.0),
        ];
        entries.extend(stat_columns());
        entries.push(constant("rlnGroupNumber", 1.0));
        let data = particles.with_columns("particles", entries);
        self.put_star(
            &format!("run_it{iteration}_data.star"),
            &[
                Block::Loop(optics.renamed("optics")),
                Block::Loop(data.clone()),
            ],
        )?;
        let averages = image_stack(classes, |index| 4.0 + (index % 8) as f64);
        self.put_mrc(
            &format!("run_it{iteration}_classes.mrcs"),
            (BOX, BOX, classes),
            &averages,
            angpix,
            true,
        )?;
        let counts = class_counts(&data, classes)?;
        let total = data.rows.len().max(1) as f64;
        let class_rows = counts
            .iter()
            .enumerate()
            .map(|(index, count)| {
                vec![
                    Cell::Text(format!("{:06}@{root}_classes.mrcs", index + 1)),
                    Cell::Num(*count as f64 / total),
                    Cell::Num(2.0),
                    Cell::Num(1.0),
                    Cell::Num(8.0 + index as f64),
                    Cell::Num(1.0),
                ]
            })
            .collect();
        self.put_star(
            &format!("run_it{iteration}_model.star"),
            &[
                model_general(
                    2.0,
                    classes as f64,
                    angpix,
                    8.0,
                    vec![("rlnTau2FudgeFactor", Cell::Num(options.number("tauFudge")))],
                ),
                Block::Loop(Table::new(
                    "model_classes",
                    &[
                        "rlnReferenceImage",
                        "rlnClassDistribution",
                        "rlnAccuracyRotations",
                        "rlnAccuracyTranslationsAngst",
                        "rlnEstimatedResolution",
                        "rlnOverallFourierCompleteness",
                    ],
                    class_rows,
                )),
            ],
        )?;
        let iterations = options.number("nrIterGrad");
        self.put_star(
            &format!("run_it{iteration}_optimiser.star"),
            &[optimiser_general(
                format!("{dir}/run"),
                format!("{root}_model.star"),
                format!("{root}_data.star"),
                vec![
                    ("rlnCurrentIteration", Cell::Num(iterations)),
                    ("rlnNumberOfIterations", Cell::Num(iterations)),
                    ("rlnDoSplitRandomHalves", Cell::Num(0.0)),
                    (
                        "rlnParticleDiameter",
                        Cell::Num(options.number("particleDiameter")),
                    ),
                ],
            )],
        )?;
        Ok(vec![format!(
            " Classified {} particles into {classes} classes",
            data.rows.len()
        )])
    }

    fn select(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let number_of = |table: &Table, row: &[Cell]| -> Result<f64, String> {
            Ok(table.cell(row, "rlnClassNumber")?.number())
        };
        if options.text("mode") == "classes" {
            let input = self.input("particles")?;
            let blocks = self.read_star(input)?;
            let optics = &find(&blocks, "optics", input)?.table;
            let particles = &find(&blocks, "particles", input)?.table;
            let classes = options.ints("classes");
            let ranges = class_ranges(&classes);
            let mut runs: Vec<Vec<Vec<Cell>>> = Vec::new();
            for (from, to) in &ranges {
                let mut run = Vec::new();
                for row in &particles.rows {
                    let number = number_of(particles, row)?;
                    if number >= *from as f64 && number <= *to as f64 {
                        run.push(row.clone());
                    }
                }
                runs.push(run);
            }
            let with_rows = |rows: Vec<Vec<Cell>>| Table {
                rows,
                ..particles.renamed("particles")
            };
            if ranges.len() > 1 {
                for ((from, to), run) in ranges.iter().zip(&runs) {
                    self.put_star(
                        &format!("classes_{from:03}_{to:03}.star"),
                        &[
                            Block::Loop(optics.renamed("optics")),
                            Block::Loop(with_rows(run.clone())),
                        ],
                    )?;
                }
            }
            let selected: Vec<Vec<Cell>> = runs.into_iter().flatten().collect();
            let count = selected.len();
            self.put_star(
                "particles.star",
                &[
                    Block::Loop(optics.renamed("optics")),
                    Block::Loop(with_rows(selected)),
                ],
            )?;
            let listed: Vec<String> = classes.iter().map(i64::to_string).collect();
            return Ok(vec![format!(
                " Selected {count} particles from classes {}",
                listed.join(",")
            )]);
        }
        let input = self.input("optimiser")?;
        let optimiser_blocks = self.read_star(input)?;
        let optimiser = find(&optimiser_blocks, "optimiser_general", input)?;
        let model_path = optimiser
            .pair("rlnModelStarFile")
            .ok_or_else(|| format!("{input} has no rlnModelStarFile"))?;
        let data_path = optimiser
            .pair("rlnExperimentalDataStarFile")
            .ok_or_else(|| format!("{input} has no rlnExperimentalDataStarFile"))?;
        let model_blocks = self.read_star(model_path)?;
        let model = &find(&model_blocks, "model_classes", model_path)?.table;
        let data_blocks = self.read_star(data_path)?;
        let optics = &find(&data_blocks, "optics", data_path)?.table;
        let particles = &find(&data_blocks, "particles", data_path)?.table;
        let classes = model.rows.len();
        let counts = class_counts(particles, classes)?;
        let score = |index: usize| 1.0 - index as f64 / classes as f64;
        let min_score = options.number("minScore");
        let (min_classes, min_particles) = (options.int("minClasses"), options.int("minParticles"));
        let mut chosen: Vec<usize> = (0..classes)
            .filter(|index| score(*index) >= min_score)
            .collect();
        for index in 0..classes {
            let chosen_count: usize = chosen.iter().map(|chosen| counts[*chosen]).sum();
            let enough_classes = min_classes < 0 || chosen.len() as i64 >= min_classes;
            let enough_particles = min_particles < 0 || chosen_count as i64 >= min_particles;
            if enough_classes && enough_particles {
                break;
            }
            if !chosen.contains(&index) {
                chosen.push(index);
            }
        }
        let mut selected = Vec::new();
        for row in &particles.rows {
            let number = number_of(particles, row)?;
            if number >= 1.0 && chosen.contains(&(number as usize - 1)) {
                selected.push(row.clone());
            }
        }
        let count = selected.len();
        self.put_star(
            "particles.star",
            &[
                Block::Loop(optics.renamed("optics")),
                Block::Loop(Table {
                    rows: selected,
                    ..particles.renamed("particles")
                }),
            ],
        )?;
        let mut averages = Vec::new();
        for (index, row) in model.rows.iter().enumerate() {
            averages.push(vec![
                model.cell(row, "rlnReferenceImage")?.clone(),
                Cell::Num(score(index)),
                model.cell(row, "rlnClassDistribution")?.clone(),
                model.cell(row, "rlnEstimatedResolution")?.clone(),
            ]);
        }
        self.put_star(
            "class_averages.star",
            &[Block::Loop(Table::new(
                "",
                &[
                    "rlnReferenceImage",
                    "rlnClassScore",
                    "rlnClassDistribution",
                    "rlnEstimatedResolution",
                ],
                averages,
            ))],
        )?;
        let iteration = optimiser
            .pair("rlnCurrentIteration")
            .map_or(Cell::Num(0.0), Cell::from);
        self.put_star(
            "rank_optimiser.star",
            &[optimiser_general(
                format!("{dir}/rank"),
                model_path.to_string(),
                format!("{dir}/particles.star"),
                vec![("rlnCurrentIteration", iteration)],
            )],
        )?;
        Ok(vec![format!(
            " Selected {count} particles from {} classes with the class ranker",
            chosen.len()
        )])
    }

    fn initialmodel(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let iteration = format!("{:03}", options.int("nrIter"));
        let classes = options.int("nrClasses").max(1) as usize;
        let (optics, particles, angpix) = self.read_particles(self.input("particles")?)?;
        let data = particles.with_columns(
            "particles",
            vec![
                computed("rlnClassNumber", move |_, index| {
                    Cell::Num(((index % classes) + 1) as f64)
                }),
                computed("rlnAngleRot", |_, index| Cell::Num(modulo(index, 53, 360))),
                computed("rlnAngleTilt", |_, index| Cell::Num(modulo(index, 29, 180))),
                computed("rlnAnglePsi", |_, index| Cell::Num(modulo(index, 37, 360))),
                constant("rlnOriginXAngst", 0.0),
                constant("rlnOriginYAngst", 0.0),
            ],
        );
        self.put_star(
            &format!("run_it{iteration}_data.star"),
            &[
                Block::Loop(optics.renamed("optics")),
                Block::Loop(data.clone()),
            ],
        )?;
        let counts = class_counts(&data, classes)?;
        let total = data.rows.len().max(1) as f64;
        let mut references = Vec::new();
        for number in 1..=classes {
            let name = format!("run_it{iteration}_class{number:03}.mrc");
            self.put_volume(
                &name,
                &sphere(BOX, 8.0 + (number % 4) as f64, 2.0, 1.0),
                angpix,
            )?;
            references.push(format!("{dir}/{name}"));
        }
        let class_rows = references
            .iter()
            .zip(&counts)
            .map(|(reference, count)| {
                vec![
                    Cell::Text(reference.clone()),
                    Cell::Num(*count as f64 / total),
                    Cell::Num(5.0),
                    Cell::Num(2.0),
                    Cell::Num(12.0),
                ]
            })
            .collect();
        self.put_star(
            &format!("run_it{iteration}_model.star"),
            &[
                model_general(
                    3.0,
                    classes as f64,
                    angpix,
                    12.0,
                    vec![("rlnTau2FudgeFactor", Cell::Num(options.number("tauFudge")))],
                ),
                Block::Loop(Table::new(
                    "model_classes",
                    &[
                        "rlnReferenceImage",
                        "rlnClassDistribution",
                        "rlnAccuracyRotations",
                        "rlnAccuracyTranslationsAngst",
                        "rlnEstimatedResolution",
                    ],
                    class_rows,
                )),
            ],
        )?;
        let most = counts.iter().copied().max().unwrap_or(0);
        let largest = counts.iter().position(|count| *count == most).unwrap_or(0) + 1;
        self.put_volume(
            "initial_model.mrc",
            &sphere(BOX, 8.0 + (largest % 4) as f64, 2.0, 1.0),
            angpix,
        )?;
        Ok(vec![format!(
            " Wrote the initial model from class {largest}"
        )])
    }

    fn refine3d(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let dir = self.directory;
        let (optics, particles, angpix) = self.read_particles(self.input("particles")?)?;
        let resolution = fsc_resolution(angpix, 0.143);
        let mut entries = vec![
            computed("rlnAngleRot", |_, index| Cell::Num(modulo(index, 53, 360))),
            computed("rlnAngleTilt", |_, index| Cell::Num(modulo(index, 29, 180))),
            computed("rlnAnglePsi", |_, index| Cell::Num(modulo(index, 37, 360))),
            constant("rlnOriginXAngst", 0.0),
            constant("rlnOriginYAngst", 0.0),
            constant("rlnClassNumber", 1.0),
            computed("rlnRandomSubset", |_, index| {
                Cell::Num((index % 2 + 1) as f64)
            }),
        ];
        entries.extend(stat_columns());
        let data = particles.with_columns("particles", entries);
        self.put_star(
            "run_data.star",
            &[Block::Loop(optics.renamed("optics")), Block::Loop(data)],
        )?;
        self.put_volume("run_class001.mrc", &sphere(BOX, 10.0, 2.0, 1.0), angpix)?;
        self.put_volume(
            "run_half1_class001_unfil.mrc",
            &sphere(BOX, 10.0, 2.0, 0.99),
            angpix,
        )?;
        self.put_volume(
            "run_half2_class001_unfil.mrc",
            &sphere(BOX, 10.0, 2.0, 1.01),
            angpix,
        )?;
        self.put_star(
            "run_model.star",
            &[
                model_general(3.0, 1.0, angpix, resolution, Vec::new()),
                Block::Loop(Table::new(
                    "model_classes",
                    &[
                        "rlnReferenceImage",
                        "rlnClassDistribution",
                        "rlnAccuracyRotations",
                        "rlnAccuracyTranslationsAngst",
                        "rlnEstimatedResolution",
                    ],
                    vec![vec![
                        Cell::Text(format!("{dir}/run_class001.mrc")),
                        Cell::Num(1.0),
                        Cell::Num(1.0),
                        Cell::Num(0.5),
                        Cell::Num(resolution),
                    ]],
                )),
                Block::Loop(Table::new(
                    "model_class_1",
                    &[
                        "rlnSpectralIndex",
                        "rlnResolution",
                        "rlnAngstromResolution",
                        "rlnGoldStandardFsc",
                    ],
                    shell_rows(angpix, |shell| vec![synthetic_fsc(shell)]),
                )),
            ],
        )?;
        self.put_star(
            "run_optimiser.star",
            &[optimiser_general(
                format!("{dir}/run"),
                format!("{dir}/run_model.star"),
                format!("{dir}/run_data.star"),
                vec![
                    ("rlnCurrentIteration", Cell::Num(6.0)),
                    ("rlnDoSplitRandomHalves", Cell::Num(1.0)),
                    (
                        "rlnParticleDiameter",
                        Cell::Num(options.number("particleDiameter")),
                    ),
                ],
            )],
        )?;
        Ok(vec![format!(
            " Auto-refine: + Final reconstruction from all particles is saved as: {dir}/run_class001.mrc"
        )])
    }

    fn maskcreate(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let map = self.read_mrc(self.input("map")?)?;
        let angpix = if options.number("angpix") > 0.0 {
            options.number("angpix")
        } else {
            map.angpix
        };
        let n = map.nx.max(1) as usize;
        let edge = options.number("widthMaskEdge");
        let radius = (n as f64 / 2.0 - edge - 1.0).min(10.0 + options.number("extendInimask"));
        let data = sphere(n, radius.max(1.0), edge.max(1.0), 1.0);
        self.put_mrc("mask.mrc", (n, n, n), &data, angpix, false)?;
        Ok(vec![format!(" Wrote {}/mask.mrc", self.directory)])
    }

    fn postprocess(&self) -> Result<Vec<String>, String> {
        let options = self.validated;
        let (half1, half2) = half_maps(self.input("halfMap")?);
        let header = self.read_mrc(&half1)?;
        let angpix = if options.number("angpix") > 0.0 {
            options.number("angpix")
        } else {
            header.angpix
        };
        let resolution = fsc_resolution(angpix, 0.143);
        let bfactor = if options.flag("doAutoBfac") {
            -60.0
        } else if options.flag("doAdhocBfac") {
            options.number("adhocBfac")
        } else {
            0.0
        };
        let randomise_from = fsc_resolution(angpix, 0.8);
        let randomise_shell = BOX as f64 * angpix / randomise_from;
        self.put_volume("postprocess.mrc", &sphere(BOX, 10.0, 2.0, 1.0), angpix)?;
        self.put_volume(
            "postprocess_masked.mrc",
            &sphere(BOX, 10.0, 1.0, 1.0),
            angpix,
        )?;
        let fsc_rows = shell_rows(angpix, |shell| {
            let fsc = synthetic_fsc(shell);
            vec![
                fsc,
                fsc.powf(1.2),
                fsc,
                if shell < randomise_shell { fsc } else { 0.0 },
            ]
        });
        let guinier_rows = shell_rows(angpix, |_| Vec::new())
            .into_iter()
            .skip(1)
            .map(|row| {
                let frequency = row[1].number();
                let squared = frequency * frequency;
                vec![
                    Cell::Num(squared),
                    Cell::Num(-10.0 * squared),
                    Cell::Num(-10.0 * squared - 0.1),
                    Cell::Num(-10.0 * squared - (bfactor / 4.0) * squared),
                ]
            })
            .collect();
        self.put_star(
            "postprocess.star",
            &[
                pairs(
                    "general",
                    vec![
                        ("rlnFinalResolution", Cell::Num(resolution)),
                        ("rlnBfactorUsedForSharpening", Cell::Num(bfactor)),
                        ("rlnUnfilteredMapHalf1", Cell::Text(half1)),
                        ("rlnUnfilteredMapHalf2", Cell::Text(half2)),
                        ("rlnMaskName", Cell::from(self.input("mask")?)),
                        ("rlnRandomiseFrom", Cell::Num(randomise_from)),
                    ],
                ),
                Block::Loop(Table::new(
                    "fsc",
                    &[
                        "rlnSpectralIndex",
                        "rlnResolution",
                        "rlnAngstromResolution",
                        "rlnFourierShellCorrelationCorrected",
                        "rlnFourierShellCorrelationUnmaskedMaps",
                        "rlnFourierShellCorrelationMaskedMaps",
                        "rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps",
                    ],
                    fsc_rows,
                )),
                Block::Loop(Table::new(
                    "guinier",
                    &[
                        "rlnResolutionSquared",
                        "rlnLogAmplitudesOriginal",
                        "rlnLogAmplitudesWeighted",
                        "rlnLogAmplitudesSharpened",
                    ],
                    guinier_rows,
                )),
            ],
        )?;
        Ok(vec![format!(
            "  + FINAL RESOLUTION: {}",
            super::spec::relion_number(resolution)
        )])
    }
}

fn half_maps(path: &str) -> (String, String) {
    (
        path.replacen("half2", "half1", 1),
        path.replacen("half1", "half2", 1),
    )
}

fn header_of(path: &Path) -> Option<MrcHeader> {
    use std::io::Read;
    let mut bytes = Vec::with_capacity(mrc::HEADER_LEN);
    std::fs::File::open(path)
        .ok()?
        .take(mrc::HEADER_LEN as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    mrc::read_header(&bytes)
}

/// The reference check's state: STAR files already scanned, MRC headers read.
struct Checker<'a, 'b> {
    job: &'a Job<'b>,
    scanned: HashSet<PathBuf>,
    headers: HashMap<PathBuf, Option<MrcHeader>>,
}

impl Checker<'_, '_> {
    fn need(&self, reference: &str, from: &str) -> Result<PathBuf, String> {
        self.job
            .locate(reference)
            .map_err(|problem| format!("{from} references {reference}, which {problem}"))
    }

    fn require_mrc(&mut self, reference: &str, from: &str) -> Result<MrcHeader, String> {
        let path = self.need(reference, from)?;
        let header = *self
            .headers
            .entry(path.clone())
            .or_insert_with(|| header_of(&path));
        header.ok_or_else(|| format!("{from} references {reference}, which is not an MRC file"))
    }

    fn scan(&mut self, reference: &str, from: &str) -> Result<(), String> {
        let path = self.need(reference, from)?;
        if !self.scanned.insert(path.clone()) {
            return Ok(());
        }
        let blocks = std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| parse_star(&text))
            .map_err(|error| format!("{reference} is not a valid STAR file: {error}"))?;
        let mut values = Vec::new();
        for block in &blocks {
            for (label, value) in &block.pairs {
                if REFERENCE_LABELS.contains(&label.as_str()) {
                    values.push(value.clone());
                }
            }
            for (index, label) in block.table.columns.iter().enumerate() {
                if REFERENCE_LABELS.contains(&label.as_str()) {
                    for row in &block.table.rows {
                        if let Some(Cell::Text(value)) = row.get(index) {
                            values.push(value.clone());
                        }
                    }
                }
            }
        }
        for value in values {
            let (index, target) = parse_reference(&value);
            if let Some(index) = index {
                let header = self.require_mrc(target, reference)?;
                if index < 1 || index > header.nz.max(0) as u64 {
                    return Err(format!(
                        "{reference} references image {index} of {target}, which has {}",
                        header.nz
                    ));
                }
            } else if target.ends_with(".star") {
                self.scan(target, reference)?;
            } else {
                self.need(target, reference)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "simulate_tests.rs"]
mod tests;

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}
