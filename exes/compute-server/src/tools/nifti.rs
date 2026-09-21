//! Minimal NIfTI-1 header handling: magic detection and the few fields the
//! simulated tool needs.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use flate2::read::GzDecoder;

/// Size of the NIfTI-1 header plus the four extension bytes.
pub const HEADER_LEN: usize = 352;

/// Byte offset of the magic string.
pub const MAGIC_OFFSET: usize = 344;

/// Returns `true` when `bytes` start with the gzip magic.
pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Returns `true` when a (decompressed) header carries the NIfTI-1 magic
/// `n+1\0` or `ni1\0` at byte 344.
pub fn has_nifti1_magic(header: &[u8]) -> bool {
    if header.len() < MAGIC_OFFSET + 4 {
        return false;
    }
    let magic = &header[MAGIC_OFFSET..MAGIC_OFFSET + 4];
    magic == b"n+1\0" || magic == b"ni1\0"
}

/// Reads the first 352 decompressed bytes of a file. `gzipped` selects
/// whether the file is decompressed on the fly; only the bytes needed for
/// the header are read from disk.
pub fn read_header(path: &Path, gzipped: bool) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut header = vec![0u8; HEADER_LEN];
    let read = if gzipped {
        read_up_to(&mut GzDecoder::new(file), &mut header)?
    } else {
        read_up_to(&mut file.take(HEADER_LEN as u64), &mut header)?
    };
    header.truncate(read);
    Ok(header)
}

fn read_up_to<R: Read>(reader: &mut R, buffer: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buffer.len() {
        let n = reader.read(&mut buffer[total..])?;
        if n == 0 {
            break;
        }
        total += n;
    }
    Ok(total)
}

/// Fields of a parsed NIfTI-1 header.
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    /// Whether the header is little-endian.
    pub little_endian: bool,
    /// The eight `dim` entries.
    pub dim: [i16; 8],
    /// Data type code.
    pub datatype: i16,
    /// Bits per voxel.
    pub bitpix: i16,
    /// Offset of the voxel data.
    pub vox_offset: f32,
    /// Scaling slope.
    pub scl_slope: f32,
    /// Scaling intercept.
    pub scl_inter: f32,
}

impl Header {
    /// Parses the header fields. Endianness is inferred from `sizeof_hdr`.
    pub fn parse(header: &[u8]) -> Result<Header, String> {
        if header.len() < 348 {
            return Err("header shorter than 348 bytes".to_string());
        }
        let sizeof_hdr_le = i32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let sizeof_hdr_be = i32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        let little_endian = if sizeof_hdr_le == 348 {
            true
        } else if sizeof_hdr_be == 348 {
            false
        } else {
            return Err("sizeof_hdr is not 348".to_string());
        };
        let i16_at = |offset: usize| -> i16 {
            let bytes = [header[offset], header[offset + 1]];
            if little_endian {
                i16::from_le_bytes(bytes)
            } else {
                i16::from_be_bytes(bytes)
            }
        };
        let f32_at = |offset: usize| -> f32 {
            let bytes = [
                header[offset],
                header[offset + 1],
                header[offset + 2],
                header[offset + 3],
            ];
            if little_endian {
                f32::from_le_bytes(bytes)
            } else {
                f32::from_be_bytes(bytes)
            }
        };
        let mut dim = [0i16; 8];
        for (index, entry) in dim.iter_mut().enumerate() {
            *entry = i16_at(40 + index * 2);
        }
        Ok(Header {
            little_endian,
            dim,
            datatype: i16_at(70),
            bitpix: i16_at(72),
            vox_offset: f32_at(108),
            scl_slope: f32_at(112),
            scl_inter: f32_at(116),
        })
    }

    /// Number of voxels described by `dim`.
    pub fn voxel_count(&self) -> u64 {
        let ndim = self.dim[0].clamp(0, 7) as usize;
        let mut count = 1u64;
        for entry in &self.dim[1..=ndim] {
            count = count.saturating_mul((*entry).max(1) as u64);
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a 352-byte little-endian header with the given magic.
    pub fn header_with_magic(magic: &[u8; 4]) -> Vec<u8> {
        let mut header = vec![0u8; HEADER_LEN];
        header[0..4].copy_from_slice(&348i32.to_le_bytes());
        header[MAGIC_OFFSET..MAGIC_OFFSET + 4].copy_from_slice(magic);
        header
    }

    #[test]
    fn detects_magic_variants() {
        assert!(has_nifti1_magic(&header_with_magic(b"n+1\0")));
        assert!(has_nifti1_magic(&header_with_magic(b"ni1\0")));
        assert!(!has_nifti1_magic(&header_with_magic(b"n+2\0")));
        assert!(!has_nifti1_magic(&[0u8; 100]));
    }

    #[test]
    fn reads_plain_and_gz_headers() {
        let dir = tempfile::tempdir().unwrap();
        let header = header_with_magic(b"n+1\0");
        let mut body = header.clone();
        body.extend_from_slice(&[7u8; 1000]);

        let plain = dir.path().join("plain.nii");
        std::fs::write(&plain, &body).unwrap();
        assert!(!is_gzip(&body));
        let read = read_header(&plain, false).unwrap();
        assert_eq!(read, header);
        assert!(has_nifti1_magic(&read));

        let gz = dir.path().join("plain.nii.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&body).unwrap();
        let compressed = encoder.finish().unwrap();
        std::fs::write(&gz, &compressed).unwrap();
        assert!(is_gzip(&compressed));
        let read = read_header(&gz, true).unwrap();
        assert_eq!(read, header);
        assert!(has_nifti1_magic(&read));
    }

    #[test]
    fn rejects_non_nifti() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text.nii");
        std::fs::write(&path, b"hello world").unwrap();
        let read = read_header(&path, false).unwrap();
        assert_eq!(read.len(), 11);
        assert!(!has_nifti1_magic(&read));
    }

    #[test]
    fn parses_header_fields() {
        let mut header = header_with_magic(b"n+1\0");
        let dim: [i16; 8] = [3, 4, 5, 6, 1, 1, 1, 1];
        for (index, entry) in dim.iter().enumerate() {
            header[40 + index * 2..42 + index * 2].copy_from_slice(&entry.to_le_bytes());
        }
        header[70..72].copy_from_slice(&16i16.to_le_bytes());
        header[72..74].copy_from_slice(&32i16.to_le_bytes());
        header[108..112].copy_from_slice(&352f32.to_le_bytes());
        let parsed = Header::parse(&header).unwrap();
        assert!(parsed.little_endian);
        assert_eq!(parsed.dim, dim);
        assert_eq!(parsed.datatype, 16);
        assert_eq!(parsed.voxel_count(), 120);
    }
}
