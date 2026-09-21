//! Static file serving for the bundled webapp with cross-origin isolation
//! headers.

use std::path::Path;

use axum::http::header::HeaderValue;
use axum::response::IntoResponse;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

/// A router that serves `dir` at `/` (with `index.html` for directories) and
/// adds `Cross-Origin-Opener-Policy: same-origin` and
/// `Cross-Origin-Embedder-Policy: credentialless` to every file.
pub fn router(dir: &Path) -> Router {
    let service = ServeDir::new(dir).append_index_html_on_directories(true);
    Router::new()
        .fallback_service(service)
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("credentialless"),
        ))
}

/// The router used when no `www` directory is configured.
pub fn placeholder_router() -> Router {
    Router::new().fallback(|| async {
        (
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            format!(
                "{} {}\nAPI at /api/v1 (see docs/architecture/remote-compute-protocol.md)\n",
                crate::SERVICE_NAME,
                crate::VERSION
            ),
        )
            .into_response()
    })
}

/// The default `www` directory: a `www` folder beside the executable, when it exists.
pub fn default_www_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("www");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}
