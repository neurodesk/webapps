//! Builds the router and binds the listener.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::api::{self, AppState};
use crate::config::{ServeConfig, TlsMode};
use crate::jobs::JobStore;
use crate::{runner, tools, www};

/// A running server.
pub struct Running {
    /// The bound address.
    pub addr: SocketAddr,
    /// The job store (for tests and shutdown).
    pub store: Arc<JobStore>,
    handle: JoinHandle<io::Result<()>>,
    shutdown: CancellationToken,
    _data_lock: std::fs::File,
}

impl Running {
    /// Base URL of the API.
    pub fn base_url(&self, scheme: &str) -> String {
        format!("{scheme}://{}", self.addr)
    }

    /// Stops the listener and active jobs; retains finished results.
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
pub fn app(config: Arc<ServeConfig>, store: Arc<JobStore>) -> io::Result<Router> {
    let state = AppState {
        sessions: Arc::new(crate::auth::Sessions::load(&config.data_dir)?),
        submissions: Arc::new(api::SubmissionLocks::default()),
        config: config.clone(),
        store,
        tools: Arc::new(
            tools::registry()
                .into_iter()
                .filter(|tool| {
                    tool.id() != "sct"
                        || matches!(
                            config.runner,
                            crate::config::RunnerKind::Docker | crate::config::RunnerKind::Simulate
                        )
                })
                .collect(),
        ),
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

/// Creates the job store and workers for a configuration.
pub fn store(config: &ServeConfig) -> io::Result<Arc<JobStore>> {
    let runner = runner::build(config);
    let simulated = config.runner == crate::config::RunnerKind::Simulate;
    let store = JobStore::new(runner, simulated, config.cpu, config.retain);
    store.recover(&config.data_dir.join("jobs"))?;
    store.spawn_workers(config.parallel, config.sweep_interval);
    Ok(store)
}

/// Binds the listener and starts serving. Self-signed certificates must be
/// generated beforehand (`TlsMode::Site` with the generated files).
pub async fn start(config: ServeConfig) -> io::Result<Running> {
    if config.parallel != 1 && config.runner != crate::config::RunnerKind::Simulate {
        return Err(io::Error::other(
            "production runners require --parallel 1 until per-job GPU allocation is supported",
        ));
    }
    std::fs::create_dir_all(config.data_dir.join("jobs"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config.data_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let data_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(config.data_dir.join("server.lock"))?;
    data_lock
        .try_lock()
        .map_err(|error| io::Error::other(format!("data directory already in use: {error}")))?;
    let config = Arc::new(config);
    let store = store(&config)?;
    let app = app(config.clone(), store.clone())?;
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
        _data_lock: data_lock,
    })
}
