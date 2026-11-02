//! FreeSurfer binary surfaces (`fs_read_surf`: triangle and quad files), curvature
//! files (`fs_read_curv`: new float32 and old int16/100 formats) and ASCII labels
//! (`Read_FreeSurfer` / `samsrf_loadlabel`). All big-endian.

use crate::error::{Error, Result};
use crate::surface::{Anatomy, Faces, Label, Surface};

const TRIANGLE_MAGIC: u32 = 16777214;
const QUAD_MAGIC: u32 = 16777215;
const NEW_CURV_MAGIC: u32 = 16777215;

fn format_error(message: impl Into<String>) -> Error {
    Error::format("FreeSurfer", message)
}

/// A big-endian cursor that names what it was reading when the file ends.
struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize, what: &str) -> Result<&'a [u8]> {
        let end = self.position.checked_add(count).filter(|end| *end <= self.bytes.len());
        let end = end.ok_or_else(|| format_error(format!("file ends while reading {what}")))?;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    /// `fs_fread3`: a 3-byte big-endian unsigned integer.
    fn u24(&mut self, what: &str) -> Result<u32> {
        let raw = self.take(3, what)?;
        Ok((raw[0] as u32) << 16 | (raw[1] as u32) << 8 | raw[2] as u32)
    }

    fn i32(&mut self, what: &str) -> Result<i32> {
        let raw = self.take(4, what)?;
        Ok(i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }

    fn count(&mut self, what: &str) -> Result<usize> {
        let value = self.i32(what)?;
        usize::try_from(value).map_err(|_| format_error(format!("negative {what} {value}")))
    }

    fn f32s(&mut self, count: usize, what: &str) -> Result<Vec<f64>> {
        let raw = self.take(count.saturating_mul(4), what)?;
        Ok(raw.as_chunks::<4>().0.iter().map(|chunk| f32::from_be_bytes(*chunk) as f64).collect())
    }

    /// `fread(..., 'int16') ./ 100`.
    fn centi_i16s(&mut self, count: usize, what: &str) -> Result<Vec<f64>> {
        let raw = self.take(count.saturating_mul(2), what)?;
        Ok(raw.as_chunks::<2>().0.iter().map(|chunk| i16::from_be_bytes(*chunk) as f64 / 100.0).collect())
    }

    /// Skips a text line terminated by `\n` (`fgets`).
    fn line(&mut self, what: &str) -> Result<()> {
        let rest = &self.bytes[self.position..];
        let newline = rest
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| format_error(format!("file ends while reading {what}")))?;
        self.position += newline + 1;
        Ok(())
    }
}

fn triples(values: Vec<f64>) -> Vec<[f64; 3]> {
    values.as_chunks::<3>().0.to_vec()
}

fn face_index(value: u32, vertices: usize) -> Result<u32> {
    if value as usize >= vertices {
        return Err(format_error(format!("face index {value} is not a vertex of a {vertices}-vertex mesh")));
    }
    Ok(value)
}

pub fn read_surface(bytes: &[u8]) -> Result<Surface> {
    let mut cursor = Cursor::new(bytes);
    let magic = cursor.u24("the magic number")?;
    match magic {
        TRIANGLE_MAGIC => {
            cursor.line("the creation line")?;
            cursor.line("the info line")?;
            let vertex_count = cursor.count("vertex count")?;
            let face_count = cursor.count("face count")?;
            let vertices = triples(cursor.f32s(vertex_count.saturating_mul(3), "vertex coordinates")?);
            let raw = cursor.take(face_count.saturating_mul(12), "faces")?;
            let faces = raw
                .as_chunks::<12>()
                .0
                .iter()
                .map(|face| {
                    let mut indices = [0u32; 3];
                    for (slot, corner) in indices.iter_mut().zip(face.as_chunks::<4>().0) {
                        let index = i32::from_be_bytes(*corner);
                        let index = u32::try_from(index).map_err(|_| format_error(format!("negative face index {index}")))?;
                        *slot = face_index(index, vertex_count)?;
                    }
                    Ok(indices)
                })
                .collect::<Result<Vec<[u32; 3]>>>()?;
            Ok(Surface { vertices, faces: Faces::Triangles(faces) })
        }
        QUAD_MAGIC => {
            let vertex_count = cursor.u24("vertex count")? as usize;
            let face_count = cursor.u24("face count")? as usize;
            let vertices = triples(cursor.centi_i16s(vertex_count * 3, "vertex coordinates")?);
            let mut faces = Vec::with_capacity(face_count);
            for _ in 0..face_count {
                let mut face = [0u32; 4];
                for slot in &mut face {
                    *slot = face_index(cursor.u24("faces")?, vertex_count)?;
                }
                faces.push(face);
            }
            Ok(Surface { vertices, faces: Faces::Quads(faces) })
        }
        other => Err(format_error(format!("unknown surface magic number {other}"))),
    }
}

pub fn read_curv(bytes: &[u8]) -> Result<Vec<f64>> {
    let mut cursor = Cursor::new(bytes);
    let first = cursor.u24("the magic number")?;
    if first == NEW_CURV_MAGIC {
        let vertex_count = cursor.count("vertex count")?;
        cursor.count("face count")?;
        cursor.count("values per vertex")?;
        return cursor.f32s(vertex_count, "curvature values");
    }
    cursor.u24("face count")?;
    cursor.centi_i16s(first as usize, "curvature values")
}

/// Parses a `.label` file: a comment line, the vertex count, then one vertex per line
/// (`index x y z value`). Indices stay 0-based.
///
/// SamSrf ignores the count line; a label whose rows disagree with it is refused here
/// because it is truncated or hand-edited.
pub fn read_label(text: &str) -> Result<Label> {
    let mut lines = text.lines();
    lines.next().ok_or_else(|| format_error("label is empty"))?;
    let count_line = lines.next().ok_or_else(|| format_error("label has no vertex count line"))?;
    let count: usize = count_line
        .trim()
        .parse()
        .map_err(|_| format_error(format!("label vertex count {:?} is not a number", count_line.trim())))?;
    let mut label = Label {
        vertices: Vec::with_capacity(count),
        coordinates: Vec::with_capacity(count),
        values: Vec::with_capacity(count),
    };
    for (number, line) in lines.enumerate().map(|(offset, line)| (offset + 3, line)) {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.is_empty() {
            continue;
        }
        if fields.len() != 5 {
            return Err(format_error(format!("label line {number} has {} fields, expected 5", fields.len())));
        }
        let index = fields[0]
            .parse::<u32>()
            .map_err(|_| format_error(format!("label line {number}: vertex index {:?} is not a non-negative integer", fields[0])))?;
        let mut numbers = [0.0; 4];
        for (slot, field) in numbers.iter_mut().zip(&fields[1..]) {
            *slot = field
                .parse::<f64>()
                .map_err(|_| format_error(format!("label line {number}: {field:?} is not a number")))?;
        }
        label.vertices.push(index);
        label.coordinates.push([numbers[0], numbers[1], numbers[2]]);
        label.values.push(numbers[3]);
    }
    if label.vertices.len() != count {
        return Err(format_error(format!(
            "label declares {count} vertices but lists {}",
            label.vertices.len()
        )));
    }
    Ok(label)
}

/// The files `samsrf_gii2srf` reads from a `surf` folder for one hemisphere. The
/// caller supplies bytes (it owns file access); `thickness` may be absent.
pub struct AnatomyFiles<'a> {
    pub white: &'a [u8],
    pub pial: &'a [u8],
    pub inflated: &'a [u8],
    pub sphere: &'a [u8],
    pub curv: &'a [u8],
    pub area: &'a [u8],
    pub thickness: Option<&'a [u8]>,
}

/// Reads the folder and checks every file has the white surface's vertex count.
pub fn read_anatomy(files: &AnatomyFiles<'_>) -> Result<Anatomy> {
    let white = read_surface(files.white).map_err(|error| in_file("white", error))?;
    let expected = white.vertices.len();
    let check = |name: &str, count: usize| {
        if count == expected {
            Ok(())
        } else {
            Err(Error::Shape(format!("{name} has {count} vertices but white has {expected}")))
        }
    };
    let mesh = |name: &str, bytes: &[u8]| -> Result<Vec<[f64; 3]>> {
        let surface = read_surface(bytes).map_err(|error| in_file(name, error))?;
        check(name, surface.vertices.len())?;
        Ok(surface.vertices)
    };
    let scalars = |name: &str, bytes: &[u8]| -> Result<Vec<f64>> {
        let values = read_curv(bytes).map_err(|error| in_file(name, error))?;
        check(name, values.len())?;
        Ok(values)
    };
    Ok(Anatomy {
        pial: mesh("pial", files.pial)?,
        inflated: mesh("inflated", files.inflated)?,
        sphere: mesh("sphere", files.sphere)?,
        curvature: scalars("curv", files.curv)?,
        area: scalars("area", files.area)?,
        thickness: files.thickness.map(|bytes| scalars("thickness", bytes)).transpose()?,
        white,
    })
}

fn in_file(name: &str, error: Error) -> Error {
    match error {
        Error::Format { format, message } => Error::Format { format, message: format!("{name}: {message}") },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u24(value: u32) -> [u8; 3] {
        let bytes = value.to_be_bytes();
        [bytes[1], bytes[2], bytes[3]]
    }

    fn triangle_file(vertices: &[[f32; 3]], faces: &[[i32; 3]]) -> Vec<u8> {
        let mut bytes = u24(TRIANGLE_MAGIC).to_vec();
        bytes.extend_from_slice(b"created by test on today\n\n");
        bytes.extend_from_slice(&(vertices.len() as i32).to_be_bytes());
        bytes.extend_from_slice(&(faces.len() as i32).to_be_bytes());
        bytes.extend(vertices.iter().flatten().flat_map(|value| value.to_be_bytes()));
        bytes.extend(faces.iter().flatten().flat_map(|value| value.to_be_bytes()));
        bytes
    }

    fn new_curv(values: &[f32]) -> Vec<u8> {
        let mut bytes = u24(NEW_CURV_MAGIC).to_vec();
        bytes.extend_from_slice(&(values.len() as i32).to_be_bytes());
        bytes.extend_from_slice(&7i32.to_be_bytes());
        bytes.extend_from_slice(&1i32.to_be_bytes());
        bytes.extend(values.iter().flat_map(|value| value.to_be_bytes()));
        bytes
    }

    const TETRAHEDRON: [[f32; 3]; 4] = [[0.0, 0.0, 0.0], [1.5, 0.0, 0.0], [0.0, -2.25, 0.0], [0.0, 0.0, 3.0]];

    #[test]
    fn triangle_surface() {
        let bytes = triangle_file(&TETRAHEDRON, &[[0, 1, 2], [0, 1, 3], [1, 2, 3]]);
        let surface = read_surface(&bytes).expect("valid surface");
        assert_eq!(surface.vertices[2], [0.0, -2.25, 0.0]);
        assert_eq!(surface.faces, Faces::Triangles(vec![[0, 1, 2], [0, 1, 3], [1, 2, 3]]));
        assert!(read_surface(&bytes[..bytes.len() - 1]).is_err());
        let outside = triangle_file(&TETRAHEDRON, &[[0, 1, 4]]);
        assert!(matches!(read_surface(&outside), Err(Error::Format { message, .. }) if message.contains("face index 4")));
    }

    #[test]
    fn quad_surface_reads_hundredths_and_three_byte_faces() {
        let mut bytes = u24(QUAD_MAGIC).to_vec();
        bytes.extend_from_slice(&u24(4));
        bytes.extend_from_slice(&u24(1));
        for value in [0i16, 0, 0, 150, 0, 0, 0, -225, 0, 0, 0, 300] {
            bytes.extend_from_slice(&value.to_be_bytes());
        }
        for index in [0, 1, 2, 3] {
            bytes.extend_from_slice(&u24(index));
        }
        let surface = read_surface(&bytes).expect("valid quad surface");
        assert_eq!(surface.vertices, vec![[0.0, 0.0, 0.0], [1.5, 0.0, 0.0], [0.0, -2.25, 0.0], [0.0, 0.0, 3.0]]);
        assert_eq!(surface.faces, Faces::Quads(vec![[0, 1, 2, 3]]));
        assert!(read_surface(&[0, 0, 1, 0]).is_err());
    }

    #[test]
    fn new_and_old_curvature() {
        assert_eq!(read_curv(&new_curv(&[0.5, -0.25])), Ok(vec![0.5, -0.25]));
        let mut old = u24(3).to_vec();
        old.extend_from_slice(&u24(2));
        for value in [12i16, -7, 0] {
            old.extend_from_slice(&value.to_be_bytes());
        }
        assert_eq!(read_curv(&old), Ok(vec![12.0 / 100.0, -7.0 / 100.0, 0.0]));
        assert!(read_curv(&old[..old.len() - 2]).is_err());
    }

    #[test]
    fn label_keeps_zero_based_indices_and_tolerates_blank_lines() {
        let text = "#!ascii label  , from subject X vox2ras=TkReg\n3\n57  -14.374  -90.431  11.257 0.6999999881\n0 1 2 3 0.5   \n\n163105 10.608 -52.636 6.037 0.000000\n\n\n";
        let label = read_label(text).expect("valid label");
        assert_eq!(label.vertices, [57, 0, 163105]);
        assert_eq!(label.coordinates[0], [-14.374, -90.431, 11.257]);
        assert_eq!(label.values, [0.6999999881, 0.5, 0.0]);
        let short = read_label("# c\n4\n1 0 0 0 0\n");
        assert!(matches!(short, Err(Error::Format { message, .. }) if message.contains("declares 4")));
        assert!(read_label("# c\n1\n1 0 0 0\n").is_err());
        assert!(read_label("# c\n1\n-1 0 0 0 0\n").is_err());
        assert!(read_label("# c\n").is_err());
    }

    #[test]
    fn anatomy_requires_matching_vertex_counts() {
        let white = triangle_file(&TETRAHEDRON, &[[0, 1, 2]]);
        let curv = new_curv(&[0.1, 0.2, 0.3, 0.4]);
        let short = new_curv(&[0.1]);
        let files = AnatomyFiles {
            white: &white,
            pial: &white,
            inflated: &white,
            sphere: &white,
            curv: &curv,
            area: &curv,
            thickness: None,
        };
        let anatomy = read_anatomy(&files).expect("matching folder");
        assert_eq!(anatomy.normals(), vec![[0.0; 3]; 4]);
        assert_eq!(anatomy.thickness, None);
        let mismatched = AnatomyFiles { area: &short, ..files };
        assert_eq!(read_anatomy(&mismatched), Err(Error::Shape("area has 1 vertices but white has 4".into())));
    }

    fn example(path: &str) -> Option<Vec<u8>> {
        let Ok(directory) = std::env::var("SAMSRF_EXAMPLE_DIR") else {
            println!("skipped: SAMSRF_EXAMPLE_DIR unset");
            return None;
        };
        Some(std::fs::read(std::path::Path::new(&directory).join(path)).expect("example file"))
    }

    /// `nibabel.freesurfer.read_geometry` / `read_morph_data` on X001 `surf/lh.*`: 134260
    /// vertices, 268516 faces (face index sum 54064683217), vertex 12345 and face 1000.
    #[test]
    fn example_anatomy_matches_nibabel() {
        let Some(white) = example("surf/lh.white") else { return };
        let read = |name: &str| example(&format!("surf/lh.{name}")).expect("example file");
        let (pial, inflated, sphere, curv, area) = (read("pial"), read("inflated"), read("sphere"), read("curv"), read("area"));
        let files = AnatomyFiles { white: &white, pial: &pial, inflated: &inflated, sphere: &sphere, curv: &curv, area: &area, thickness: None };
        let anatomy = read_anatomy(&files).expect("X001 surf folder");
        assert_eq!(anatomy.white.vertices.len(), 134260);
        let Faces::Triangles(faces) = &anatomy.white.faces else { panic!("white is a triangle mesh") };
        assert_eq!(faces.len(), 268516);
        assert_eq!(faces[1000], [446, 447, 450]);
        let index_sum: u64 = faces.iter().flatten().map(|index| *index as u64).sum();
        assert_eq!(index_sum, 54064683217);
        assert_eq!(anatomy.white.vertices[12345], [-12.781461715698242, -70.21051788330078, 49.610198974609375]);
        assert_eq!(anatomy.pial[12345], [-11.108918190002441, -72.54589080810547, 50.810062408447266]);
        assert_eq!(anatomy.inflated[12345], [25.068836212158203, -86.88953399658203, 31.881423950195312]);
        assert_eq!(anatomy.sphere[12345], [46.010040283203125, -79.24372100830078, 40.043827056884766]);
        let white_sum: f64 = anatomy.white.vertices.iter().flatten().sum();
        assert!((white_sum - -2983269.500695089).abs() < 1e-3, "white sum {white_sum}");
        assert_eq!((anatomy.curvature[12345] as f32).to_bits(), 0xbe9e9c0a);
        assert_eq!((anatomy.area[12345] as f32).to_bits(), 0x3f19fa61);
        let curv_sum: f64 = anatomy.curvature.iter().sum();
        assert!((curv_sum - -4536.77503922483).abs() < 1e-6, "curv sum {curv_sum}");
    }

    /// `nibabel.freesurfer.read_label` and `numpy.loadtxt(skiprows=2)` on the X001 labels.
    #[test]
    fn example_labels_match_nibabel() {
        let Some(v1) = example("label/lh.V1.label") else { return };
        let v1 = read_label(&String::from_utf8(v1).expect("ASCII label")).expect("lh.V1.label");
        assert_eq!(v1.vertices.len(), 6356);
        assert_eq!(v1.vertices[..3], [57, 69, 263]);
        assert_eq!(v1.vertices.iter().map(|index| *index as u64).sum::<u64>(), 81704164);
        assert_eq!(*v1.vertices.last().expect("non-empty"), 46947);
        assert_eq!(*v1.coordinates.last().expect("non-empty"), [-28.898, -38.34, 12.352]);
        let v123 = example("prf/V123.label").expect("example file");
        let v123 = read_label(&String::from_utf8(v123).expect("ASCII label")).expect("V123.label");
        assert_eq!(v123.vertices.len(), 13750);
        assert_eq!(v123.vertices[..3], [0, 3, 4]);
        assert_eq!(v123.vertices.iter().map(|index| *index as u64).sum::<u64>(), 1064629484);
        let coordinate_sum: f64 = v123.coordinates.iter().flatten().sum();
        assert!((coordinate_sum - -1051269.513).abs() < 1e-6, "coordinate sum {coordinate_sum}");
    }
}
