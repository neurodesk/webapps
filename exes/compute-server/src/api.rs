//! The `/api/v1` routes.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::extract::{DefaultBodyLimit, Extension, Path, Request, State};
use axum::http::header::{
    HeaderName, HeaderValue, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE,
};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::Stream;
use rand::RngCore;
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use crate::auth::{self, Credential, Owner};
use crate::config::ServeConfig;
use crate::cors::{self, CorsPolicy};
use crate::jobs::{DeleteError, Event, JobStore, OutputError, SubmitError};
use crate::tools::{self, Tool};

mod hpc;
mod uploads;

/// Maximum size of the `spec` part.
pub const MAX_SPEC_BYTES: usize = 1024 * 1024;

/// Shared state of all handlers.
#[derive(Clone)]
pub struct AppState {
    /// Server configuration.
    pub config: Arc<ServeConfig>,
    /// The job store.
    pub store: Arc<JobStore>,
    /// Registered tools.
    pub tools: Arc<Vec<Arc<dyn Tool>>>,
    pub sessions: Arc<auth::Sessions>,
    pub submissions: Arc<SubmissionLocks>,
}

/// An API error with the protocol's JSON shape.
#[derive(Debug, Clone)]
pub struct ApiError {
    /// HTTP status.
    pub status: StatusCode,
    /// Protocol error code.
    pub code: &'static str,
    /// Message.
    pub message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code,
            message: message.into(),
        }
    }

    /// `400 invalid-spec`.
    pub fn invalid_spec(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid-spec", message)
    }

    /// `401 unauthorized`.
    pub fn unauthorized(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    /// `404 not-found`.
    pub fn not_found(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "not-found", message)
    }

    /// `409 conflict` for an incompatible retry or premature deletion.
    pub fn conflict(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::CONFLICT, "conflict", message)
    }

    /// `413 too-large`.
    pub fn too_large(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too-large", message)
    }

    /// `503 runner-unavailable`.
    pub fn runner_unavailable(message: impl Into<String>) -> ApiError {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "runner-unavailable",
            message,
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message } });
        (self.status, Json(body)).into_response()
    }
}

/// Builds the `/api/v1` router (to be nested under that prefix).
pub fn router(state: AppState) -> Router {
    let policy = CorsPolicy {
        extra: state.config.allow_origins.clone(),
        scheme: state.config.scheme(),
    };
    let max_body = usize::try_from(state.config.max_upload_bytes).unwrap_or(usize::MAX);
    let protected = Router::new()
        .route(
            "/jobs",
            get(list_jobs)
                .post(create_job)
                .layer(DefaultBodyLimit::max(max_body)),
        )
        .route("/session", axum::routing::delete(revoke_session))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/jobs/{id}", get(get_job).delete(delete_job))
        .route("/jobs/{id}/events", get(job_events))
        .route("/jobs/{id}/outputs/{*name}", get(job_output))
        .route(
            "/projects",
            get(hpc::list_projects).post(hpc::create_project),
        )
        .route(
            "/projects/{id}",
            get(hpc::get_project).delete(hpc::delete_project),
        )
        .route("/roots", get(hpc::list_roots))
        .route("/roots/{root}/entries", get(hpc::list_entries))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));
    Router::new()
        .route("/info", get(info))
        .route("/pair", post(pair))
        .merge(protected)
        .fallback(api_not_found)
        .layer(middleware::from_fn(no_store))
        .layer(middleware::from_fn_with_state(policy, cors::cors))
        .with_state(state)
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("no such endpoint")
}

/// Adds `Cache-Control: no-store` to every API response.
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn info(State(state): State<AppState>, request: Request) -> Result<Json<Value>, ApiError> {
    let mut body = json!({
        "service": crate::SERVICE_NAME,
        "version": crate::VERSION,
        "protocol": crate::PROTOCOL_VERSION,
        "auth": "pairing",
    });
    // Without a valid token the probe stays anonymous; a wrong token is not
    // rejected here so that the capability probe never needs credentials.
    if auth::presented_token(&request)
        .and_then(|token| state.sessions.authenticate(&token))
        .is_none()
    {
        return Ok(Json(body));
    }
    let tools: Vec<Value> = state
        .tools
        .iter()
        .map(|tool| {
            json!({
                "id": tool.id(),
                "version": tool.version(),
                "image": tool.pinned_image().unwrap_or(&state.config.image),
                "gpuRequired": tool.uses_gpu(),
                "commands": tool.commands(),
            })
        })
        .collect();
    let gpu = if state.config.cpu {
        json!({ "available": false, "name": state.config.gpu.name })
    } else {
        json!({ "available": state.config.gpu.available, "name": state.config.gpu.name })
    };
    let config = &state.config;
    if let Some(object) = body.as_object_mut() {
        object.insert("simulated".to_string(), json!(state.store.simulated()));
        object.insert("runner".to_string(), json!(config.runner.id()));
        object.insert("gpu".to_string(), gpu);
        object.insert("tools".to_string(), Value::Array(tools));
        object.insert(
            "limits".to_string(),
            json!({
                "maxUploadBytes": config.max_upload_bytes,
                "maxFiles": config.max_files,
                "maxDownloadBytes": config.max_download_bytes,
            }),
        );
        object.insert("ownership".to_string(), json!(config.ownership()));
        object.insert("features".to_string(), json!(config.features()));
        if config.has_feature("dataRoots") {
            object.insert("dataRoots".to_string(), hpc::roots_json(config));
        }
        if config.has_feature("scheduler") {
            let profiles: Vec<Value> = config
                .profiles
                .list()
                .iter()
                .map(|profile| json!({ "name": profile.name, "summary": profile.summary() }))
                .collect();
            object.insert("profiles".to_string(), Value::Array(profiles));
        }
    }
    Ok(Json(body))
}

/// Random 128-bit job id in hex.
pub fn new_job_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn valid_part_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}

pub(crate) fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::too_large("request body exceeds maxUploadBytes")
    } else {
        ApiError::invalid_spec(format!("malformed multipart body: {}", error.body_text()))
    }
}

async fn create_job(
    State(state): State<AppState>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let owner = request
        .extensions()
        .get::<Owner>()
        .ok_or_else(|| ApiError::unauthorized("missing identity"))?
        .0
        .clone();
    let key = request
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| ApiError::invalid_spec("Idempotency-Key is required (1 to 128 characters)"))?
        .to_owned();
    state
        .store
        .runner_health()
        .map_err(ApiError::runner_unavailable)?;
    // Only duplicate attempts share an upload lock.
    let submission = state.submissions.for_key(&owner, &key);
    let _submission = submission.lock().await;
    if let Some(length) = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > state.config.max_upload_bytes {
            return Err(ApiError::too_large("request body exceeds maxUploadBytes"));
        }
    }
    let multipart = Multipart::from_request(request, &state)
        .await
        .map_err(|error: MultipartRejection| ApiError::invalid_spec(error.body_text()))?;

    let id = new_job_id();
    let job_dir = state.config.data_dir.join("jobs").join(&id);
    let mut upload = PendingUpload(Some(job_dir.clone()));
    let in_dir = job_dir.join("in");
    tokio::fs::create_dir_all(&in_dir).await.map_err(|error| {
        ApiError::runner_unavailable(format!("cannot create job directory: {error}"))
    })?;

    let result = uploads::receive_job(&state, multipart, &in_dir).await;
    let (tool, mut validated, fingerprint) = match result {
        Ok(ok) => ok,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&job_dir).await;
            return Err(error);
        }
    };
    if let Some(view) = state.store.receipt(&owner, &key) {
        if state.store.fingerprint(&view.id).as_deref() != Some(&fingerprint) {
            return Err(ApiError::conflict(
                "Idempotency-Key already identifies different inputs or settings",
            ));
        }
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "id": view.id, "status": view.status, "position": view.position })),
        ));
    }
    uploads::resolve_project(&state, tool.as_ref(), &mut validated).await?;
    if matches!(tool.layout(), tools::Layout::Files(_)) {
        tokio::fs::create_dir_all(job_dir.join("out"))
            .await
            .map_err(|error| {
                ApiError::runner_unavailable(format!("cannot create job directory: {error}"))
            })?;
    }
    #[cfg(unix)]
    for directory in [&in_dir, &job_dir, &state.config.data_dir.join("jobs")] {
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    }
    let position = state
        .store
        .submit(
            crate::jobs::SubmissionIdentity {
                owner,
                key,
                fingerprint,
            },
            id.clone(),
            tool,
            validated,
            job_dir,
        )
        .map_err(|error| match error {
            SubmitError::Invalid(message) => ApiError::invalid_spec(message),
            SubmitError::Unavailable(error) => ApiError::runner_unavailable(error.to_string()),
        })?;
    upload.0 = None;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "id": id, "status": "queued", "position": position })),
    ))
}

use axum::extract::FromRequest;

async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &id, &owner)?;
    let view = state
        .store
        .view(&id)
        .ok_or_else(|| ApiError::not_found("no such job"))?;
    let value = serde_json::to_value(view)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(Json(value))
}

async fn delete_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<StatusCode, ApiError> {
    require_owner(&state, &id, &owner)?;
    state.store.delete(&id).await.map_err(delete_error)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Maps a refused deletion to its protocol error.
pub fn delete_error(error: DeleteError) -> ApiError {
    match error {
        DeleteError::NotFound => ApiError::not_found("no such job"),
        DeleteError::Conflict(message) => ApiError::conflict(message),
        DeleteError::Storage => ApiError::runner_unavailable("cannot record the deletion"),
    }
}

fn sse_event(event: &Event) -> SseEvent {
    let data = serde_json::to_string(&event.data()).unwrap_or_else(|_| "null".to_string());
    SseEvent::default().event(event.name()).data(data)
}

async fn job_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    require_owner(&state, &id, &owner)?;
    let (replay, mut receiver) = state
        .store
        .subscribe(&id)
        .ok_or_else(|| ApiError::not_found("no such job"))?;
    let stream = async_stream::stream! {
        let mut finished = false;
        for event in replay {
            if matches!(event, Event::Done(_)) {
                finished = true;
            }
            yield Ok::<SseEvent, Infallible>(sse_event(&event));
        }
        while !finished {
            match receiver.recv().await {
                Ok(event) => {
                    if matches!(event, Event::Done(_)) {
                        finished = true;
                    }
                    yield Ok(sse_event(&event));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

async fn job_output(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<Response, ApiError> {
    require_owner(&state, &id, &owner)?;
    let file = state
        .store
        .output(&id, &name)
        .map_err(|error| match error {
            OutputError::NotFound => ApiError::not_found("no such output"),
            OutputError::TooLarge => {
                ApiError::too_large("output exceeds maxDownloadBytes; it stays on the server")
            }
        })?;
    serve_file(file.path, &file.content_type, &file.file_name).await
}

async fn serve_file(path: PathBuf, content_type: &str, name: &str) -> Result<Response, ApiError> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("no such output"))?;
    let length = file
        .metadata()
        .await
        .map(|metadata| metadata.len())
        .map_err(|_| ApiError::not_found("no such output"))?;
    let body = Body::from_stream(ReaderStream::new(file));
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(CONTENT_TYPE, value);
    }
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    let name = name.replace(['"', '\\'], "_");
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        headers.insert(CONTENT_DISPOSITION, value);
    }
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

async fn pair(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("");
    if !auth::constant_time_eq(code, &state.config.token) {
        return Err(ApiError::unauthorized("invalid pairing code"));
    }
    let (token, client_id) = state
        .sessions
        .pair()
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(Json(json!({ "token": token, "clientId": client_id })))
}

async fn revoke_session(
    State(state): State<AppState>,
    Extension(Credential(token)): Extension<Credential>,
) -> Result<StatusCode, ApiError> {
    state
        .sessions
        .revoke(&token)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

fn require_owner(state: &AppState, id: &str, owner: &str) -> Result<(), ApiError> {
    if state.store.owned(id, owner) {
        Ok(())
    } else {
        Err(ApiError::not_found("no such job"))
    }
}

async fn list_jobs(
    State(state): State<AppState>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Json<Value> {
    Json(json!({ "jobs": state.store.list(&owner) }))
}

async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &id, &owner)?;
    state
        .store
        .cancel(&id)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(Json(json!(state.store.view(&id))))
}

type UploadLocks =
    std::collections::HashMap<(String, String), std::sync::Weak<tokio::sync::Mutex<()>>>;

#[derive(Default)]
pub struct SubmissionLocks {
    entries: std::sync::Mutex<UploadLocks>,
}

impl SubmissionLocks {
    fn for_key(&self, owner: &str, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, value| value.strong_count() > 0);
        let entry = entries
            .entry((owner.to_owned(), key.to_owned()))
            .or_default();
        if let Some(lock) = entry.upgrade() {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        *entry = Arc::downgrade(&lock);
        lock
    }
}

struct PendingUpload(Option<PathBuf>);

impl Drop for PendingUpload {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

pub(crate) fn hex_digest(digest: ring::digest::Digest) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
