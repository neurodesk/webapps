//! Receiving a job: the spec, tool-specific file parts, and the server-side
//! resolution of a project job's data references and profile.

use std::sync::Arc;

use axum::extract::multipart::Multipart;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::{hex_digest, multipart_error, valid_part_name, ApiError, AppState, MAX_SPEC_BYTES};
use crate::roots::{self, DataRoot, PathError, RelativePath};
use crate::tools::project::{part_file_name, DataReference};
use crate::tools::{self, mrc, nifti, Layout, ReceivedPart, Tool};

/// Leading bytes of every upload kept for validation.
const KEPT_BYTES: usize = mrc::HEADER_LEN;

/// Streams the multipart parts to `in_dir` and validates the spec. File tools
/// receive NIfTI (`<part>.nii[.gz]`), project tools MRC (`<part>.mrc`).
pub async fn receive_job(
    state: &AppState,
    mut multipart: Multipart,
    in_dir: &std::path::Path,
) -> Result<(Arc<dyn Tool>, tools::ValidatedJob, String), ApiError> {
    let buffer = read_spec(&mut multipart).await?;
    let mut total_bytes = buffer.len() as u64;
    let spec: Value = serde_json::from_slice(&buffer)
        .map_err(|error| ApiError::invalid_spec(format!("spec is not valid JSON: {error}")))?;
    let tool_id = spec
        .get("tool")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_spec("'tool' must be a string"))?;
    let tool = tools::find(&state.tools, tool_id)
        .ok_or_else(|| ApiError::invalid_spec(format!("unknown tool '{tool_id}'")))?;
    let project_tool = matches!(tool.layout(), Layout::Project(_));

    let mut parts: Vec<ReceivedPart> = Vec::new();
    let mut digests: Vec<(String, String)> = Vec::new();
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or("").to_string();
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
            if first_bytes.len() < KEPT_BYTES {
                let wanted = KEPT_BYTES - first_bytes.len();
                first_bytes.extend_from_slice(&chunk[..chunk.len().min(wanted)]);
            }
            file.write_all(&chunk).await.map_err(|error| {
                ApiError::runner_unavailable(format!("cannot write upload: {error}"))
            })?;
        }
        file.sync_all().await.map_err(|error| {
            ApiError::runner_unavailable(format!("cannot write upload: {error}"))
        })?;
        drop(file);
        let part = if project_tool {
            store_mrc(in_dir, &name, &temp_path, first_bytes, bytes).await?
        } else {
            store_nifti(in_dir, &name, &temp_path, &first_bytes, bytes).await?
        };
        digests.push((name, hex_digest(digest.finish())));
        parts.push(part);
    }

    let validated = tool
        .validate(&spec, &parts)
        .map_err(|error| ApiError::invalid_spec(error.message))?;
    digests.sort();
    let bytes = serde_json::to_vec(&(&spec, &digests))
        .map_err(|error| ApiError::invalid_spec(error.to_string()))?;
    let fingerprint = hex_digest(ring::digest::digest(&ring::digest::SHA256, &bytes));
    Ok((tool, validated, fingerprint))
}

/// Reads the first part, which must be the spec.
async fn read_spec(multipart: &mut Multipart) -> Result<Vec<u8>, ApiError> {
    let mut field = multipart
        .next_field()
        .await
        .map_err(multipart_error)?
        .ok_or_else(|| ApiError::invalid_spec("missing 'spec' part"))?;
    if field.name() != Some("spec") {
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
    Ok(buffer)
}

async fn rename(from: &std::path::Path, to: &std::path::Path) -> Result<(), ApiError> {
    tokio::fs::rename(from, to)
        .await
        .map_err(|error| ApiError::runner_unavailable(format!("cannot store upload: {error}")))
}

async fn store_nifti(
    in_dir: &std::path::Path,
    name: &str,
    temp_path: &std::path::Path,
    first_bytes: &[u8],
    bytes: u64,
) -> Result<ReceivedPart, ApiError> {
    let gzipped = nifti::is_gzip(first_bytes);
    let file_name = if gzipped {
        format!("{name}.nii.gz")
    } else {
        format!("{name}.nii")
    };
    let path = in_dir.join(&file_name);
    rename(temp_path, &path).await?;
    let header_path = path.clone();
    let header = tokio::task::spawn_blocking(move || nifti::read_header(&header_path, gzipped))
        .await
        .map_err(|error| ApiError::runner_unavailable(error.to_string()))?
        .unwrap_or_default();
    Ok(ReceivedPart {
        name: name.to_string(),
        path,
        file_name,
        gzipped,
        header,
        bytes,
    })
}

async fn store_mrc(
    in_dir: &std::path::Path,
    name: &str,
    temp_path: &std::path::Path,
    header: Vec<u8>,
    bytes: u64,
) -> Result<ReceivedPart, ApiError> {
    if !mrc::has_map_magic(&header) {
        return Err(ApiError::invalid_spec(format!(
            "part '{name}' is not an MRC file ('MAP ' at byte 208)"
        )));
    }
    let file_name = part_file_name(name);
    let path = in_dir.join(&file_name);
    rename(temp_path, &path).await?;
    Ok(ReceivedPart {
        name: name.to_string(),
        path,
        file_name,
        gzipped: false,
        header,
        bytes,
    })
}

/// Resolves a project job's data references against the roots and its
/// profile against the configuration, and lets the tool refuse the profile.
pub async fn resolve_project(
    state: &AppState,
    tool: &dyn Tool,
    validated: &mut tools::ValidatedJob,
) -> Result<(), ApiError> {
    let Layout::Project(project_tool) = tool.layout() else {
        return Ok(());
    };
    let command = validated.command.clone();
    let inputs = validated
        .project_mut()
        .ok_or_else(|| ApiError::invalid_spec("a project tool must return project inputs"))?;
    let references = std::mem::take(&mut inputs.data);
    let roots = state.config.data_roots.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        references
            .into_iter()
            .map(|reference| resolve_reference(&roots, reference))
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| ApiError::runner_unavailable(error.to_string()))?
    .map_err(ApiError::invalid_spec)?;
    inputs.data = resolved;
    let profile = state
        .config
        .profiles
        .resolve(&command, inputs.profile.as_deref())
        .map_err(ApiError::invalid_spec)?;
    project_tool
        .launch(inputs, profile)
        .map_err(ApiError::invalid_spec)?;
    inputs.profile = Some(profile.name.clone());
    Ok(())
}

/// Fills in a reference's canonical directory, as the job sees it, and its files.
pub fn resolve_reference(
    roots: &[DataRoot],
    mut reference: DataReference,
) -> Result<DataReference, String> {
    let root = roots
        .iter()
        .find(|root| root.id == reference.root)
        .ok_or_else(|| format!("unknown data root '{}'", reference.root))?;
    let describe = |error: PathError| format!("data root '{}': {error}", root.id);
    let (directory, names) = match &reference.pattern {
        Some(pattern) => {
            let matched = roots::match_pattern(root, &reference.path, pattern).map_err(describe)?;
            (matched.directory, matched.names)
        }
        None => {
            let file = RelativePath::parse(&reference.path)
                .and_then(|path| path.resolve(&root.path))
                .map_err(describe)?;
            if !file.is_file() {
                return Err(format!(
                    "data root '{}': '{}' is not a file",
                    root.id, reference.path
                ));
            }
            let relative = roots::relative_to(&root.path, &file).map_err(describe)?;
            match relative.rsplit_once('/') {
                Some((parent, name)) => (parent.to_string(), vec![name.to_string()]),
                None => (String::new(), vec![relative]),
            }
        }
    };
    let base = root.container_path();
    reference.directory = Some(if directory.is_empty() {
        base
    } else {
        format!("{base}/{directory}")
    });
    reference.matches = names;
    Ok(reference)
}
