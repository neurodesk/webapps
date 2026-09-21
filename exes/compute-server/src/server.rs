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
}

impl Running {
    /// Base URL of the API.
    pub fn base_url(&self, scheme: &str) -> String {
        format!("{scheme}://{}", self.addr)
    }

    /// Stops the listener, cancels every job and removes all job directories.
    pub async fn shutdown(self) {
        self.store.shutdown().await;
        self.shutdown.cancel();
        let _ = self.handle.await;
    }
}

/// Builds the complete application router.
pub fn app(config: Arc<ServeConfig>, store: Arc<JobStore>) -> Router {
    let state = AppState {
        config: config.clone(),
        store,
        tools: Arc::new(tools::registry()),
    };
    let www_router = match &config.www {
        Some(dir) => www::router(dir),
        None => www::placeholder_router(),
    };
    Router::new()
        .nest("/api/v1", api::router(state))
        .merge(www_router)
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

/// Creates the job store and workers for a configuration.
pub fn store(config: &ServeConfig) -> Arc<JobStore> {
    let runner = runner::build(config);
    let simulated = config.runner == crate::config::RunnerKind::Simulate;
    let store = JobStore::new(runner, simulated, config.cpu, config.retain);
    store.spawn_workers(config.parallel, config.sweep_interval);
    store
}

/// Binds the listener and starts serving. Self-signed certificates must be
/// generated beforehand (`TlsMode::Site` with the generated files).
pub async fn start(config: ServeConfig) -> io::Result<Running> {
    std::fs::create_dir_all(config.data_dir.join("jobs"))?;
    let config = Arc::new(config);
    let store = store(&config);
    let app = app(config.clone(), store.clone());
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
    })
}
