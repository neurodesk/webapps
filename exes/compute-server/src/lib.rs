//! `neurodesk-compute`: a small token-protected HTTP + Server-Sent-Events server
//! that runs the Neurodesk `nesvor` container (or a simulated placeholder) for
//! the browser webapp.
//!
//! The wire protocol is documented in `docs/architecture/remote-compute-protocol.md`.
//! The library exposes the pieces the binary and the integration tests share:
//! [`server::start`] builds and binds the HTTP server from a [`config::ServeConfig`].

pub mod api;
pub mod auth;
pub mod config;
pub mod cors;
pub mod detect;
pub mod jobs;
pub mod runner;
pub mod server;
pub mod tls;
pub mod tools;
pub mod www;

/// Service name reported by `GET /api/v1/info`.
pub const SERVICE_NAME: &str = "neurodesk-compute";

/// Crate version reported by `GET /api/v1/info` and the CLI.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Protocol major version implemented by this server.
pub const PROTOCOL_VERSION: u32 = 1;

/// Pinned docker image for the nesvor tool.
pub const NESVOR_DOCKER_IMAGE: &str =
    "vnmd/nesvor_0.5.0@sha256:4a9b346297bd5c10af4047745b6fa82f2912e06c8fecaab615f2adcb32599f64";

/// File name of the apptainer image for the nesvor tool.
pub const NESVOR_SIMG_NAME: &str = "nesvor_0.5.0_20260722.simg";

/// Download location of the apptainer image.
pub const NESVOR_SIMG_URL: &str =
    "https://neurocontainers.neurodesk.workers.dev/nesvor_0.5.0_20260722.simg";
