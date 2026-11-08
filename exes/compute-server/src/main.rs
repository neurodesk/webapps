//! Command-line entry point of `neurodesk-compute`.

use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use compute_server::config::{GpuInfo, RunnerKind, ServeConfig, TlsMode};
use compute_server::profiles::Profiles;
use compute_server::roots::DataRoot;
use compute_server::runner::slurm::{probe, SlurmConfig, SlurmSettings, SlurmTimings};
use compute_server::{
    detect, instance, server, tls, www, NESVOR_DOCKER_IMAGE, NESVOR_SIMG_NAME, NESVOR_SIMG_URL,
};
use rand::RngCore;

/// Token-protected compute server for Neurodesk webapps.
#[derive(Debug, Parser)]
#[command(name = "neurodesk-compute", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the server (the default when no subcommand is given).
    Serve(ServeArgs),
    /// Check runners, GPU, image and print the URLs and token.
    Doctor(ServeArgs),
    /// Fetch the pinned container image for the selected runner.
    Pull(ServeArgs),
    /// Remove a stale instance lock after confirming its server is stopped.
    Unlock(UnlockArgs),
    /// Submit a probe job that checks a profile's compute nodes.
    CheckSlurm(CheckSlurmArgs),
    /// Download a pinned example dataset to serve as a data root.
    FetchExample(FetchExampleArgs),
    /// Download the pinned Apptainer image a Slurm-run tool needs (relion).
    FetchImage(FetchExampleArgs),
}

/// Flags of `fetch-example`.
#[derive(Debug, Clone, Args)]
struct FetchExampleArgs {
    /// Example (relion-tutorial) or image (relion) to download.
    name: String,
    /// Directory that receives <name>/ (for an example, serve it with --data-root examples=<dest>).
    #[arg(long)]
    dest: PathBuf,
}

/// Flags of `unlock`.
#[derive(Debug, Clone, Args)]
struct UnlockArgs {
    /// Data directory of the stopped server (default: platform data dir).
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

/// Flags of `check-slurm`.
#[derive(Debug, Clone, Args)]
struct CheckSlurmArgs {
    /// Slurm runner configuration (JSON).
    #[arg(long)]
    slurm_config: PathBuf,
    /// Profile whose nodes are checked.
    #[arg(long)]
    profile: String,
    /// Read-only data root, id=/path (repeatable).
    #[arg(long = "data-root")]
    data_root: Vec<String>,
    /// Data directory whose projects directory jobs write (default: platform data dir).
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// How long to wait for the probe job, queue time included.
    #[arg(long, default_value = "1h")]
    timeout: String,
}

/// Flags of `serve` (also accepted by `doctor` and `pull`).
#[derive(Debug, Clone, Args)]
struct ServeArgs {
    /// Socket address to listen on.
    #[arg(long, default_value = "0.0.0.0:8765")]
    listen: String,
    /// Pairing code (default: read or generate <data-dir>/token).
    #[arg(long, env = "NEURODESK_COMPUTE_TOKEN")]
    token: Option<String>,
    /// Directory for jobs, token and TLS material (default: platform data dir).
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Runner: docker, apptainer, native or simulate (default: auto-detect).
    #[arg(long)]
    runner: Option<String>,
    /// Docker image reference or path to the apptainer .simg file.
    #[arg(long)]
    image: Option<String>,
    /// Run the tool on the CPU (no GPU passthrough, --device -1).
    #[arg(long)]
    cpu: bool,
    /// Number of jobs that run at the same time.
    #[arg(long, default_value_t = 1)]
    parallel: usize,
    /// How long finished jobs are kept (e.g. 1h, 30m).
    #[arg(long, default_value = "1h")]
    retain: String,
    /// Additional origin allowed by CORS (repeatable).
    #[arg(long = "allow-origin")]
    allow_origin: Vec<String>,
    /// Site certificate (PEM); requires --tls-key.
    #[arg(long, requires = "tls_key")]
    tls_cert: Option<PathBuf>,
    /// Site private key (PEM); requires --tls-cert.
    #[arg(long, requires = "tls_cert")]
    tls_key: Option<PathBuf>,
    /// Serve plain HTTP instead of TLS.
    #[arg(long, conflicts_with = "tls_cert")]
    insecure_http: bool,
    /// Directory of static files served at / (default: www beside the executable).
    #[arg(long)]
    www: Option<PathBuf>,
    /// Maximum request body size in bytes.
    #[arg(long, default_value_t = 4 * 1024 * 1024 * 1024)]
    max_upload_bytes: u64,
    /// Maximum number of file parts per job.
    #[arg(long, default_value_t = 40)]
    max_files: usize,
    /// Map every pairing to one owner; enables projects and data roots.
    #[arg(long)]
    single_owner: bool,
    /// Read-only data root, id=/path (repeatable; single-owner mode).
    #[arg(long = "data-root")]
    data_root: Vec<String>,
    /// Project outputs above this many bytes are listed but not downloadable.
    #[arg(long, default_value_t = compute_server::config::DEFAULT_MAX_DOWNLOAD_BYTES)]
    max_download_bytes: u64,
    /// Slurm runner configuration (JSON): apptainer, image, scratch, profiles.
    #[arg(long)]
    slurm_config: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=warn")),
        )
        .with_target(false)
        .init();
    let cli = Cli::parse();
    let result = match cli.command {
        None => serve(cli.serve).await,
        Some(Command::Serve(args)) => serve(args).await,
        Some(Command::Doctor(args)) => doctor(args).await,
        Some(Command::Pull(args)) => pull(args).await,
        Some(Command::Unlock(args)) => unlock(args),
        Some(Command::CheckSlurm(args)) => check_slurm(args).await,
        Some(Command::FetchExample(args)) => fetch_example(args, false).await,
        Some(Command::FetchImage(args)) => fetch_example(args, true).await,
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

/// `fetch-example` and `fetch-image`: the same pinned, resumable download.
async fn fetch_example(args: FetchExampleArgs, image: bool) -> Result<(), String> {
    use compute_server::examples::{self, Progress};
    let known = if image {
        examples::images()
    } else {
        examples::examples()
    };
    let kind = if image { "image" } else { "example" };
    let example = known
        .iter()
        .find(|example| example.name == args.name)
        .ok_or_else(|| {
            let names: Vec<&str> = known.iter().map(|example| example.name.as_str()).collect();
            format!(
                "unknown {kind} '{}'; known: {}",
                args.name,
                names.join(", ")
            )
        })?;
    std::fs::create_dir_all(&args.dest)
        .map_err(|error| format!("{}: {error}", args.dest.display()))?;
    let dest = args
        .dest
        .canonicalize()
        .map_err(|error| format!("{}: {error}", args.dest.display()))?;
    eprintln!(
        "Fetching {} ({} files, {}) from {}/{} at {} into {}",
        example.name,
        example.files.len(),
        examples::size(example.bytes()),
        examples::HUGGING_FACE_DATASETS,
        example.repository,
        example.revision,
        dest.join(&example.name).display()
    );
    let sizes: std::collections::HashMap<String, u64> = example
        .files
        .iter()
        .map(|file| (file.path.clone(), file.bytes))
        .collect();
    let mut report = |event: Progress| match event {
        Progress::Verified { path } => eprintln!("  verified    {path}"),
        Progress::Downloading {
            path,
            offset,
            bytes,
        } if offset > 0 => eprintln!(
            "  resuming    {path} at {} of {}",
            examples::size(offset),
            examples::size(bytes)
        ),
        Progress::Downloading { path, bytes, .. } => {
            eprintln!("  downloading {path} ({})", examples::size(bytes))
        }
        Progress::Retrying { path, error } => eprintln!("  retrying    {path}: {error}"),
        Progress::Done { path } => eprintln!(
            "  done        {path} ({}, SHA-256 verified)",
            examples::size(sizes.get(&path).copied().unwrap_or(0))
        ),
    };
    let root = examples::fetch(example, &dest, examples::HUGGING_FACE_DATASETS, &mut report)
        .await
        .map_err(|error| error.to_string())?;
    println!("{} is ready in {}.", example.name, root.display());
    if image {
        for file in &example.files {
            println!("Image: {}", root.join(&file.path).display());
        }
        println!("Then {}.", example.usage);
        return Ok(());
    }
    println!("Serve it as a data root with:");
    println!("  --data-root examples={}", dest.display());
    println!("Then {}.", example.usage);
    Ok(())
}

fn default_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("neurodesk-compute")
}

/// Whether `--token` was given as a command-line argument (clap merges it
/// with `NEURODESK_COMPUTE_TOKEN`, so the raw arguments are inspected).
fn token_on_command_line(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    arguments.into_iter().any(|argument| {
        let argument = argument.to_string_lossy();
        argument == "--token" || argument.starts_with("--token=")
    })
}

/// In single-owner mode the pairing code file must be readable by its owner only.
fn require_private(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(format!(
                    "{} is readable by other users; run chmod 600 on it",
                    path.display()
                ));
            }
        }
    }
    let _ = path;
    Ok(())
}

fn load_or_create_token(data_dir: &std::path::Path) -> Result<String, String> {
    let path = data_dir.join("token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("cannot create {}: {error}", data_dir.display()))?;
    tls::write_private(&path, token.as_bytes())
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(token)
}

/// Runner selection and image defaults shared by all subcommands.
struct Resolved {
    config: ServeConfig,
    self_signed: bool,
}

async fn resolve(args: &ServeArgs, need_listener: bool) -> Result<Resolved, String> {
    let data_dir = args.data_dir.clone().unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("cannot create {}: {error}", data_dir.display()))?;
    if args.single_owner && token_on_command_line(std::env::args_os()) {
        return Err(
            "--single-owner refuses --token on the command line, where other users can read it; use <data-dir>/token (mode 0600) or NEURODESK_COMPUTE_TOKEN"
                .to_string(),
        );
    }
    let token = match &args.token {
        Some(token) if !token.is_empty() => token.clone(),
        _ => {
            let token = load_or_create_token(&data_dir)?;
            if args.single_owner {
                require_private(&data_dir.join("token"))?;
            }
            token
        }
    };
    let runner = match &args.runner {
        Some(value) => RunnerKind::parse(value).ok_or_else(|| {
            format!("unknown runner '{value}' (docker, apptainer, native, simulate, slurm)")
        })?,
        None => detect::auto_detect().await.ok_or_else(|| {
            "no runner found: install docker, apptainer or nesvor, or pass --runner simulate"
                .to_string()
        })?,
    };
    let image = match (&args.image, runner) {
        (Some(image), _) => image.clone(),
        (None, RunnerKind::Apptainer) => data_dir.join(NESVOR_SIMG_NAME).display().to_string(),
        (None, _) => NESVOR_DOCKER_IMAGE.to_string(),
    };
    let retain = humantime::parse_duration(&args.retain)
        .map_err(|error| format!("invalid --retain '{}': {error}", args.retain))?;
    let gpu = if matches!(runner, RunnerKind::Simulate | RunnerKind::Slurm) || args.cpu {
        GpuInfo::default()
    } else {
        detect::host_gpu().await
    };
    let www = args.www.clone().or_else(www::default_www_dir);
    let data_roots = args
        .data_root
        .iter()
        .map(|argument| DataRoot::parse(argument))
        .collect::<Result<Vec<_>, _>>()?;
    let slurm_config = args
        .slurm_config
        .as_deref()
        .map(SlurmConfig::load)
        .transpose()?;
    let profiles = slurm_config
        .as_ref()
        .map(|config| config.profiles.clone())
        .unwrap_or_else(Profiles::local);
    let slurm = match (runner, slurm_config) {
        (RunnerKind::Slurm, Some(config)) => Some(SlurmSettings {
            config,
            timings: SlurmTimings::default(),
            path: None,
            user: current_user().await?,
        }),
        _ => None,
    };

    let mut self_signed = false;
    let tls_mode = if args.insecure_http {
        TlsMode::Insecure
    } else if let (Some(cert), Some(key)) = (&args.tls_cert, &args.tls_key) {
        TlsMode::Site {
            cert: cert.clone(),
            key: key.clone(),
        }
    } else if need_listener {
        self_signed = true;
        let mut dns_names = vec!["localhost".to_string()];
        if let Some(hostname) = detect::hostname() {
            dns_names.push(hostname);
        }
        let ips: Vec<IpAddr> = detect::local_ipv4_addresses()
            .into_iter()
            .map(IpAddr::V4)
            .collect();
        let files = tls::load_or_create_self_signed(&data_dir, &dns_names, &ips)
            .map_err(|error| format!("cannot create self-signed certificate: {error}"))?;
        TlsMode::Site {
            cert: files.cert,
            key: files.key,
        }
    } else {
        self_signed = true;
        TlsMode::SelfSigned
    };

    Ok(Resolved {
        config: ServeConfig {
            listen: args.listen.clone(),
            token,
            data_dir,
            runner,
            image,
            cpu: args.cpu,
            parallel: args.parallel.max(1),
            retain,
            allow_origins: args.allow_origin.clone(),
            tls: tls_mode,
            www,
            max_upload_bytes: args.max_upload_bytes,
            max_files: args.max_files,
            gpu,
            sweep_interval: Duration::from_secs(30),
            single_owner: args.single_owner,
            session_idle: compute_server::auth::SESSION_IDLE,
            data_roots,
            max_download_bytes: args.max_download_bytes,
            profiles,
            slurm,
        },
        self_signed,
    })
}

/// The Unix user the server runs as, for `sacct -u`.
async fn current_user() -> Result<String, String> {
    if let Ok(user) = std::env::var("USER") {
        if !user.is_empty() {
            return Ok(user);
        }
    }
    let probe = detect::probe("id", &["-un"], Duration::from_secs(10)).await;
    if probe.ok && !probe.output.is_empty() {
        Ok(probe.output)
    } else {
        Err("cannot determine the current user (USER is unset and id -un failed)".into())
    }
}

fn listening_urls(config: &ServeConfig, port: u16) -> Vec<String> {
    let scheme = config.scheme();
    let bound: Option<std::net::SocketAddr> = config.listen.parse().ok();
    match bound {
        Some(addr) if !addr.ip().is_unspecified() => {
            vec![format!("{scheme}://{}:{port}", addr.ip())]
        }
        _ => detect::local_ipv4_addresses()
            .into_iter()
            .map(|ip| format!("{scheme}://{ip}:{port}"))
            .collect(),
    }
}

async fn serve(args: ServeArgs) -> Result<(), String> {
    let resolved = resolve(&args, true).await?;
    let config = resolved.config;
    let running = server::start(config.clone())
        .await
        .map_err(|error| format!("cannot start server: {error}"))?;
    let port = running.addr.port();

    println!("neurodesk-compute {}", compute_server::VERSION);
    println!("listening on:");
    for url in listening_urls(&config, port) {
        println!("  {url}");
    }
    println!("pair code: {}", config.token);
    println!("runner:    {}", config.runner.id());
    match &config.slurm {
        Some(slurm) => println!("image:     {}", slurm.config.image.display()),
        None => println!("image:     {}", config.image),
    }
    println!("data dir:  {}", config.data_dir.display());
    match (&config.gpu.available, &config.gpu.name) {
        (true, Some(name)) => println!("gpu:       {name}"),
        (true, None) => println!("gpu:       available"),
        (false, _) if config.cpu => println!("gpu:       disabled (--cpu)"),
        (false, _) if config.runner == RunnerKind::Slurm => {
            println!("gpu:       per profile on the compute nodes")
        }
        (false, _) => println!("gpu:       not detected (nvidia-smi absent or failed)"),
    }
    if config.runner == RunnerKind::Simulate {
        println!("mode:      SIMULATED - results are placeholders, not reconstructions");
    }
    if config.single_owner {
        println!("owner:     single (every pairing sees the same projects)");
        for root in &config.data_roots {
            println!("data root: {} = {}", root.id, root.path.display());
        }
    }
    match &config.tls {
        TlsMode::Insecure => println!("tls:       off (--insecure-http); use site-trusted HTTPS for supported clinical connections"),
        TlsMode::Site { .. } if resolved.self_signed => {
            println!("tls:       self-signed certificate ({})", config.data_dir.join("cert.pem").display());
            println!("           Open this URL once in the browser and accept the certificate before connecting from webapps.neurodesk.org");
        }
        TlsMode::Site { cert, .. } => println!("tls:       site certificate {}", cert.display()),
        TlsMode::SelfSigned => {}
    }
    if let Some(dir) = &config.www {
        println!("www:       {}", dir.display());
    }
    if config.runner == RunnerKind::Slurm {
        println!(
            "press Ctrl+C to stop; Slurm jobs keep running and are re-attached at the next start"
        );
    } else {
        println!(
            "press Ctrl+C to stop; active jobs stop at shutdown; results remain until retention expiry"
        );
    }

    wait_for_shutdown().await;
    println!("shutting down");
    running.shutdown().await;
    Ok(())
}

async fn wait_for_shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = ctrl_c.await;
                    return;
                }
            };
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}

async fn doctor(args: ServeArgs) -> Result<(), String> {
    let mut ok = true;
    let report = |label: &str, good: bool, detail: &str| {
        println!("[{}] {label}: {detail}", if good { "ok" } else { "--" });
    };

    let docker_present = detect::which("docker").is_some();
    report(
        "docker on PATH",
        docker_present,
        if docker_present { "yes" } else { "no" },
    );
    let mut docker_ok = false;
    if docker_present {
        let info = detect::docker_info().await;
        docker_ok = info.ok;
        report(
            "docker info",
            info.ok,
            if info.ok {
                "daemon reachable"
            } else {
                info.output.lines().last().unwrap_or("failed")
            },
        );
        if info.ok {
            let nvidia = detect::docker_has_nvidia_runtime(&info.output);
            report(
                "nvidia container runtime",
                nvidia,
                if nvidia {
                    "present"
                } else {
                    "not listed in docker info (install nvidia-container-toolkit)"
                },
            );
        }
    }
    let gpu = detect::host_gpu().await;
    report(
        "nvidia-smi on host",
        gpu.available,
        gpu.name.as_deref().unwrap_or(if gpu.available {
            "GPU present"
        } else {
            "not found"
        }),
    );
    let apptainer_present =
        detect::which("apptainer").is_some() || detect::which("singularity").is_some();
    report(
        "apptainer on PATH",
        apptainer_present,
        if apptainer_present { "yes" } else { "no" },
    );
    let nesvor_present = detect::which("nesvor").is_some();
    report(
        "nesvor on PATH",
        nesvor_present,
        if nesvor_present { "yes" } else { "no" },
    );

    let resolved = match resolve(&args, false).await {
        Ok(resolved) => resolved,
        Err(message) => {
            report("runner", false, &message);
            return Err("no usable runner".to_string());
        }
    };
    let config = resolved.config;
    report("runner", true, config.runner.id());
    match config.runner {
        RunnerKind::Docker => {
            let present = docker_ok && detect::docker_image_present(&config.image).await;
            ok &= present;
            report(
                "image",
                present,
                &format!(
                    "{} ({})",
                    config.image,
                    if present {
                        "present"
                    } else {
                        "missing; run neurodesk-compute pull"
                    }
                ),
            );
        }
        RunnerKind::Apptainer => {
            let present = detect::simg_present(std::path::Path::new(&config.image));
            ok &= present;
            report(
                "image",
                present,
                &format!(
                    "{} ({})",
                    config.image,
                    if present {
                        "present"
                    } else {
                        "missing; run neurodesk-compute pull"
                    }
                ),
            );
        }
        RunnerKind::Native => {
            ok &= nesvor_present;
            report("image", nesvor_present, "native nesvor on PATH");
        }
        RunnerKind::Simulate => report("image", true, "not needed (simulated)"),
        RunnerKind::Slurm => report(
            "image",
            true,
            "checked at startup; run neurodesk-compute check-slurm per profile",
        ),
    }
    let port: u16 = config
        .listen
        .parse::<std::net::SocketAddr>()
        .map(|addr| addr.port())
        .unwrap_or(8765);
    println!("urls:");
    for url in listening_urls(&config, port) {
        println!("  {url}");
    }
    println!("pair code: {}", config.token);
    println!("data dir: {}", config.data_dir.display());
    if ok {
        Ok(())
    } else {
        Err("doctor found problems".to_string())
    }
}

async fn pull(args: ServeArgs) -> Result<(), String> {
    let resolved = resolve(&args, false).await?;
    let config = resolved.config;
    let status = match config.runner {
        RunnerKind::Docker => {
            println!("docker pull {}", config.image);
            tokio::process::Command::new("docker")
                .args(["pull", &config.image])
                .status()
                .await
        }
        RunnerKind::Apptainer => {
            println!("apptainer pull {} {}", config.image, NESVOR_SIMG_URL);
            tokio::process::Command::new("apptainer")
                .args(["pull", &config.image, NESVOR_SIMG_URL])
                .status()
                .await
        }
        RunnerKind::Native | RunnerKind::Simulate | RunnerKind::Slurm => {
            println!("nothing to pull for runner '{}'", config.runner.id());
            return Ok(());
        }
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("pull exited with {status}")),
        Err(error) => Err(format!("cannot run pull: {error}")),
    }
}

fn unlock(args: UnlockArgs) -> Result<(), String> {
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    let message = instance::unlock(&data_dir)?;
    println!("{message}");
    Ok(())
}

async fn check_slurm(args: CheckSlurmArgs) -> Result<(), String> {
    let data_dir = args.data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("cannot create {}: {error}", data_dir.display()))?;
    let roots = args
        .data_root
        .iter()
        .map(|argument| DataRoot::parse(argument))
        .collect::<Result<Vec<_>, _>>()?;
    let timeout = humantime::parse_duration(&args.timeout)
        .map_err(|error| format!("invalid --timeout '{}': {error}", args.timeout))?;
    let settings = SlurmSettings {
        config: SlurmConfig::load(&args.slurm_config)?,
        timings: SlurmTimings::default(),
        path: None,
        user: current_user().await?,
    };
    let report = probe::check(&settings, &data_dir, &roots, &args.profile, timeout).await?;
    print!("{}", report.render());
    if report.passed() {
        Ok(())
    } else {
        Err("check-slurm found problems".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_token_on_the_command_line() {
        let arguments = |words: &[&str]| -> Vec<std::ffi::OsString> {
            words.iter().map(std::ffi::OsString::from).collect()
        };
        assert!(token_on_command_line(arguments(&[
            "nc", "serve", "--token", "x"
        ])));
        assert!(token_on_command_line(arguments(&["nc", "--token=x"])));
        assert!(!token_on_command_line(arguments(&[
            "nc",
            "serve",
            "--single-owner"
        ])));
        assert!(!token_on_command_line(arguments(&["nc", "--tokens"])));
    }

    #[test]
    fn single_owner_refuses_a_world_readable_token_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "code").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(require_private(&path).unwrap_err().contains("chmod 600"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(require_private(&path).is_ok());
    }

    #[test]
    fn parses_the_new_flags() {
        let cli = Cli::parse_from([
            "neurodesk-compute",
            "serve",
            "--single-owner",
            "--data-root",
            "facility=/scratch",
            "--data-root",
            "examples=/data/examples",
            "--max-download-bytes",
            "1024",
            "--slurm-config",
            "/etc/nd/slurm.json",
            "--runner",
            "slurm",
        ]);
        let Some(Command::Serve(args)) = cli.command else {
            panic!("serve");
        };
        assert!(args.single_owner);
        assert_eq!(args.data_root.len(), 2);
        assert_eq!(args.max_download_bytes, 1024);
        let cli = Cli::parse_from(["neurodesk-compute", "unlock", "--data-dir", "/d"]);
        assert!(matches!(cli.command, Some(Command::Unlock(_))));
        let cli = Cli::parse_from([
            "neurodesk-compute",
            "check-slurm",
            "--slurm-config",
            "/c.json",
            "--profile",
            "gpu-4",
        ]);
        assert!(matches!(cli.command, Some(Command::CheckSlurm(_))));
        let cli = Cli::parse_from([
            "neurodesk-compute",
            "fetch-example",
            "relion-tutorial",
            "--dest",
            "/scratch/examples",
        ]);
        let Some(Command::FetchExample(args)) = cli.command else {
            panic!("fetch-example");
        };
        assert_eq!(args.name, "relion-tutorial");
        assert_eq!(args.dest, PathBuf::from("/scratch/examples"));
    }
}
