//! MRC files: uploads (gain references, masks) are checked for the map
//! magic; the simulated relion tool writes and reads MRC2014 headers.

/// Byte offset of the `MAP ` magic in an MRC2014 header.
pub const MAGIC_OFFSET: usize = 208;

/// How many leading bytes of an upload are kept for validation.
pub const HEADER_LEN: usize = 1024;

/// Whether `header` carries `MAP ` at byte 208.
pub fn has_map_magic(header: &[u8]) -> bool {
    header.get(MAGIC_OFFSET..MAGIC_OFFSET + 4) == Some(b"MAP ")
}

/// Dimensions and pixel size of an MRC file.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MrcHeader {
    pub nx: i32,
    pub ny: i32,
    pub nz: i32,
    /// `cell x / mx`, or 1 when either is not positive.
    pub angpix: f64,
}

fn word(bytes: &[u8], offset: usize) -> [u8; 4] {
    let mut word = [0u8; 4];
    word.copy_from_slice(&bytes[offset..offset + 4]);
    word
}

/// Reads the header, or `None` when `bytes` is not a whole MRC header.
pub fn read_header(bytes: &[u8]) -> Option<MrcHeader> {
    if !has_map_magic(bytes) || bytes.len() < HEADER_LEN {
        return None;
    }
    let int = |offset| i32::from_le_bytes(word(bytes, offset));
    let mx = int(28);
    let cell_x = f64::from(f32::from_le_bytes(word(bytes, 40)));
    Some(MrcHeader {
        nx: int(0),
        ny: int(4),
        nz: int(8),
        angpix: if mx > 0 && cell_x > 0.0 {
            cell_x / f64::from(mx)
        } else {
            1.0
        },
    })
}

/// An MRC2014 file: mode 2 (float32), little endian, no extended header,
/// `DMIN`, `DMAX`, `DMEAN` and `RMS` from the data. A `stack` is an image
/// stack (`ISPG` 0, `MZ` 1); otherwise a volume or image (`ISPG` 1, `MZ` = `NZ`).
pub fn write(
    nx: usize,
    ny: usize,
    nz: usize,
    data: &[f32],
    angpix: f64,
    stack: bool,
    label: &str,
) -> Vec<u8> {
    assert_eq!(
        data.len(),
        nx * ny * nz,
        "MRC data length does not match its dimensions"
    );
    let mz = if stack { 1 } else { nz };
    let count = data.len().max(1) as f64;
    let (minimum, maximum, sum) = data.iter().fold(
        (f64::INFINITY, f64::NEG_INFINITY, 0.0),
        |(minimum, maximum, sum), value| {
            let value = f64::from(*value);
            (minimum.min(value), maximum.max(value), sum + value)
        },
    );
    let (minimum, maximum) = if data.is_empty() {
        (0.0, 0.0)
    } else {
        (minimum, maximum)
    };
    let mean = sum / count;
    let squares: f64 = data
        .iter()
        .map(|value| (f64::from(*value) - mean).powi(2))
        .sum();
    let mut header = vec![0u8; HEADER_LEN];
    let mut int = |offset: usize, value: i32| {
        header[offset..offset + 4].copy_from_slice(&value.to_le_bytes())
    };
    for (offset, value) in [
        (0, nx as i32),
        (4, ny as i32),
        (8, nz as i32),
        (12, 2),
        (28, nx as i32),
        (32, ny as i32),
        (36, mz as i32),
        (64, 1),
        (68, 2),
        (72, 3),
        (88, i32::from(!stack)),
        (108, 20140),
        (220, 1),
    ] {
        int(offset, value);
    }
    let mut float = |offset: usize, value: f64| {
        header[offset..offset + 4].copy_from_slice(&(value as f32).to_le_bytes())
    };
    for (offset, value) in [
        (40, nx as f64 * angpix),
        (44, ny as f64 * angpix),
        (48, mz as f64 * angpix),
        (52, 90.0),
        (56, 90.0),
        (60, 90.0),
        (76, minimum),
        (80, maximum),
        (84, mean),
        (216, (squares / count).sqrt()),
    ] {
        float(offset, value);
    }
    header[MAGIC_OFFSET..MAGIC_OFFSET + 4].copy_from_slice(b"MAP ");
    header[212] = 0x44;
    header[213] = 0x44;
    let label = label.as_bytes();
    let length = label.len().min(80);
    header[224..224 + length].copy_from_slice(&label[..length]);
    let mut bytes = header;
    bytes.reserve(data.len() * 4);
    for value in data {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_map_magic() {
        let mut header = vec![0u8; HEADER_LEN];
        assert!(!has_map_magic(&header));
        header[MAGIC_OFFSET..MAGIC_OFFSET + 4].copy_from_slice(b"MAP ");
        assert!(has_map_magic(&header));
        assert!(!has_map_magic(&header[..210]));
    }

    #[test]
    fn writes_and_reads_mrc2014() {
        let bytes = write(4, 2, 3, &[1.0; 24], 0.5, true, "test");
        assert_eq!(bytes.len(), HEADER_LEN + 96);
        let header = read_header(&bytes).unwrap();
        assert_eq!((header.nx, header.ny, header.nz), (4, 2, 3));
        assert_eq!(header.angpix, 0.5);
        assert_eq!(i32::from_le_bytes(word(&bytes, 36)), 1);
        assert_eq!(i32::from_le_bytes(word(&bytes, 88)), 0);
        assert_eq!(&bytes[212..214], &[0x44, 0x44]);
        let volume = write(
            2,
            2,
            2,
            &[0.0, 2.0, 0.0, 2.0, 0.0, 2.0, 0.0, 2.0],
            1.0,
            false,
            "test",
        );
        assert_eq!(i32::from_le_bytes(word(&volume, 36)), 2);
        assert_eq!(f32::from_le_bytes(word(&volume, 84)), 1.0);
        assert_eq!(f32::from_le_bytes(word(&volume, 216)), 1.0);
        assert!(read_header(&volume[..512]).is_none());
    }
}
