//! The simulated tool: averages the input stacks that share the first
//! stack's dimensions and writes a float32 NIfTI-1 volume, `result.json`
//! and the stage log lines of the nesvor progress table.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{shell_join, LineSink, RunFuture, RunOutcome, RunRequest, Runner};
use crate::config::RunnerKind;
use crate::tools::nesvor::DEFAULT_ITERATIONS;
use crate::tools::nifti::{self, Header, HEADER_LEN};
use crate::tools::ToolPaths;

/// Pause between simulated stages so that cancellation can be exercised.
pub const STAGE_DELAY: Duration = Duration::from_millis(50);

/// The placeholder runner.
#[derive(Debug, Clone, Copy, Default)]
pub struct SimulateRunner;

impl Runner for SimulateRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Simulate
    }

    fn paths(&self, _job_dir: &Path) -> ToolPaths {
        ToolPaths::container()
    }

    fn run(&self, request: RunRequest, sink: LineSink, cancel: CancellationToken) -> RunFuture {
        Box::pin(async move { simulate(request, sink, cancel).await })
    }
}

/// Formats a Python-logging style line.
pub fn log_line(level: &str, message: &str) -> String {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    format!("{stamp} [{level}] {message}")
}

/// A decoded input volume.
struct Volume {
    header_bytes: Vec<u8>,
    header: Header,
    voxels: Vec<f32>,
}

async fn simulate(
    request: RunRequest,
    sink: LineSink,
    cancel: CancellationToken,
) -> io::Result<RunOutcome> {
    let log = |level: &str, message: String| {
        let _ = sink.send(log_line(level, &message));
    };
    log(
        "INFO",
        format!("simulated run of: {}", shell_join(&request.argv)),
    );

    let iterations = request
        .job
        .options
        .get("iterations")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(DEFAULT_ITERATIONS);

    let stage = |message: &'static str| {
        let sink = sink.clone();
        let cancel = cancel.clone();
        async move {
            let _ = sink.send(log_line("INFO", message));
            tokio::select! {
                _ = tokio::time::sleep(STAGE_DELAY) => false,
                _ = cancel.cancelled() => true,
            }
        }
    };

    if stage("Data loading starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    let in_dir = request.job_dir.join("in");
    let stack_paths: Vec<PathBuf> = request
        .job
        .stacks
        .iter()
        .map(|stack| in_dir.join(&stack.file_name))
        .collect();
    let loaded = tokio::task::spawn_blocking(move || load_volumes(&stack_paths))
        .await
        .map_err(|error| io::Error::other(error.to_string()))?;
    let volumes = match loaded {
        Ok(volumes) => volumes,
        Err(message) => {
            log("ERROR", message);
            return Ok(RunOutcome::Exited(1));
        }
    };
    log(
        "INFO",
        format!(
            "{} stacks loaded, first stack dim {:?}",
            volumes.len(),
            &volumes[0].header.dim[1..=volumes[0].header.dim[0].clamp(1, 7) as usize]
        ),
    );

    let flag = |key: &str| {
        request
            .job
            .options
            .get(key)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    };
    if flag("segmentation") && stage("Segmentation starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    if flag("biasFieldCorrection") && stage("Bias Field Correction starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    if stage("Assessment starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    if stage("Registration starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    if stage("Reconsturction starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    if stage("NeSVoR training starts.").await {
        return Ok(RunOutcome::Cancelled);
    }
    let _ = sink.send(log_line(
        "INFO",
        "        time        epoch         iter         loss",
    ));
    let rows = (iterations / 1000).clamp(3, 20);
    for row in 1..=rows {
        let iteration = iterations * row / rows;
        let seconds = row * 7;
        let line = format!(
            "     {}:{:02}:{:02} {:>12} {:>12}    {:.3e}",
            seconds / 3600,
            (seconds / 60) % 60,
            seconds % 60,
            row,
            iteration,
            1.0 / (row as f64 + 1.0)
        );
        let _ = sink.send(log_line("INFO", &line));
        let cancelled = tokio::select! {
            _ = tokio::time::sleep(STAGE_DELAY) => false,
            _ = cancel.cancelled() => true,
        };
        if cancelled {
            return Ok(RunOutcome::Cancelled);
        }
    }

    if stage("Results saving starts ...").await {
        return Ok(RunOutcome::Cancelled);
    }
    let matching = volumes
        .iter()
        .filter(|volume| volume.header.dim == volumes[0].header.dim)
        .count();
    if matching < volumes.len() {
        log(
            "WARNING",
            format!(
                "{} of {} stacks have different dimensions and are ignored",
                volumes.len() - matching,
                volumes.len()
            ),
        );
    }
    let out_dir = request.job_dir.join("out");
    let result = json!({
        "simulated": true,
        "stacks": request.job.stacks.len(),
        "options": request.job.options,
    });
    let written = tokio::task::spawn_blocking(move || {
        write_mean_volume(&out_dir.join("volume.nii.gz"), &volumes)?;
        let result_text = serde_json::to_string_pretty(&result)
            .map_err(|error| io::Error::other(error.to_string()))?;
        std::fs::write(out_dir.join("result.json"), result_text)
    })
    .await
    .map_err(|error| io::Error::other(error.to_string()))?;
    if let Err(error) = written {
        log("ERROR", format!("could not write outputs: {error}"));
        return Ok(RunOutcome::Exited(1));
    }
    log(
        "INFO",
        format!(
            "Reconstruction finished, overall time: 0:00:{:02}",
            (rows + 8) * STAGE_DELAY.as_millis() as u64 / 1000
        ),
    );
    Ok(RunOutcome::Exited(0))
}

fn load_volumes(paths: &[PathBuf]) -> Result<Vec<Volume>, String> {
    let mut volumes = Vec::with_capacity(paths.len());
    for path in paths {
        let volume = load_volume(path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        volumes.push(volume);
    }
    if volumes.is_empty() {
        return Err("no input stacks".to_string());
    }
    Ok(volumes)
}

fn load_volume(path: &Path) -> Result<Volume, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut magic = [0u8; 2];
    let read = file.read(&mut magic).map_err(|error| error.to_string())?;
    let gzipped = read == 2 && nifti::is_gzip(&magic);
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    if gzipped {
        GzDecoder::new(file)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
    } else {
        file.read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
    }
    if bytes.len() < HEADER_LEN {
        return Err("file shorter than a NIfTI-1 header".to_string());
    }
    let header = Header::parse(&bytes)?;
    let count = header.voxel_count() as usize;
    let offset = header.vox_offset.max(HEADER_LEN as f32) as usize;
    let bytes_per_voxel = (header.bitpix.max(0) as usize) / 8;
    let data = bytes
        .get(offset..offset + count * bytes_per_voxel)
        .ok_or_else(|| "voxel data is truncated".to_string())?;
    let mut voxels = decode_voxels(data, header.datatype, header.little_endian)?;
    if header.scl_slope != 0.0 && (header.scl_slope != 1.0 || header.scl_inter != 0.0) {
        for voxel in &mut voxels {
            *voxel = *voxel * header.scl_slope + header.scl_inter;
        }
    }
    Ok(Volume {
        header_bytes: bytes[..HEADER_LEN].to_vec(),
        header,
        voxels,
    })
}

fn decode_voxels(data: &[u8], datatype: i16, little_endian: bool) -> Result<Vec<f32>, String> {
    macro_rules! decode {
        ($ty:ty, $size:expr) => {
            data.chunks_exact($size)
                .map(|chunk| {
                    let mut raw = [0u8; $size];
                    raw.copy_from_slice(chunk);
                    if little_endian {
                        <$ty>::from_le_bytes(raw) as f32
                    } else {
                        <$ty>::from_be_bytes(raw) as f32
                    }
                })
                .collect()
        };
    }
    let voxels: Vec<f32> = match datatype {
        2 => data.iter().map(|byte| *byte as f32).collect(),
        256 => data.iter().map(|byte| *byte as i8 as f32).collect(),
        4 => decode!(i16, 2),
        512 => decode!(u16, 2),
        8 => decode!(i32, 4),
        768 => decode!(u32, 4),
        16 => decode!(f32, 4),
        64 => decode!(f64, 8),
        other => return Err(format!("unsupported NIfTI datatype {other}")),
    };
    Ok(voxels)
}

/// Writes the mean of all volumes with the first volume's dimensions as a
/// gzipped float32 NIfTI-1 file that reuses the first volume's header.
fn write_mean_volume(path: &Path, volumes: &[Volume]) -> io::Result<()> {
    let first = &volumes[0];
    let count = first.voxels.len();
    let mut sum = vec![0f64; count];
    let mut n = 0usize;
    for volume in volumes {
        if volume.header.dim != first.header.dim || volume.voxels.len() != count {
            continue;
        }
        for (accumulator, voxel) in sum.iter_mut().zip(&volume.voxels) {
            *accumulator += *voxel as f64;
        }
        n += 1;
    }
    let divisor = n.max(1) as f64;

    let mut header = first.header_bytes.clone();
    header.resize(HEADER_LEN, 0);
    let little_endian = first.header.little_endian;
    let put_i16 = |header: &mut Vec<u8>, offset: usize, value: i16| {
        let bytes = if little_endian {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        };
        header[offset..offset + 2].copy_from_slice(&bytes);
    };
    let put_f32 = |header: &mut Vec<u8>, offset: usize, value: f32| {
        let bytes = if little_endian {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        };
        header[offset..offset + 4].copy_from_slice(&bytes);
    };
    put_i16(&mut header, 70, 16);
    put_i16(&mut header, 72, 32);
    put_f32(&mut header, 108, HEADER_LEN as f32);
    put_f32(&mut header, 112, 1.0);
    put_f32(&mut header, 116, 0.0);
    // The four extension bytes after the 348-byte header stay zero.
    for byte in &mut header[348..HEADER_LEN] {
        *byte = 0;
    }

    let mut encoder = GzEncoder::new(File::create(path)?, Compression::fast());
    encoder.write_all(&header)?;
    let mut buffer = Vec::with_capacity(count * 4);
    for value in sum {
        let mean = (value / divisor) as f32;
        if little_endian {
            buffer.extend_from_slice(&mean.to_le_bytes());
        } else {
            buffer.extend_from_slice(&mean.to_be_bytes());
        }
    }
    encoder.write_all(&buffer)?;
    encoder.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume_bytes(values: &[f32], datatype: i16) -> Vec<u8> {
        let mut bytes = vec![0u8; HEADER_LEN];
        bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
        bytes[40..42].copy_from_slice(&3i16.to_le_bytes());
        bytes[42..44].copy_from_slice(&(values.len() as i16).to_le_bytes());
        bytes[44..46].copy_from_slice(&1i16.to_le_bytes());
        bytes[46..48].copy_from_slice(&1i16.to_le_bytes());
        bytes[70..72].copy_from_slice(&datatype.to_le_bytes());
        let bitpix: i16 = if datatype == 16 { 32 } else { 16 };
        bytes[72..74].copy_from_slice(&bitpix.to_le_bytes());
        bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
        bytes[344..348].copy_from_slice(b"n+1\0");
        for value in values {
            if datatype == 16 {
                bytes.extend_from_slice(&value.to_le_bytes());
            } else {
                bytes.extend_from_slice(&(*value as i16).to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn averages_matching_volumes() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.nii");
        let b = dir.path().join("b.nii.gz");
        let c = dir.path().join("c.nii");
        std::fs::write(&a, volume_bytes(&[1.0, 2.0, 3.0], 16)).unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(&volume_bytes(&[3.0, 4.0, 5.0], 4))
            .unwrap();
        std::fs::write(&b, encoder.finish().unwrap()).unwrap();
        std::fs::write(&c, volume_bytes(&[100.0, 100.0], 16)).unwrap();

        let volumes = load_volumes(&[a, b, c]).unwrap();
        let out = dir.path().join("volume.nii.gz");
        write_mean_volume(&out, &volumes).unwrap();

        let mut decoded = Vec::new();
        GzDecoder::new(File::open(&out).unwrap())
            .read_to_end(&mut decoded)
            .unwrap();
        let header = Header::parse(&decoded).unwrap();
        assert_eq!(header.datatype, 16);
        assert_eq!(header.bitpix, 32);
        assert_eq!(header.vox_offset, 352.0);
        assert_eq!(header.scl_slope, 1.0);
        assert_eq!(header.scl_inter, 0.0);
        let voxels = decode_voxels(&decoded[352..], 16, true).unwrap();
        assert_eq!(voxels, vec![2.0, 3.0, 4.0]);
    }

    #[test]
    fn rejects_unknown_datatype() {
        assert!(decode_voxels(&[0u8; 4], 1536, true).is_err());
    }
}
