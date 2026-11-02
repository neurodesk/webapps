//! GIFTI reader and writer.
//!
//! Reads every encoding (`ASCII`, `Base64Binary`, `GZipBase64Binary`, both zlib and gzip
//! framing; `ExternalFileBinary` is refused), `NIFTI_TYPE_FLOAT32`, `INT32` and `UINT8`,
//! both endians, any number of DataArrays, and `ColumnMajorOrder` or `RowMajorOrder` for
//! 2-D arrays. The writer produces what SPM's `gifti/save` writes for `samsrf_export_giis`:
//! one float32 DataArray, `GZipBase64Binary` (zlib), `RowMajorOrder`, little-endian.

use crate::error::{Error, Result};
use crate::surface::{Faces, Surface};
use crate::timeseries::RawRun;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Float32,
    Int32,
    Uint8,
}

/// One `<DataArray>`, decoded. `data` is f64 in the file's own element order after
/// resolving the indexing order to column-major for 2-D arrays (MATLAB's layout).
#[derive(Debug, Clone, PartialEq)]
pub struct DataArray {
    pub intent: String,
    pub data_type: DataType,
    pub dims: Vec<usize>,
    pub data: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gifti {
    pub arrays: Vec<DataArray>,
}

fn format_error(message: impl Into<String>) -> Error {
    Error::format("GIFTI", message)
}

/// Parses a whole GIFTI file.
pub fn read(bytes: &[u8]) -> Result<Gifti> {
    let arrays = scan(bytes)?
        .iter()
        .enumerate()
        .map(|(index, raw)| decode(raw).map_err(|error| in_array(index, error)))
        .collect::<Result<Vec<DataArray>>>()?;
    Ok(Gifti { arrays })
}

/// Reads a functional run: every DataArray is one volume over all vertices (the
/// `NIFTI_INTENT_TIME_SERIES` layout mri_vol2surf writes). Arrays are decoded one at a
/// time and scattered into the vertex-major `RawRun`, so the peak allocation is the run
/// plus one array.
///
/// A 2-D array counts as one volume per column (`vertices x volumes`), as SPM's
/// `gifti(...).cdata` presents it, so a run stored as one matrix reads the same.
pub fn read_run(bytes: &[u8]) -> Result<RawRun> {
    let raws = scan(bytes)?;
    let headers = raws
        .iter()
        .enumerate()
        .map(|(index, raw)| Header::parse(raw.attributes).map_err(|error| in_array(index, error)))
        .collect::<Result<Vec<Header>>>()?;
    let Some(first) = headers.first() else {
        return Err(format_error("file has no DataArray"));
    };
    let vertices = first.dims[0];
    if vertices == 0 {
        return Err(format_error("DataArray 0 has no vertices"));
    }
    let mut volumes = 0;
    for (index, header) in headers.iter().enumerate() {
        if header.dims[0] != vertices {
            return Err(format_error(format!(
                "DataArray {index} has {} vertices but DataArray 0 has {vertices}",
                header.dims[0]
            )));
        }
        volumes += header.dims[1..].iter().product::<usize>();
    }
    let mut data = vec![0f32; vertices * volumes];
    let mut volume = 0;
    for (index, (raw, header)) in raws.iter().zip(&headers).enumerate() {
        let values = header.values(raw.data).map_err(|error| in_array(index, error))?;
        for column in values.chunks_exact(vertices) {
            for (vertex, value) in column.iter().enumerate() {
                data[vertex * volumes + volume] = *value as f32;
            }
            volume += 1;
        }
    }
    Ok(RawRun { volumes, vertices, data })
}

/// Reads a mesh: the `NIFTI_INTENT_POINTSET` and `NIFTI_INTENT_TRIANGLE` arrays.
pub fn read_surface(bytes: &[u8]) -> Result<Surface> {
    let gifti = read(bytes)?;
    let find = |intent: &str| {
        gifti
            .arrays
            .iter()
            .find(|array| array.intent == intent)
            .ok_or_else(|| format_error(format!("surface has no {intent} DataArray")))
    };
    let points = find("NIFTI_INTENT_POINTSET")?;
    let triangles = find("NIFTI_INTENT_TRIANGLE")?;
    let vertices = columns3(points, "NIFTI_INTENT_POINTSET")?;
    let faces = columns3(triangles, "NIFTI_INTENT_TRIANGLE")?
        .into_iter()
        .map(|face| {
            let mut indices = [0u32; 3];
            for (slot, value) in indices.iter_mut().zip(face) {
                if value < 0.0 || value >= vertices.len() as f64 || value.fract() != 0.0 {
                    return Err(format_error(format!(
                        "triangle index {value} is not a vertex of a {}-vertex mesh",
                        vertices.len()
                    )));
                }
                *slot = value as u32;
            }
            Ok(indices)
        })
        .collect::<Result<Vec<[u32; 3]>>>()?;
    Ok(Surface { vertices, faces: Faces::Triangles(faces) })
}

/// Rows of an `n x 3` array stored column-major.
fn columns3(array: &DataArray, intent: &str) -> Result<Vec<[f64; 3]>> {
    if array.dims.len() != 2 || array.dims[1] != 3 {
        return Err(format_error(format!("{intent} array must be n x 3, not {:?}", array.dims)));
    }
    let rows = array.dims[0];
    Ok((0..rows)
        .map(|row| [array.data[row], array.data[row + rows], array.data[row + 2 * rows]])
        .collect())
}

/// Writes one per-vertex map as `samsrf_export_giis` does (float32, zlib-compressed
/// base64, `RowMajorOrder`).
pub fn write_map(values: &[f64]) -> Vec<u8> {
    let raw: Vec<u8> = values.iter().flat_map(|value| (*value as f32).to_le_bytes()).collect();
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let encoded = base64::engine::general_purpose::STANDARD.encode(compressed);
    let count = values.len();
    let mut xml = String::with_capacity(encoded.len() + 1024);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<!DOCTYPE GIFTI SYSTEM \"http://www.nitrc.org/frs/download.php/115/gifti.dtd\">\n");
    xml.push_str("<GIFTI Version=\"1.0\"  NumberOfDataArrays=\"1\">\n");
    xml.push_str("   <MetaData/>\n");
    xml.push_str("   <LabelTable/>\n");
    xml.push_str("   <DataArray Intent=\"NIFTI_INTENT_NONE\"\n");
    xml.push_str("              DataType=\"NIFTI_TYPE_FLOAT32\"\n");
    xml.push_str("              ArrayIndexingOrder=\"RowMajorOrder\"\n");
    xml.push_str("              Dimensionality=\"1\"\n");
    xml.push_str(&format!("              Dim0=\"{count}\"\n"));
    xml.push_str("              Encoding=\"GZipBase64Binary\"\n");
    xml.push_str("              Endian=\"LittleEndian\"\n");
    xml.push_str("              ExternalFileName=\"\"\n");
    xml.push_str("              ExternalFileOffset=\"\">\n");
    xml.push_str("      <MetaData/>\n");
    xml.push_str("      <Data>");
    xml.push_str(&encoded);
    xml.push_str("</Data>\n");
    xml.push_str("   </DataArray>\n");
    xml.push_str("</GIFTI>\n");
    xml.into_bytes()
}

fn in_array(index: usize, error: Error) -> Error {
    match error {
        Error::Format { format, message } => Error::Format { format, message: format!("DataArray {index}: {message}") },
        other => other,
    }
}

/// A `<DataArray>` before decoding: its attribute text and the raw `<Data>` content.
struct RawArray<'a> {
    attributes: &'a [u8],
    data: &'a [u8],
}

fn find(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

/// The index just past the `>` closing the tag that starts at `start`, honouring quotes.
fn tag_end(bytes: &[u8], start: usize) -> Result<usize> {
    let mut quote = None;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        match (quote, *byte) {
            (None, b'"' | b'\'') => quote = Some(*byte),
            (Some(open), _) if *byte == open => quote = None,
            (None, b'>') => return Ok(start + offset + 1),
            _ => {}
        }
    }
    Err(format_error(format!("tag at byte {start} is never closed")))
}

/// Skips a comment, CDATA section, processing instruction or declaration at `start`,
/// returning the index after it, or `None` when `start` opens an element tag.
fn skip_markup(bytes: &[u8], start: usize) -> Result<Option<usize>> {
    let rest = &bytes[start..];
    let terminator: &[u8] = if rest.starts_with(b"<!--") {
        b"-->"
    } else if rest.starts_with(b"<![CDATA[") {
        b"]]>"
    } else if rest.starts_with(b"<?") {
        b"?>"
    } else if rest.starts_with(b"<!") {
        b">"
    } else {
        return Ok(None);
    };
    let end = find(bytes, start + 2, terminator).ok_or_else(|| format_error(format!("markup at byte {start} is never closed")))?;
    Ok(Some(end + terminator.len()))
}

/// Finds every DataArray's attributes and data text without decoding anything.
fn scan(bytes: &[u8]) -> Result<Vec<RawArray<'_>>> {
    let mut arrays = Vec::new();
    let mut open: Option<(&[u8], &[u8])> = None;
    let mut position = 0;
    while let Some(start) = find(bytes, position, b"<") {
        if let Some(next) = skip_markup(bytes, start)? {
            position = next;
            continue;
        }
        let end = tag_end(bytes, start)?;
        let inner = &bytes[start + 1..end - 1];
        let closing = usize::from(inner.starts_with(b"/"));
        let name_length = inner[closing..]
            .iter()
            .position(|byte| byte.is_ascii_whitespace() || *byte == b'/')
            .map_or(inner.len(), |length| length + closing);
        let name = &inner[..name_length];
        let self_closing = inner.ends_with(b"/");
        position = end;
        match name {
            b"DataArray" => {
                let attributes = &inner[name_length..inner.len() - usize::from(self_closing)];
                if self_closing {
                    arrays.push(RawArray { attributes, data: &[] });
                } else {
                    open = Some((attributes, &[]));
                }
            }
            b"Data" => {
                let Some((attributes, _)) = open else {
                    return Err(format_error(format!("<Data> at byte {start} is outside a DataArray")));
                };
                if self_closing {
                    open = Some((attributes, &[]));
                    continue;
                }
                let close = data_end(bytes, end)?;
                open = Some((attributes, &bytes[end..close]));
                position = close;
            }
            b"/DataArray" => {
                let (attributes, data) = open.take().ok_or_else(|| format_error(format!("</DataArray> at byte {start} closes nothing")))?;
                arrays.push(RawArray { attributes, data });
            }
            _ => {}
        }
    }
    if open.is_some() {
        return Err(format_error("a DataArray is never closed"));
    }
    Ok(arrays)
}

/// Where the `<Data>` text that starts at `start` ends, skipping CDATA sections.
fn data_end(bytes: &[u8], start: usize) -> Result<usize> {
    let mut position = start;
    loop {
        let lt = find(bytes, position, b"<").ok_or_else(|| format_error("<Data> is never closed"))?;
        if bytes[lt..].starts_with(b"</Data") {
            return Ok(lt);
        }
        position = skip_markup(bytes, lt)?.ok_or_else(|| format_error(format!("unexpected tag inside <Data> at byte {lt}")))?;
    }
}

/// Attribute `name="value"` pairs, in any order.
fn attributes(text: &[u8]) -> Result<Vec<(&str, &str)>> {
    let text = std::str::from_utf8(text).map_err(|_| format_error("DataArray attributes are not UTF-8"))?;
    let mut pairs = Vec::new();
    let mut rest = text.trim_start();
    while !rest.is_empty() {
        let equals = rest.find('=').ok_or_else(|| format_error(format!("attribute without a value near {rest:.40}")))?;
        let name = rest[..equals].trim();
        let after = rest[equals + 1..].trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'');
        let quote = quote.ok_or_else(|| format_error(format!("attribute {name} has an unquoted value")))?;
        let close = after[1..].find(quote).ok_or_else(|| format_error(format!("attribute {name} is never closed")))?;
        pairs.push((name, &after[1..close + 1]));
        rest = after[close + 2..].trim_start();
    }
    Ok(pairs)
}

#[derive(Clone, Copy, PartialEq)]
enum Encoding {
    Ascii,
    Base64,
    GzipBase64,
}

/// What the attributes say about a DataArray's storage.
struct Header {
    intent: String,
    data_type: DataType,
    dims: Vec<usize>,
    encoding: Encoding,
    big_endian: bool,
    row_major: bool,
}

impl Header {
    fn parse(text: &[u8]) -> Result<Self> {
        let pairs = attributes(text)?;
        let get = |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| *value);
        let require = |name: &str| get(name).ok_or_else(|| format_error(format!("missing attribute {name}")));
        let data_type = match require("DataType")? {
            "NIFTI_TYPE_FLOAT32" => DataType::Float32,
            "NIFTI_TYPE_INT32" => DataType::Int32,
            "NIFTI_TYPE_UINT8" => DataType::Uint8,
            other => return Err(format_error(format!("unsupported DataType {other}"))),
        };
        let encoding = match require("Encoding")? {
            "ASCII" => Encoding::Ascii,
            "Base64Binary" => Encoding::Base64,
            "GZipBase64Binary" => Encoding::GzipBase64,
            "ExternalFileBinary" => return Err(format_error("ExternalFileBinary data is not supported; save the data inside the GIFTI file")),
            other => return Err(format_error(format!("unknown Encoding {other}"))),
        };
        let big_endian = match get("Endian").unwrap_or("LittleEndian") {
            "LittleEndian" => false,
            "BigEndian" => true,
            other => return Err(format_error(format!("unknown Endian {other}"))),
        };
        let row_major = match get("ArrayIndexingOrder").unwrap_or("RowMajorOrder") {
            "RowMajorOrder" => true,
            "ColumnMajorOrder" => false,
            other => return Err(format_error(format!("unknown ArrayIndexingOrder {other}"))),
        };
        let dimensionality: usize = parse_count(require("Dimensionality")?, "Dimensionality")?;
        if dimensionality == 0 {
            return Err(format_error("Dimensionality is 0"));
        }
        let dims = (0..dimensionality)
            .map(|axis| {
                let name = format!("Dim{axis}");
                parse_count(require(&name)?, &name)
            })
            .collect::<Result<Vec<usize>>>()?;
        let intent = get("Intent").unwrap_or("NIFTI_INTENT_NONE").to_string();
        Ok(Self { intent, data_type, dims, encoding, big_endian, row_major })
    }

    fn count(&self) -> usize {
        self.dims.iter().product()
    }

    /// Decodes the `<Data>` text to f64 in column-major order.
    fn values(&self, text: &[u8]) -> Result<Vec<f64>> {
        let text = strip_cdata(text);
        let values = match self.encoding {
            Encoding::Ascii => ascii_values(text)?,
            Encoding::Base64 => self.binary_values(&base64_bytes(text)?)?,
            Encoding::GzipBase64 => {
                let limit = self.count() * self.width();
                self.binary_values(&inflate(&base64_bytes(text)?, limit).map_err(format_error)?)?
            }
        };
        if values.len() != self.count() {
            return Err(format_error(format!("{} values for dimensions {:?}", values.len(), self.dims)));
        }
        if self.row_major && self.dims.len() > 1 {
            return Ok(row_to_column_major(&values, &self.dims));
        }
        Ok(values)
    }

    fn width(&self) -> usize {
        match self.data_type {
            DataType::Float32 | DataType::Int32 => 4,
            DataType::Uint8 => 1,
        }
    }

    fn binary_values(&self, bytes: &[u8]) -> Result<Vec<f64>> {
        let width = self.width();
        if bytes.len() != self.count() * width {
            return Err(format_error(format!(
                "{} data bytes for dimensions {:?} of {width}-byte values",
                bytes.len(),
                self.dims
            )));
        }
        let words = bytes.as_chunks::<4>().0.iter().map(|raw| {
            if self.big_endian {
                u32::from_be_bytes(*raw)
            } else {
                u32::from_le_bytes(*raw)
            }
        });
        Ok(match self.data_type {
            DataType::Float32 => words.map(|word| f32::from_bits(word) as f64).collect(),
            DataType::Int32 => words.map(|word| word as i32 as f64).collect(),
            DataType::Uint8 => bytes.iter().map(|byte| *byte as f64).collect(),
        })
    }
}

fn decode(raw: &RawArray<'_>) -> Result<DataArray> {
    let header = Header::parse(raw.attributes)?;
    let data = header.values(raw.data)?;
    Ok(DataArray { intent: header.intent, data_type: header.data_type, dims: header.dims, data })
}

fn parse_count(text: &str, name: &str) -> Result<usize> {
    text.trim()
        .parse()
        .map_err(|_| format_error(format!("{name}=\"{text}\" is not a non-negative integer")))
}

fn strip_cdata(text: &[u8]) -> &[u8] {
    let trimmed = text.trim_ascii();
    trimmed
        .strip_prefix(b"<![CDATA[")
        .and_then(|inner| inner.strip_suffix(b"]]>"))
        .unwrap_or(trimmed)
}

fn ascii_values(text: &[u8]) -> Result<Vec<f64>> {
    let text = std::str::from_utf8(text).map_err(|_| format_error("ASCII data is not UTF-8"))?;
    text.split_ascii_whitespace()
        .map(|token| token.parse::<f64>().map_err(|_| format_error(format!("ASCII value {token:.40} is not a number"))))
        .collect()
}

fn base64_bytes(text: &[u8]) -> Result<Vec<u8>> {
    const ENGINE: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let compact: Vec<u8> = text.iter().copied().filter(|byte| !byte.is_ascii_whitespace()).collect();
    ENGINE
        .decode(compact)
        .map_err(|error| format_error(format!("invalid base64 data: {error}")))
}

/// Inflates zlib or gzip framing (detected by the gzip magic `1f 8b`), refusing output
/// longer than `limit` bytes.
pub(crate) fn inflate(bytes: &[u8], limit: usize) -> std::result::Result<Vec<u8>, String> {
    let inflated = if bytes.starts_with(&[0x1f, 0x8b]) {
        miniz_oxide::inflate::decompress_to_vec_with_limit(gzip_body(bytes)?, limit)
    } else {
        miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(bytes, limit)
    };
    inflated.map_err(|error| format!("compressed data does not inflate: {error}"))
}

/// The raw deflate stream inside a gzip member (RFC 1952 header fields skipped).
fn gzip_body(bytes: &[u8]) -> std::result::Result<&[u8], String> {
    const FHCRC: u8 = 0x02;
    const FEXTRA: u8 = 0x04;
    const FNAME: u8 = 0x08;
    const FCOMMENT: u8 = 0x10;
    let truncated = || "gzip header is truncated".to_string();
    if bytes.len() < 10 || bytes[2] != 8 {
        return Err("gzip data does not use deflate".to_string());
    }
    let flags = bytes[3];
    let mut position = 10;
    if flags & FEXTRA != 0 {
        let length = bytes.get(position..position + 2).ok_or_else(truncated)?;
        position += 2 + u16::from_le_bytes([length[0], length[1]]) as usize;
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            let nul = bytes.get(position..).and_then(|rest| rest.iter().position(|byte| *byte == 0)).ok_or_else(truncated)?;
            position += nul + 1;
        }
    }
    if flags & FHCRC != 0 {
        position += 2;
    }
    bytes.get(position..).ok_or_else(truncated)
}

/// Reorders values stored with the last index fastest into MATLAB's first-index-fastest order.
fn row_to_column_major(values: &[f64], dims: &[usize]) -> Vec<f64> {
    let mut column_major = vec![0.0; values.len()];
    let mut index = vec![0usize; dims.len()];
    for value in values {
        let mut target = 0;
        let mut stride = 1;
        for (axis, extent) in dims.iter().enumerate() {
            target += index[axis] * stride;
            stride *= extent;
        }
        column_major[target] = *value;
        for axis in (0..dims.len()).rev() {
            index[axis] += 1;
            if index[axis] < dims[axis] {
                break;
            }
            index[axis] = 0;
        }
    }
    column_major
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn document(arrays: &[String]) -> Vec<u8> {
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE GIFTI SYSTEM \"gifti.dtd\">\n");
        xml.push_str(&format!("<GIFTI Version=\"1.0\" NumberOfDataArrays=\"{}\">\n", arrays.len()));
        xml.push_str("<MetaData><MD><Name><![CDATA[note]]></Name><Value><![CDATA[<Data>not data</Data>]]></Value></MD></MetaData>\n");
        xml.push_str("<!-- <DataArray> in a comment is not an array -->\n<LabelTable/>\n");
        for array in arrays {
            xml.push_str(array);
        }
        xml.push_str("</GIFTI>\n");
        xml.into_bytes()
    }

    fn array(attributes: &str, data: &str) -> String {
        format!("<DataArray {attributes}>\n<MetaData/>\n<Data>{data}</Data>\n</DataArray>\n")
    }

    fn float32_bytes(values: &[f32], big: bool) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| if big { value.to_be_bytes() } else { value.to_le_bytes() })
            .collect()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut framed = vec![0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3];
        framed.extend_from_slice(b"name.raw\0");
        framed.extend(miniz_oxide::deflate::compress_to_vec(bytes, 6));
        framed.extend_from_slice(&[0; 8]);
        framed
    }

    #[test]
    fn surface_from_ascii_triangles_and_big_endian_base64_points() {
        let points = [0.5f32, -1.25, 3.0, 10.0, 20.0, 30.0, 7.0, 8.0, 9.0];
        let encoded = STANDARD.encode(float32_bytes(&points, true));
        let wrapped = format!("\n  {}\n  {}\n", &encoded[..10], &encoded[10..]);
        let bytes = document(&[
            array(
                "Encoding='Base64Binary' Endian=\"BigEndian\" Dim1=\"3\" Dim0=\"3\" Dimensionality=\"2\"\n ArrayIndexingOrder=\"RowMajorOrder\" DataType=\"NIFTI_TYPE_FLOAT32\" Intent=\"NIFTI_INTENT_POINTSET\"",
                &wrapped,
            ),
            array(
                "Intent=\"NIFTI_INTENT_TRIANGLE\" DataType=\"NIFTI_TYPE_INT32\" ArrayIndexingOrder=\"ColumnMajorOrder\" Dimensionality=\"2\" Dim0=\"2\" Dim1=\"3\" Encoding=\"ASCII\" Endian=\"LittleEndian\"",
                "0 2\n1 1\n2 0",
            ),
        ]);
        let surface = read_surface(&bytes).expect("valid surface");
        assert_eq!(surface.vertices, vec![[0.5, -1.25, 3.0], [10.0, 20.0, 30.0], [7.0, 8.0, 9.0]]);
        assert_eq!(surface.faces, Faces::Triangles(vec![[0, 1, 2], [2, 1, 0]]));
        let gifti = read(&bytes).expect("valid GIFTI");
        assert_eq!(gifti.arrays[0].dims, [3, 3]);
        assert_eq!(gifti.arrays[0].data[..3], [0.5, 10.0, 7.0]);
        assert_eq!(gifti.arrays[1].data_type, DataType::Int32);
    }

    #[test]
    fn run_scatters_volumes_vertex_major_from_zlib_gzip_and_matrix_arrays() {
        let attributes = "Intent=\"NIFTI_INTENT_TIME_SERIES\" DataType=\"NIFTI_TYPE_FLOAT32\" Dimensionality=\"1\" Dim0=\"4\" Encoding=\"GZipBase64Binary\" Endian=\"LittleEndian\"";
        let volume = |t: f32| [t, t + 0.25, t + 0.5, -t];
        let zlib = STANDARD.encode(miniz_oxide::deflate::compress_to_vec_zlib(&float32_bytes(&volume(1.0), false), 6));
        let gzipped = STANDARD.encode(gzip(&float32_bytes(&volume(2.0), false)));
        let cdata = format!("<![CDATA[{}]]>", STANDARD.encode(miniz_oxide::deflate::compress_to_vec_zlib(&float32_bytes(&volume(3.0), false), 6)));
        let bytes = document(&[array(attributes, &zlib), array(attributes, &gzipped), array(attributes, &cdata)]);
        let run = read_run(&bytes).expect("valid run");
        assert_eq!((run.volumes, run.vertices), (3, 4));
        assert_eq!(run.course(0), [1.0, 2.0, 3.0]);
        assert_eq!(run.course(1), [1.25, 2.25, 3.25]);
        assert_eq!(run.course(3), [-1.0, -2.0, -3.0]);

        let matrix: Vec<f32> = [volume(1.0), volume(2.0), volume(3.0)].concat();
        let column_major = array(
            "DataType=\"NIFTI_TYPE_FLOAT32\" Dimensionality=\"2\" Dim0=\"4\" Dim1=\"3\" ArrayIndexingOrder=\"ColumnMajorOrder\" Encoding=\"Base64Binary\"",
            &STANDARD.encode(float32_bytes(&matrix, false)),
        );
        assert_eq!(read_run(&document(&[column_major])).expect("valid matrix run"), run);
    }

    #[test]
    fn refuses_mismatched_external_and_truncated_arrays() {
        let one = "DataType=\"NIFTI_TYPE_UINT8\" Dimensionality=\"1\" Dim0=\"2\" Encoding=\"ASCII\"";
        let two = "DataType=\"NIFTI_TYPE_UINT8\" Dimensionality=\"1\" Dim0=\"3\" Encoding=\"ASCII\"";
        let mismatched = read_run(&document(&[array(one, "1 2"), array(two, "1 2 3")]));
        assert!(matches!(mismatched, Err(Error::Format { message, .. }) if message.contains("DataArray 1 has 3 vertices")));
        let short = read(&document(&[array(two, "1 2")]));
        assert!(matches!(short, Err(Error::Format { message, .. }) if message.contains("2 values")));
        let external = "DataType=\"NIFTI_TYPE_UINT8\" Dimensionality=\"1\" Dim0=\"2\" Encoding=\"ExternalFileBinary\"";
        let refused = read(&document(&[array(external, "")]));
        assert!(matches!(refused, Err(Error::Format { message, .. }) if message.contains("ExternalFileBinary")));
        let bytes = document(&[array(one, "1 2")]);
        assert!(read(&bytes[..bytes.len() - 30]).is_err());
        assert!(read_run(&document(&[])).is_err());
    }

    #[test]
    fn written_map_reads_back_as_float32() {
        let values = [0.1, -2.5, 1e-40, 123456.789, 0.0];
        let bytes = write_map(&values);
        let text = String::from_utf8(bytes.clone()).expect("UTF-8 XML");
        assert!(text.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE GIFTI SYSTEM"));
        assert!(text.contains("<GIFTI Version=\"1.0\"  NumberOfDataArrays=\"1\">"));
        let gifti = read(&bytes).expect("written map parses");
        assert_eq!(gifti.arrays.len(), 1);
        let array = &gifti.arrays[0];
        assert_eq!((array.intent.as_str(), array.data_type, array.dims.as_slice()), ("NIFTI_INTENT_NONE", DataType::Float32, &[5][..]));
        let expected: Vec<f64> = values.iter().map(|value| *value as f32 as f64).collect();
        assert_eq!(array.data, expected);
    }

    fn example(path: &str) -> Option<Vec<u8>> {
        let Ok(directory) = std::env::var("SAMSRF_EXAMPLE_DIR") else {
            println!("skipped: SAMSRF_EXAMPLE_DIR unset");
            return None;
        };
        Some(std::fs::read(std::path::Path::new(&directory).join(path)).expect("example file"))
    }

    /// `nibabel.load` on X001 `func/lh_uBars1.gii`: `img.darrays[t].data[v]` as f32 bits.
    #[test]
    fn example_run_matches_nibabel() {
        let Some(bytes) = example("func/lh_uBars1.gii") else { return };
        let run = read_run(&bytes).expect("lh_uBars1.gii reads");
        assert_eq!((run.volumes, run.vertices), (250, 134260));
        let samples = [
            (0, 0, 0x4541b6c1u32),
            (1, 0, 0x4541b374),
            (12345, 7, 0x455c297e),
            (134259, 249, 0x0),
            (67130, 125, 0x4577fd2b),
            (100000, 42, 0x457d91aa),
        ];
        for (vertex, volume, bits) in samples {
            assert_eq!(run.course(vertex)[volume].to_bits(), bits, "vertex {vertex} volume {volume}");
        }
        let first: f64 = (0..run.vertices).map(|vertex| run.course(vertex)[0] as f64).sum();
        assert!((first - 406630304.01482016).abs() < 1e-3, "volume 0 sum {first}");
    }

    /// `nibabel.load` on X001 `benson/lh_benson.gii`: three float32 TIME_SERIES arrays.
    #[test]
    fn example_benson_matches_nibabel() {
        let Some(bytes) = example("benson/lh_benson.gii") else { return };
        let gifti = read(&bytes).expect("lh_benson.gii reads");
        assert_eq!(gifti.arrays.len(), 3);
        let firsts = [[172.2421f32, 168.83913, 173.67378], [1.1579015, 1.0612755, 1.0873103], [-1.0, -1.0, -1.0]];
        let sums = [1460198.1363985396, 196451.9393994268, -164.121513530612];
        for ((array, first), sum) in gifti.arrays.iter().zip(firsts).zip(sums) {
            assert_eq!((array.intent.as_str(), array.dims.as_slice()), ("NIFTI_INTENT_TIME_SERIES", &[134260][..]));
            let head: Vec<f32> = array.data[..3].iter().map(|value| *value as f32).collect();
            assert_eq!(head, first);
            let total: f64 = array.data.iter().sum();
            assert!((total - sum).abs() < 1e-6 * sum.abs().max(1.0), "sum {total} != {sum}");
        }
    }
}
