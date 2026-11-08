//! Builds the router and binds the listener.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::api::{self, AppState};
use crate::config::{RunnerKind, ServeConfig, TlsMode};
use crate::jobs::{JobStore, StoreOptions};
use crate::tools::{Layout, Tool};
use crate::{runner, tools, www};

/// A running server.
pub struct Running {
    /// The bound address.
    pub addr: SocketAddr,
    /// The job store (for tests and shutdown).
    pub store: Arc<JobStore>,
    handle: JoinHandle<io::Result<()>>,
    shutdown: CancellationToken,
    _locks: crate::instance::Locks,
}

impl Running {
    /// Base URL of the API.
    pub fn base_url(&self, scheme: &str) -> String {
        format!("{scheme}://{}", self.addr)
    }

    /// Stops the listener and local runners' active jobs (a Slurm runner
    /// detaches); retains finished results.
    pub async fn shutdown(mut self) {
        self.shutdown.cancel();
        self.store.shutdown().await;
        if tokio::time::timeout(std::time::Duration::from_secs(2), &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
        }
    }
}

/// Builds the complete application router.
pub fn app(
    config: Arc<ServeConfig>,
    store: Arc<JobStore>,
    tools: Vec<Arc<dyn Tool>>,
) -> io::Result<Router> {
    let policy = crate::auth::SessionPolicy {
        single_owner: config.single_owner,
        idle: config.session_idle,
    };
    let state = AppState {
        sessions: Arc::new(crate::auth::Sessions::load(&config.data_dir, policy)?),
        submissions: Arc::new(api::SubmissionLocks::default()),
        config: config.clone(),
        store,
        tools: Arc::new(tools),
    };
    let www_router = match &config.www {
        Some(dir) => www::router(dir),
        None => www::placeholder_router(),
    };
    Ok(Router::new()
        .nest("/api/v1", api::router(state))
        .merge(www_router)
        .layer(tower_http::trace::TraceLayer::new_for_http()))
}

/// Creates the job store for a configuration, recovers it and starts it.
pub fn store(config: &ServeConfig, tools: Vec<Arc<dyn Tool>>) -> io::Result<Arc<JobStore>> {
    let runner = runner::build(config)?;
    let options = StoreOptions {
        simulated: config.runner == RunnerKind::Simulate,
        cpu: config.cpu,
        retain: config.retain,
        parallel: config.parallel,
        data_dir: config.data_dir.clone(),
        max_download_bytes: config.max_download_bytes,
        profiles: config.profiles.clone(),
    };
    let store = JobStore::new(runner, tools, options);
    store.recover()?;
    store.start(config.sweep_interval);
    Ok(store)
}

/// Refuses combinations of settings the protocol does not allow.
pub fn validate(config: &ServeConfig) -> io::Result<()> {
    let refuse = |message: &str| Err(io::Error::other(message.to_string()));
    let slurm = config.runner == RunnerKind::Slurm;
    if config.parallel != 1 && !matches!(config.runner, RunnerKind::Simulate | RunnerKind::Slurm) {
        return refuse(
            "production runners require --parallel 1 until per-job GPU allocation is supported",
        );
    }
    if !config.single_owner && !config.data_roots.is_empty() {
        return refuse("--data-root requires --single-owner");
    }
    if slurm && !config.single_owner {
        return refuse("--runner slurm requires --single-owner");
    }
    if slurm && config.slurm.is_none() {
        return refuse("--runner slurm requires --slurm-config");
    }
    if slurm && !is_loopback(&config.listen) {
        return refuse("--runner slurm listens on loopback only (--listen 127.0.0.1:<port>); reach it through an SSH tunnel");
    }
    let mut ids: Vec<&str> = config
        .data_roots
        .iter()
        .map(|root| root.id.as_str())
        .collect();
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return refuse("data root ids must be unique");
    }
    Ok(())
}

fn is_loopback(listen: &str) -> bool {
    listen
        .parse::<std::net::SocketAddr>()
        .is_ok_and(|addr| addr.ip().is_loopback())
}

/// Binds the listener and starts serving the registered tools available to
/// this configuration. Self-signed certificates must be generated beforehand
/// (`TlsMode::Site` with the generated files).
pub async fn start(config: ServeConfig) -> io::Result<Running> {
    let tools = tools::available(&config, tools::registry());
    start_with_tools(config, tools).await
}

/// [`start`] with an explicit tool list.
pub async fn start_with_tools(
    config: ServeConfig,
    tools: Vec<Arc<dyn Tool>>,
) -> io::Result<Running> {
    validate(&config)?;
    for tool in &tools {
        if let Layout::Project(project_tool) = tool.layout() {
            project_tool
                .check_profiles(&config.profiles)
                .map_err(|error| io::Error::other(format!("{}: {error}", tool.id())))?;
        }
    }
    std::fs::create_dir_all(config.data_dir.join("jobs"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config.data_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let locks = crate::instance::acquire(&config.data_dir, config.runner == RunnerKind::Slurm)?;
    if let Some(settings) = &config.slurm {
        crate::runner::slurm::checks::startup(settings, &config.data_dir, &config.data_roots)
            .await
            .map_err(io::Error::other)?;
    }
    let config = Arc::new(config);
    let store = store(&config, tools.clone())?;
    let app = app(config.clone(), store.clone(), tools)?;
    let shutdown = CancellationToken::new();

    let std_listener = std::net::TcpListener::bind(&config.listen)?;
    std_listener.set_nonblocking(true)?;
    let addr = std_listener.local_addr()?;

    let handle: JoinHandle<io::Result<()>> = match &config.tls {
        TlsMode::Insecure => {
            let listener = tokio::net::TcpListener::from_std(std_listener)?;
            let token = shutdown.clone();
            tokio::spawn(async move {
                axum::serve(listener, app)
                    .with_graceful_shutdown(async move { token.cancelled().await })
                    .await
            })
        }
        TlsMode::Site { cert, key } => {
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
            let server_handle = axum_server::Handle::new();
            let token = shutdown.clone();
            let stopper = server_handle.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                stopper.graceful_shutdown(Some(std::time::Duration::from_secs(2)));
            });
            let server = axum_server::from_tcp_rustls(std_listener, tls)?;
            tokio::spawn(async move {
                server
                    .handle(server_handle)
                    .serve(app.into_make_service())
                    .await
            })
        }
        TlsMode::SelfSigned => {
            return Err(io::Error::other(
                "self-signed certificates must be generated before start",
            ));
        }
    };

    Ok(Running {
        addr,
        store,
        handle,
        shutdown,
        _locks: locks,
    })
}
