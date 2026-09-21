//! CORS handling as specified by the protocol: allowed origins get the full
//! header set including `Access-Control-Allow-Private-Network`; others get no
//! CORS headers at all.

use axum::extract::{Request, State};
use axum::http::header::{HeaderValue, HOST, ORIGIN, VARY};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// Origins that are always allowed.
pub const BUILTIN_ORIGINS: &[&str] = &[
    "https://webapps.neurodesk.org",
    "https://neurodesk.github.io",
];

/// Origin policy.
#[derive(Debug, Clone)]
pub struct CorsPolicy {
    /// Additional origins from `--allow-origin`.
    pub extra: Vec<String>,
    /// Scheme of this server, used to compute its own origin.
    pub scheme: &'static str,
}

impl CorsPolicy {
    /// Whether `origin` may call the API. `host` is the request's `Host`
    /// header, so that the server's own origin is allowed.
    pub fn allows(&self, origin: &str, host: Option<&str>) -> bool {
        let origin_lower = origin.to_ascii_lowercase();
        if BUILTIN_ORIGINS.contains(&origin_lower.as_str()) {
            return true;
        }
        if self
            .extra
            .iter()
            .any(|allowed| allowed.trim_end_matches('/').eq_ignore_ascii_case(origin))
        {
            return true;
        }
        if let Some(host) = host {
            let own = format!("{}://{}", self.scheme, host.to_ascii_lowercase());
            if own == origin_lower {
                return true;
            }
        }
        is_loopback_origin(&origin_lower)
    }
}

/// `http(s)://localhost[:port]` and `http(s)://127.0.0.1[:port]`.
pub fn is_loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if host != "localhost" && host != "127.0.0.1" {
        return false;
    }
    match port {
        None => true,
        Some(port) => !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()),
    }
}

/// Middleware that answers preflights and decorates responses.
pub async fn cors(State(policy): State<CorsPolicy>, request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let allowed = origin
        .as_deref()
        .map(|origin| policy.allows(origin, host.as_deref()));

    if request.method() == Method::OPTIONS && origin.is_some() {
        let mut response = StatusCode::NO_CONTENT.into_response();
        if allowed == Some(true) {
            let headers = response.headers_mut();
            if let Some(origin) = origin
                .as_deref()
                .and_then(|value| HeaderValue::from_str(value).ok())
            {
                headers.insert("access-control-allow-origin", origin);
            }
            headers.insert(
                "access-control-allow-headers",
                HeaderValue::from_static("Authorization, Content-Type"),
            );
            headers.insert(
                "access-control-allow-methods",
                HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
            );
            headers.insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
            headers.insert("access-control-max-age", HeaderValue::from_static("600"));
            headers.insert(VARY, HeaderValue::from_static("Origin"));
        }
        return response;
    }

    let mut response = next.run(request).await;
    // Every response varies by origin, whether or not CORS headers follow.
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Origin"));
    if allowed == Some(true) {
        if let Some(origin) = origin
            .as_deref()
            .and_then(|value| HeaderValue::from_str(value).ok())
        {
            let headers = response.headers_mut();
            headers.insert("access-control-allow-origin", origin);
            headers.insert(
                "access-control-expose-headers",
                HeaderValue::from_static("Content-Disposition, Content-Length"),
            );
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_policy() {
        let policy = CorsPolicy {
            extra: vec!["https://mirror.example".to_string()],
            scheme: "http",
        };
        assert!(policy.allows("https://webapps.neurodesk.org", None));
        assert!(policy.allows("https://neurodesk.github.io", None));
        assert!(policy.allows("https://mirror.example", None));
        assert!(policy.allows("http://localhost:5173", None));
        assert!(policy.allows("http://127.0.0.1", None));
        assert!(policy.allows("http://192.168.1.5:8765", Some("192.168.1.5:8765")));
        assert!(!policy.allows("https://192.168.1.5:8765", Some("192.168.1.5:8765")));
        assert!(!policy.allows("https://evil.example", None));
        assert!(!policy.allows("http://localhost.evil.example", None));
        assert!(!policy.allows("http://localhost:abc", None));
    }
}
