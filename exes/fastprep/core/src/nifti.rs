//! Header-only NIfTI-1 (single file, `.nii` / `.nii.gz`): pybabel's acceptance, repairs and affine policy.
//! Voxel payloads are never decoded: a gzip stream is inflated only until 348 bytes come out.

use crate::host::Host;
use flate2::{Decompress, FlushDecompress, Status};
pub use neurodesk_nifti::accept::{Header, parse};

const CHUNK: usize = 4096;
/// ponytail: compressed bytes allowed before the header appears (gzip FEXTRA/FNAME/FCOMMENT included)
const MAX_COMPRESSED: usize = 1 << 20;

pub async fn read<H: Host>(h: &H, path: &str) -> Result<Header, String> {
    let err = |m: String| format!("{path}: {m}");
    let head = h.read_range(path, 0, CHUNK).await?;
    let raw = if head.starts_with(&[0x1f, 0x8b]) {
        gunzip_header(h, path, head).await.map_err(err)?
    } else if head.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        return Err(err(
            "zstd images are not supported as fastprep inputs; use .nii or .nii.gz".into(),
        ));
    } else {
        head
    };
    parse(&raw).map_err(err)
}

/// Bytes after the gzip member header (RFC 1952), or None while more input is needed.
fn deflate_start(b: &[u8]) -> Result<Option<usize>, String> {
    if b.len() < 10 {
        return Ok(None);
    }
    if b[2] != 8 {
        return Err("gzip: unsupported compression method".into());
    }
    let flags = b[3];
    let mut i = 10;
    if flags & 4 != 0 {
        if b.len() < i + 2 {
            return Ok(None);
        }
        i += 2 + u16::from_le_bytes([b[i], b[i + 1]]) as usize;
    }
    for bit in [8, 16] {
        if flags & bit != 0 {
            match b.get(i..).and_then(|s| s.iter().position(|&c| c == 0)) {
                Some(z) => i += z + 1,
                None => return Ok(None),
            }
        }
    }
    if flags & 2 != 0 {
        i += 2;
    }
    Ok((i <= b.len()).then_some(i))
}

async fn gunzip_header<H: Host>(h: &H, path: &str, mut buf: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut start = None;
    let mut out = Vec::with_capacity(348);
    let mut z = Decompress::new(false);
    let mut fed = 0; // compressed bytes already given to the decoder
    loop {
        if start.is_none() {
            start = deflate_start(&buf)?;
            fed = start.unwrap_or(0);
        }
        if start.is_some() {
            while fed < buf.len() && out.len() < 348 {
                let before = z.total_in();
                let status = z
                    .decompress_vec(&buf[fed..], &mut out, FlushDecompress::None)
                    .map_err(|e| format!("corrupt gzip: {e}"))?;
                fed += (z.total_in() - before) as usize;
                if status == Status::StreamEnd {
                    break;
                }
                if z.total_in() == before && out.len() < 348 && fed < buf.len() {
                    return Err("corrupt gzip: decoder made no progress".into());
                }
            }
            if out.len() >= 348 {
                out.truncate(348);
                return Ok(out);
            }
        }
        if buf.len() >= MAX_COMPRESSED {
            return Err(format!("gzip header region exceeds {MAX_COMPRESSED} bytes"));
        }
        let more = h.read_range(path, buf.len() as u64, CHUNK).await?;
        if more.is_empty() {
            return Err("file too short for NIfTI-1 header".into());
        }
        buf.extend_from_slice(&more);
    }
}
