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
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::auth::{self, Owner};
use crate::config::ServeConfig;
use crate::cors::{self, CorsPolicy};
use crate::jobs::{Event, JobStore};
use crate::tools::{self, nifti, ReceivedPart, Tool};

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
        .route("/jobs/{id}/outputs/{name}", get(job_output))
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
        .and_then(|token| state.sessions.owner(&token))
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
                "image": tool.image(&state.config.image),
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
    if let Some(object) = body.as_object_mut() {
        object.insert("simulated".to_string(), json!(state.store.simulated()));
        object.insert("runner".to_string(), json!(state.config.runner.id()));
        object.insert("gpu".to_string(), gpu);
        object.insert("tools".to_string(), Value::Array(tools));
        object.insert(
            "limits".to_string(),
            json!({
                "maxUploadBytes": state.config.max_upload_bytes,
                "maxFiles": state.config.max_files,
            }),
        );
    }
    Ok(Json(body))
}

/// Random 128-bit job id in hex.
pub fn new_job_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_part_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}

fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
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
    let out_dir = job_dir.join("out");
    tokio::fs::create_dir_all(&in_dir).await.map_err(|error| {
        ApiError::runner_unavailable(format!("cannot create job directory: {error}"))
    })?;
    tokio::fs::create_dir_all(&out_dir).await.map_err(|error| {
        ApiError::runner_unavailable(format!("cannot create job directory: {error}"))
    })?;

    let result = receive_job(&state, multipart, &in_dir).await;
    let (tool, validated, fingerprint) = match result {
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
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    upload.0 = None;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "id": id, "status": "queued", "position": position })),
    ))
}

use axum::extract::FromRequest;

/// Streams the multipart parts to `in_dir` and validates the spec.
async fn receive_job(
    state: &AppState,
    mut multipart: Multipart,
    in_dir: &std::path::Path,
) -> Result<(Arc<dyn Tool>, tools::ValidatedJob, String), ApiError> {
    let mut spec: Option<Value> = None;
    let mut parts: Vec<ReceivedPart> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut digests: Vec<(String, String)> = Vec::new();

    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or("").to_string();
        if spec.is_none() {
            if name != "spec" {
                return Err(ApiError::invalid_spec(
                    "the first part must be named 'spec'",
                ));
            }
            let mut buffer = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                buffer.extend_from_slice(&chunk);
                if buffer.len() > MAX_SPEC_BYTES {
                    return Err(ApiError::invalid_spec("spec is larger than 1 MiB"));
                }
            }
            total_bytes += buffer.len() as u64;
            let parsed: Value = serde_json::from_slice(&buffer).map_err(|error| {
                ApiError::invalid_spec(format!("spec is not valid JSON: {error}"))
            })?;
            spec = Some(parsed);
            continue;
        }
        if !valid_part_name(&name) {
            return Err(ApiError::invalid_spec(format!(
                "invalid part name '{name}'"
            )));
        }
        if parts.iter().any(|part| part.name == name) {
            return Err(ApiError::invalid_spec(format!("duplicate part '{name}'")));
        }
        if parts.len() >= state.config.max_files {
            return Err(ApiError::too_large(format!(
                "more than {} file parts",
                state.config.max_files
            )));
        }
        let temp_path = in_dir.join(format!("{name}.part"));
        let mut file = tokio::fs::File::create(&temp_path).await.map_err(|error| {
            ApiError::runner_unavailable(format!("cannot write upload: {error}"))
        })?;
        let mut first_bytes: Vec<u8> = Vec::new();
        let mut bytes: u64 = 0;
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            digest.update(&chunk);
            bytes += chunk.len() as u64;
            total_bytes += chunk.len() as u64;
            if total_bytes > state.config.max_upload_bytes {
                return Err(ApiError::too_large("request body exceeds maxUploadBytes"));
            }
            if first_bytes.len() < 2 {
                first_bytes.extend_from_slice(&chunk[..chunk.len().min(2 - first_bytes.len())]);
            }
            file.write_all(&chunk).await.map_err(|error| {
                ApiError::runner_unavailable(format!("cannot write upload: {error}"))
            })?;
        }
        file.sync_all().await.map_err(|error| {
            ApiError::runner_unavailable(format!("cannot write upload: {error}"))
        })?;
        drop(file);
        let gzipped = nifti::is_gzip(&first_bytes);
        let file_name = if gzipped {
            format!("{name}.nii.gz")
        } else {
            format!("{name}.nii")
        };
        let path = in_dir.join(&file_name);
        tokio::fs::rename(&temp_path, &path)
            .await
            .map_err(|error| {
                ApiError::runner_unavailable(format!("cannot store upload: {error}"))
            })?;
        let header_path = path.clone();
        let header = tokio::task::spawn_blocking(move || nifti::read_header(&header_path, gzipped))
            .await
            .map_err(|error| ApiError::runner_unavailable(error.to_string()))?
            .unwrap_or_default();
        digests.push((name.clone(), hex_digest(digest.finish())));
        parts.push(ReceivedPart {
            name,
            path,
            file_name,
            gzipped,
            header,
            bytes,
        });
    }

    let spec = spec.ok_or_else(|| ApiError::invalid_spec("missing 'spec' part"))?;
    let tool_id = spec
        .get("tool")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_spec("'tool' must be a string"))?;
    let tool = tools::find(&state.tools, tool_id)
        .ok_or_else(|| ApiError::invalid_spec(format!("unknown tool '{tool_id}'")))?;
    let validated = tool
        .validate(&spec, &parts)
        .map_err(|error| ApiError::invalid_spec(error.message))?;
    digests.sort();
    let bytes = serde_json::to_vec(&(&spec, &digests))
        .map_err(|error| ApiError::invalid_spec(error.to_string()))?;
    let fingerprint = hex_digest(ring::digest::digest(&ring::digest::SHA256, &bytes));
    Ok((tool, validated, fingerprint))
}

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
    if !state
        .store
        .view(&id)
        .is_some_and(|job| job.status.is_finished())
    {
        return Err(ApiError::conflict(
            "cancel and wait for termination before deletion",
        ));
    }
    if state.store.delete(&id).await {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("no such job"))
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
    let (path, content_type, _) = state
        .store
        .output(&id, &name)
        .ok_or_else(|| ApiError::not_found("no such output"))?;
    serve_file(path, &content_type, &name).await
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
    Extension(Owner(owner)): Extension<Owner>,
) -> Result<StatusCode, ApiError> {
    state
        .sessions
        .revoke(&owner)
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

fn hex_digest(digest: ring::digest::Digest) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
