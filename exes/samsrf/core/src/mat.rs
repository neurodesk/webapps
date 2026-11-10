//! MATLAB MAT v5 reader for numeric arrays: enough for `aps_*.mat` (`ApFrm`, `ApXY`,
//! `ApCond`) and `hrf_*.mat` (`fP`). Handles `miCOMPRESSED` elements (zlib), every
//! numeric class, the storage compression MATLAB applies (a double array stored as
//! `miUINT8` or `miINT16` elements), logical arrays, both endians, and skips character,
//! cell and struct variables. A v7.3 (HDF5) file is refused with a message saying so.

use crate::apertures::Apertures;
use crate::error::{Error, Result};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatClass {
    Double,
    Single,
    Int8,
    Uint8,
    Int16,
    Uint16,
    Int32,
    Uint32,
    Int64,
    Uint64,
    Logical,
}

/// A numeric array in column-major order, values widened to f64.
#[derive(Debug, Clone, PartialEq)]
pub struct MatArray {
    pub class: MatClass,
    pub dims: Vec<usize>,
    pub data: Vec<f64>,
}

impl MatArray {
    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MatFile {
    pub variables: BTreeMap<String, MatArray>,
}

const HEADER_LEN: usize = 128;
const MI_INT8: u32 = 1;
const MI_UINT8: u32 = 2;
const MI_INT16: u32 = 3;
const MI_UINT16: u32 = 4;
const MI_INT32: u32 = 5;
const MI_UINT32: u32 = 6;
const MI_SINGLE: u32 = 7;
const MI_DOUBLE: u32 = 9;
const MI_INT64: u32 = 12;
const MI_UINT64: u32 = 13;
const MI_MATRIX: u32 = 14;
const MI_COMPRESSED: u32 = 15;
const MI_UTF8: u32 = 16;
const LOGICAL_FLAG: u32 = 0x0200;

fn format_error(message: impl Into<String>) -> Error {
    Error::format("MAT", message)
}

/// One data element: its type and payload, and where the next element starts.
struct Element<'a> {
    kind: u32,
    data: &'a [u8],
    next: usize,
}

#[derive(Clone, Copy)]
struct Endian {
    big: bool,
}

impl Endian {
    fn u32(self, bytes: &[u8], offset: usize) -> Result<u32> {
        let raw: [u8; 4] = bytes
            .get(offset..offset + 4)
            .and_then(|slice| slice.try_into().ok())
            .ok_or_else(|| format_error("file ends inside a data element tag"))?;
        Ok(if self.big { u32::from_be_bytes(raw) } else { u32::from_le_bytes(raw) })
    }

    /// Reads the element at `offset`, in the small (4-byte packed) or the normal format.
    /// Normal payloads are padded to 8 bytes, except `miCOMPRESSED` ones.
    fn element(self, bytes: &[u8], offset: usize) -> Result<Element<'_>> {
        let word = self.u32(bytes, offset)?;
        let small_size = (word >> 16) as usize;
        if small_size != 0 {
            if small_size > 4 {
                return Err(format_error(format!("small data element at byte {offset} claims {small_size} bytes")));
            }
            let data = bytes
                .get(offset + 4..offset + 4 + small_size)
                .ok_or_else(|| format_error(format!("small data element at byte {offset} runs past the end of the file")))?;
            return Ok(Element { kind: word & 0xffff, data, next: offset + 8 });
        }
        let size = self.u32(bytes, offset + 4)? as usize;
        let start = offset + 8;
        let data = bytes
            .get(start..start.saturating_add(size))
            .ok_or_else(|| format_error(format!("data element at byte {offset} runs past the end of the file")))?;
        let end = start + size;
        let next = if word == MI_COMPRESSED { end } else { end.div_ceil(8) * 8 };
        Ok(Element { kind: word, data, next: next.min(bytes.len()) })
    }
}

pub fn read(bytes: &[u8]) -> Result<MatFile> {
    if is_v73(bytes) {
        return Err(format_error("MATLAB v7.3 (HDF5) files are not supported; save with -v7"));
    }
    if bytes.len() < HEADER_LEN {
        return Err(format_error("file is shorter than the 128-byte MAT v5 header"));
    }
    let endian = match &bytes[126..128] {
        b"IM" => Endian { big: false },
        b"MI" => Endian { big: true },
        _ => return Err(format_error("not a MAT v5 file (no endian indicator; MAT v4 files are not supported)")),
    };
    let version = endian.u32(bytes, 124)?;
    let version = if endian.big { version >> 16 } else { version & 0xffff };
    if version != 0x0100 {
        return Err(format_error(format!("unsupported MAT version {version:#06x}")));
    }
    let mut file = MatFile::default();
    read_elements(bytes, HEADER_LEN, endian, &mut file)?;
    Ok(file)
}

fn is_v73(bytes: &[u8]) -> bool {
    const HDF5: &[u8] = b"\x89HDF\r\n\x1a\n";
    bytes.starts_with(b"MATLAB 7.3 MAT-file") || bytes.starts_with(HDF5) || bytes.get(512..520) == Some(HDF5)
}

fn read_elements(bytes: &[u8], mut offset: usize, endian: Endian, file: &mut MatFile) -> Result<()> {
    while offset + 8 <= bytes.len() {
        let element = endian.element(bytes, offset)?;
        match element.kind {
            MI_COMPRESSED => {
                let inflated = miniz_oxide::inflate::decompress_to_vec_zlib(element.data)
                    .map_err(|error| format_error(format!("miCOMPRESSED element at byte {offset} does not inflate: {error}")))?;
                read_elements(&inflated, 0, endian, file)?;
            }
            MI_MATRIX => {
                if let Some((name, array)) = read_matrix(element.data, endian)? {
                    file.variables.insert(name, array);
                }
            }
            _ => {}
        }
        offset = element.next;
    }
    Ok(())
}

/// Parses an `miMATRIX` payload, or `None` for classes this reader skips.
fn read_matrix(data: &[u8], endian: Endian) -> Result<Option<(String, MatArray)>> {
    if data.is_empty() {
        return Ok(None);
    }
    let flags = endian.element(data, 0)?;
    if flags.kind != MI_UINT32 || flags.data.len() < 8 {
        return Err(format_error("array flags are not an 8-byte miUINT32 element"));
    }
    let word = endian.u32(flags.data, 0)?;
    let dims_element = endian.element(data, flags.next)?;
    if dims_element.kind != MI_INT32 {
        return Err(format_error("array dimensions are not miINT32"));
    }
    let dims = (0..dims_element.data.len() / 4)
        .map(|axis| {
            let value = endian.u32(dims_element.data, axis * 4)? as i32;
            usize::try_from(value).map_err(|_| format_error(format!("negative array dimension {value}")))
        })
        .collect::<Result<Vec<usize>>>()?;
    let name_element = endian.element(data, dims_element.next)?;
    if name_element.kind != MI_INT8 && name_element.kind != MI_UTF8 {
        return Err(format_error("array name is not miINT8"));
    }
    let name = String::from_utf8_lossy(name_element.data).into_owned();
    let class = match word & 0xff {
        6 => MatClass::Double,
        7 => MatClass::Single,
        8 => MatClass::Int8,
        9 if word & LOGICAL_FLAG != 0 => MatClass::Logical,
        9 => MatClass::Uint8,
        10 => MatClass::Int16,
        11 => MatClass::Uint16,
        12 => MatClass::Int32,
        13 => MatClass::Uint32,
        14 => MatClass::Int64,
        15 => MatClass::Uint64,
        _ => return Ok(None),
    };
    let real = endian.element(data, name_element.next)?;
    let values = numeric_values(real.kind, real.data, endian)
        .map_err(|message| format_error(format!("variable {name}: {message}")))?;
    let expected: usize = dims.iter().product();
    if values.len() != expected {
        return Err(format_error(format!(
            "variable {name} has {} values for dimensions {dims:?}",
            values.len()
        )));
    }
    Ok(Some((name, MatArray { class, dims, data: values })))
}

/// Widens the stored element type, which MATLAB may narrow from the array class.
fn numeric_values(kind: u32, data: &[u8], endian: Endian) -> std::result::Result<Vec<f64>, String> {
    macro_rules! widen {
        ($t:ty) => {{
            const WIDTH: usize = std::mem::size_of::<$t>();
            if !data.len().is_multiple_of(WIDTH) {
                return Err(format!("{} bytes is not a whole number of {WIDTH}-byte values", data.len()));
            }
            data.chunks_exact(WIDTH)
                .map(|chunk| {
                    let mut raw = [0u8; WIDTH];
                    raw.copy_from_slice(chunk);
                    let value = if endian.big { <$t>::from_be_bytes(raw) } else { <$t>::from_le_bytes(raw) };
                    value as f64
                })
                .collect()
        }};
    }
    let values = match kind {
        MI_INT8 => widen!(i8),
        MI_UINT8 => widen!(u8),
        MI_INT16 => widen!(i16),
        MI_UINT16 => widen!(u16),
        MI_INT32 => widen!(i32),
        MI_UINT32 => widen!(u32),
        MI_SINGLE => widen!(f32),
        MI_DOUBLE => widen!(f64),
        MI_INT64 => widen!(i64),
        MI_UINT64 => widen!(u64),
        _ => return Err(format!("real part has non-numeric element type {kind}")),
    };
    Ok(values)
}

/// Loads `ApFrm` (+ `ApXY`, `ApCond`) from an aperture MAT file into `Apertures`,
/// vectorising a movie file as `samsrf_fit_prf` does when `ApXY` is absent.
pub fn read_apertures(bytes: &[u8]) -> Result<Apertures> {
    let file = read(bytes)?;
    let ap_frm = file
        .variables
        .get("ApFrm")
        .ok_or_else(|| format_error("aperture file has no numeric ApFrm variable"))?;
    if let Some(ap_xy) = file.variables.get("ApXY") {
        if ap_frm.dims.len() != 2 {
            return Err(format_error(format!("vectorised ApFrm must be pixels x volumes, not {:?}", ap_frm.dims)));
        }
        if ap_xy.dims.len() != 2 || ap_xy.dims[1] != 2 {
            return Err(format_error(format!("ApXY must be pixels x 2, not {:?}", ap_xy.dims)));
        }
        return Apertures::from_vectorised(ap_frm.dims[0], ap_frm.dims[1], &ap_frm.data, &ap_xy.data);
    }
    let (height, width, volumes) = match ap_frm.dims[..] {
        [height, width] => (height, width, 1),
        [height, width, volumes] => (height, width, volumes),
        _ => return Err(format_error(format!("ApFrm must be height x width x volumes, not {:?}", ap_frm.dims))),
    };
    let conditions = file.variables.get("ApCond").map(|ap_cond| ap_cond.data.clone());
    Apertures::from_dense(height, width, volumes, &ap_frm.data, conditions)
}

/// Loads `fP` from an old-school `hrf_*.mat` file.
pub fn read_old_school_hrf(bytes: &[u8]) -> Result<[f64; 4]> {
    let file = read(bytes)?;
    let fp = file.variables.get("fP").ok_or_else(|| format_error("HRF file has no numeric fP variable"))?;
    <[f64; 4]>::try_from(fp.data.as_slice())
        .map_err(|_| format_error(format!("fP has {} values; an old-school HRF has 4", fp.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Writer {
        big: bool,
    }

    impl Writer {
        fn u32(&self, value: u32) -> [u8; 4] {
            if self.big {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            }
        }

        fn header(&self) -> Vec<u8> {
            let mut bytes = vec![b' '; 116];
            bytes[..19].copy_from_slice(b"MATLAB 5.0 MAT-file");
            bytes.extend_from_slice(&[0; 8]);
            if self.big {
                bytes.extend_from_slice(&[0x01, 0x00, b'M', b'I']);
            } else {
                bytes.extend_from_slice(&[0x00, 0x01, b'I', b'M']);
            }
            bytes
        }

        fn element(&self, kind: u32, data: &[u8]) -> Vec<u8> {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&self.u32(kind));
            bytes.extend_from_slice(&self.u32(data.len() as u32));
            bytes.extend_from_slice(data);
            if kind != MI_COMPRESSED {
                bytes.resize(bytes.len().div_ceil(8) * 8, 0);
            }
            bytes
        }

        fn small(&self, kind: u32, data: &[u8]) -> Vec<u8> {
            let mut bytes = self.u32(((data.len() as u32) << 16) | kind).to_vec();
            bytes.extend_from_slice(data);
            bytes.resize(8, 0);
            bytes
        }

        fn matrix(&self, flags: u32, dims: &[u32], name: &str, real: Vec<u8>) -> Vec<u8> {
            let mut body = self.element(MI_UINT32, &[self.u32(flags), [0; 4]].concat());
            let dims: Vec<u8> = dims.iter().flat_map(|dim| self.u32(*dim)).collect();
            body.extend(self.element(MI_INT32, &dims));
            body.extend(self.element(MI_INT8, name.as_bytes()));
            body.extend(real);
            self.element(MI_MATRIX, &body)
        }

        fn doubles(&self, values: &[f64]) -> Vec<u8> {
            let bytes: Vec<u8> = values
                .iter()
                .flat_map(|value| if self.big { value.to_be_bytes() } else { value.to_le_bytes() })
                .collect();
            self.element(MI_DOUBLE, &bytes)
        }
    }

    fn compressed(writer: &Writer, element: &[u8]) -> Vec<u8> {
        writer.element(MI_COMPRESSED, &miniz_oxide::deflate::compress_to_vec_zlib(element, 6))
    }

    #[test]
    fn reads_narrowed_storage_small_elements_logicals_and_skips_text() {
        let writer = Writer { big: false };
        let mut bytes = writer.header();
        bytes.extend(writer.matrix(6, &[2, 3], "stored_u8", writer.element(MI_UINT8, &[0, 1, 2, 3, 4, 255])));
        let int16: Vec<u8> = [-3i16, 7].iter().flat_map(|value| value.to_le_bytes()).collect();
        bytes.extend(writer.matrix(10, &[1, 2], "small_i16", writer.small(MI_INT16, &int16)));
        bytes.extend(writer.matrix(9 | LOGICAL_FLAG, &[1, 3], "mask", writer.element(MI_UINT8, &[1, 0, 1])));
        bytes.extend(writer.matrix(4, &[1, 2], "text", writer.element(MI_UINT16, &[b'h', 0, b'i', 0])));
        let inner = writer.matrix(7, &[1, 1], "single", writer.element(MI_SINGLE, &1.5f32.to_le_bytes()));
        bytes.extend(compressed(&writer, &inner));
        bytes.extend(writer.matrix(6, &[1, 1], "after", writer.doubles(&[-2.25])));
        let file = read(&bytes).expect("valid MAT file");
        let names: Vec<&str> = file.variables.keys().map(String::as_str).collect();
        assert_eq!(names, ["after", "mask", "single", "small_i16", "stored_u8"]);
        let stored = &file.variables["stored_u8"];
        assert_eq!((stored.class, stored.dims.as_slice()), (MatClass::Double, &[2, 3][..]));
        assert_eq!(stored.data, [0.0, 1.0, 2.0, 3.0, 4.0, 255.0]);
        assert_eq!(file.variables["small_i16"].data, [-3.0, 7.0]);
        assert_eq!(file.variables["mask"].class, MatClass::Logical);
        assert_eq!(file.variables["mask"].data, [1.0, 0.0, 1.0]);
        assert_eq!(file.variables["single"].data, [1.5]);
        assert_eq!(file.variables["after"].data, [-2.25]);
    }

    #[test]
    fn reads_big_endian() {
        let writer = Writer { big: true };
        let mut bytes = writer.header();
        bytes.extend(writer.matrix(6, &[2, 1], "x", writer.doubles(&[0.1, -7.0])));
        let file = read(&bytes).expect("valid MAT file");
        assert_eq!(file.variables["x"].data, [0.1, -7.0]);
    }

    #[test]
    fn refuses_v73_truncated_and_mismatched_files() {
        let mut v73 = b"MATLAB 7.3 MAT-file, Platform: GLNXA64".to_vec();
        v73.resize(600, 0);
        let refused = read(&v73);
        assert_eq!(refused, Err(Error::format("MAT", "MATLAB v7.3 (HDF5) files are not supported; save with -v7")));
        let writer = Writer { big: false };
        let mut bytes = writer.header();
        bytes.extend(writer.matrix(6, &[2, 2], "x", writer.doubles(&[1.0, 2.0, 3.0, 4.0])));
        let truncated = read(&bytes[..bytes.len() - 12]);
        assert!(matches!(truncated, Err(Error::Format { message, .. }) if message.contains("past the end")));
        let mut mismatched = writer.header();
        mismatched.extend(writer.matrix(6, &[2, 2], "x", writer.doubles(&[1.0, 2.0, 3.0])));
        assert!(matches!(read(&mismatched), Err(Error::Format { message, .. }) if message.contains("variable x")));
        assert!(read(&[0; 64]).is_err());
    }

    #[test]
    fn movie_apertures_and_vectorised_apertures() {
        let writer = Writer { big: false };
        let mut movie = vec![0.0; 4 * 6 * 2];
        movie[5] = 1.0;
        let mut bytes = writer.header();
        bytes.extend(writer.matrix(6, &[4, 6, 2], "ApFrm", writer.doubles(&movie)));
        bytes.extend(writer.matrix(6, &[1, 2], "ApCond", writer.doubles(&[1.0, 2.0])));
        let apertures = read_apertures(&bytes).expect("valid aperture file");
        assert_eq!(apertures, Apertures::from_dense(4, 6, 2, &movie, Some(vec![1.0, 2.0])).expect("valid movie"));

        let ap_xy = [0.5, -0.5, 0.25, 0.75];
        let mut vectorised = writer.header();
        vectorised.extend(writer.matrix(6, &[3, 2], "ApFrm", writer.doubles(&[7.0, 1.0, 0.0, 8.0, 0.0, 1.0])));
        vectorised.extend(writer.matrix(6, &[2, 2], "ApXY", writer.doubles(&ap_xy)));
        let apertures = read_apertures(&vectorised).expect("valid vectorised file");
        assert_eq!(apertures.conditions, Some(vec![7.0, 8.0]));
        assert_eq!(apertures.xy, vec![[0.5, 0.25], [-0.5, 0.75]]);
        assert_eq!(apertures.to_dense(), [1.0, 0.0, 0.0, 1.0]);

        let mut no_frames = writer.header();
        no_frames.extend(writer.matrix(6, &[1, 1], "fP", writer.doubles(&[1.0])));
        assert!(read_apertures(&no_frames).is_err());
        assert!(read_old_school_hrf(&no_frames).is_err());
    }

    fn example(path: &str) -> Option<Vec<u8>> {
        let Ok(directory) = std::env::var("SAMSRF_EXAMPLE_DIR") else {
            println!("skipped: SAMSRF_EXAMPLE_DIR unset");
            return None;
        };
        Some(std::fs::read(std::path::Path::new(&directory).join(path)).expect("example file"))
    }

    /// Expected values from `scipy.io.loadmat` on X001 `prf/aps_Bars.mat` (stored as miDOUBLE
    /// inside miCOMPRESSED): 100 x 100 x 250, 208138 non-zero values, `math.fsum` 120975.5186976427.
    #[test]
    fn example_bar_apertures_match_scipy() {
        let Some(bytes) = example("prf/aps_Bars.mat") else { return };
        let file = read(&bytes).expect("aps_Bars.mat parses");
        let ap_frm = &file.variables["ApFrm"];
        assert_eq!((ap_frm.class, ap_frm.dims.as_slice()), (MatClass::Double, &[100, 100, 250][..]));
        let apertures = read_apertures(&bytes).expect("aps_Bars.mat apertures");
        assert_eq!((apertures.height, apertures.width, apertures.volumes()), (100, 100, 250));
        let nonzero: usize = apertures.frames.iter().map(|frame| frame.indices.len()).sum();
        assert_eq!(nonzero, 208138);
        assert_eq!(apertures.frames[0].indices.len(), 368);
        assert!(apertures.frames[100].indices.is_empty());
        assert_eq!(apertures.frames[0].indices[..3], [2592, 2593, 2594]);
        assert_eq!(apertures.frames[0].values[0].to_bits(), 0x3f125bf476f8750e);
        assert_eq!(apertures.frames[0].values[1].to_bits(), 0xbf46b9761da006b0);
        let last = &apertures.frames[224];
        assert_eq!(*last.indices.last().expect("frame 224 has pixels"), 3604);
        assert_eq!(last.values[last.values.len() - 2].to_bits(), 0xbf365d1535caf120);
        assert_eq!(last.values[last.values.len() - 1].to_bits(), 0x3f0137fd596e085e);
        let dense = apertures.to_dense();
        let sum: f64 = dense.iter().sum();
        assert!((sum - 120975.5186976427).abs() < 1e-6, "sum {sum}");
        assert!(apertures.has_negative_values());
    }

    /// `scipy.io.loadmat(..., mat_dtype=True)` on X001 `prf/hrf_fit.mat`: fP is a double
    /// [8 13 2 1] that MATLAB stored as miUINT8.
    #[test]
    fn example_old_school_hrf_matches_scipy() {
        let Some(bytes) = example("prf/hrf_fit.mat") else { return };
        let file = read(&bytes).expect("hrf_fit.mat parses");
        assert_eq!(file.variables["fP"].class, MatClass::Double);
        assert_eq!(read_old_school_hrf(&bytes), Ok([8.0, 13.0, 2.0, 1.0]));
    }
}

