//! Projects and data roots. Both exist only in single-owner mode; otherwise
//! their endpoints answer 404.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{delete_error, ApiError, AppState};
use crate::config::ServeConfig;
use crate::jobs::DeleteError;

fn require_single_owner(state: &AppState) -> Result<(), ApiError> {
    if state.config.single_owner {
        Ok(())
    } else {
        Err(ApiError::not_found("no such endpoint"))
    }
}

/// `info.dataRoots` and `GET /roots`: ids and labels, never host paths.
pub fn roots_json(config: &ServeConfig) -> Value {
    Value::Array(
        config
            .data_roots
            .iter()
            .map(|root| json!({ "id": root.id, "label": root.id }))
            .collect(),
    )
}

pub async fn list_roots(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    require_single_owner(&state)?;
    Ok(Json(json!({ "roots": roots_json(&state.config) })))
}

#[derive(Deserialize)]
pub struct EntriesQuery {
    #[serde(default)]
    path: String,
    cursor: Option<String>,
}

pub async fn list_entries(
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(query): Query<EntriesQuery>,
) -> Result<Json<Value>, ApiError> {
    require_single_owner(&state)?;
    let root = state
        .config
        .data_roots
        .iter()
        .find(|candidate| candidate.id == root)
        .cloned()
        .ok_or_else(|| ApiError::not_found("no such directory"))?;
    let page = tokio::task::spawn_blocking(move || {
        crate::roots::list(&root, &query.path, query.cursor.as_deref())
    })
    .await
    .map_err(|error| ApiError::runner_unavailable(error.to_string()))?
    .map_err(|_| ApiError::not_found("no such directory"))?;
    let value = serde_json::to_value(page)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(Json(value))
}

pub async fn create_project(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_single_owner(&state)?;
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_spec("'name' must be a string"))?;
    if let Some(key) = body
        .as_object()
        .and_then(|object| object.keys().find(|key| key.as_str() != "name"))
    {
        return Err(ApiError::invalid_spec(format!("unknown field '{key}'")));
    }
    crate::projects::validate_name(name).map_err(ApiError::invalid_spec)?;
    let project = state
        .store
        .create_project(name.to_string())
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    let value = serde_json::to_value(project)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok((StatusCode::CREATED, Json(value)))
}

pub async fn list_projects(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    require_single_owner(&state)?;
    Ok(Json(json!({ "projects": state.store.projects() })))
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_single_owner(&state)?;
    let project = state
        .store
        .project(&id)
        .ok_or_else(|| ApiError::not_found("no such project"))?;
    let value = serde_json::to_value(project)
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?;
    Ok(Json(value))
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_single_owner(&state)?;
    match state.store.delete_project(&id).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(DeleteError::NotFound) => Err(ApiError::not_found("no such project")),
        Err(error) => Err(delete_error(error)),
    }
}
