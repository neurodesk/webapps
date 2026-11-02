//! Stimulus apertures: the movie of what was on screen at each volume.
//!
//! SamSrf stores apertures as `ApFrm` (height x width x volumes, values usually 0 or 1)
//! and vectorises them (`VectoriseApertures.m`) into `ApFrm` (pixels x volumes) and `ApXY`
//! (pixels x 2) with pixels in MATLAB column-major order over (row, column): pixel `p`
//! is row `p % height`, column `p / height`. Rows run top to bottom, so the Y coordinate
//! of row `r` is positive at the top (`fliplr` in VectoriseApertures). Coordinates are
//! `[-1, 1]` on the longer side and shrunk on the shorter side of a rectangular aperture;
//! the analyses rescale them by `Scaling_Factor` (`scaled_xy`).

use crate::error::{Error, Result};

/// One volume's aperture, stored sparse: only the pixels that are not exactly zero.
/// `indices` ascend; `values` are the pixel values (1 for a binary aperture).
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub indices: Vec<u32>,
    pub values: Vec<f64>,
}

/// A vectorised aperture set in SamSrf's pixel order.
#[derive(Debug, Clone, PartialEq)]
pub struct Apertures {
    /// Columns of the aperture image (`ApDimX`). Must be even.
    pub width: usize,
    /// Rows of the aperture image (`ApDimY`). Must be even.
    pub height: usize,
    /// One frame per volume.
    pub frames: Vec<Frame>,
    /// `ApXY` before any `Scaling_Factor`: pixel coordinates in stimulus space, `width * height`
    /// entries in column-major pixel order.
    pub xy: Vec<[f64; 2]>,
    /// `ApCond`: one condition label per volume for a multi-condition design.
    pub conditions: Option<Vec<f64>>,
}

impl Apertures {
    /// Builds apertures from a dense column-major `height x width x volumes` array, as `load`
    /// of an `aps_*.mat` file gives `ApFrm`. Mirrors `VectoriseApertures.m`: rejects odd side
    /// lengths, computes `ApXY` with the rectangular scaling, keeps `ApCond` as conditions.
    pub fn from_dense(height: usize, width: usize, volumes: usize, data: &[f64], conditions: Option<Vec<f64>>) -> Result<Self> {
        if !width.is_multiple_of(2) {
            return Err(Error::Shape(format!("Aperture X dimension is an odd number ({width}); side lengths must be even")));
        }
        if !height.is_multiple_of(2) {
            return Err(Error::Shape(format!("Aperture Y dimension is an odd number ({height}); side lengths must be even")));
        }
        if width == 0 || height == 0 || volumes == 0 {
            return Err(Error::Shape(format!("Apertures are empty ({height} x {width} x {volumes})")));
        }
        let pixels = height * width;
        if data.len() != pixels * volumes {
            return Err(Error::Shape(format!(
                "Aperture movie has {} values, expected {height} x {width} x {volumes}",
                data.len()
            )));
        }
        check_conditions(conditions.as_deref(), volumes)?;
        let frames = data.chunks_exact(pixels).map(sparse_frame).collect();
        let xy = grid_xy(height, width);
        Ok(Self { width, height, frames, xy, conditions })
    }

    /// Builds apertures that are already vectorised (`ApFrm` pixels x volumes, `ApXY` pixels x 2,
    /// both column-major as loaded from an `aps_*_vec.mat` file). The first row of `ApFrm`
    /// holds the condition labels when the file was a multi-condition design, which this
    /// detects by `ap_frm` having one more row than `ap_xy`.
    ///
    /// `width` and `height` are recovered when `ApXY` is a `VectoriseApertures` grid (up to a
    /// uniform scale, as files from before SamSrf 9.81 baked `Scaling_Factor` in). Any other
    /// layout (`BackprojAps` writes one pixel per seed vertex) is a `pixels x 1` strip.
    pub fn from_vectorised(ap_frm_rows: usize, volumes: usize, ap_frm: &[f64], ap_xy: &[f64]) -> Result<Self> {
        if !ap_xy.len().is_multiple_of(2) {
            return Err(Error::Shape(format!("ApXY has {} values; it must have two columns", ap_xy.len())));
        }
        let pixels = ap_xy.len() / 2;
        if pixels == 0 || volumes == 0 {
            return Err(Error::Shape(format!("Apertures are empty ({pixels} pixels x {volumes} volumes)")));
        }
        if ap_frm.len() != ap_frm_rows * volumes {
            return Err(Error::Shape(format!(
                "ApFrm has {} values, expected {ap_frm_rows} x {volumes}",
                ap_frm.len()
            )));
        }
        let has_conditions = if ap_frm_rows == pixels + 1 {
            true
        } else if ap_frm_rows == pixels {
            false
        } else {
            return Err(Error::Shape(format!("ApFrm has {ap_frm_rows} rows but ApXY has {pixels} pixels")));
        };
        let skip = usize::from(has_conditions);
        let columns = ap_frm.chunks_exact(ap_frm_rows);
        let conditions = has_conditions.then(|| columns.clone().map(|column| column[0]).collect());
        let frames = columns.map(|column| sparse_frame(&column[skip..])).collect();
        let xy: Vec<[f64; 2]> = (0..pixels).map(|p| [ap_xy[p], ap_xy[p + pixels]]).collect();
        let (height, width) = grid_shape(&xy).unwrap_or((1, pixels));
        Ok(Self { width, height, frames, xy, conditions })
    }

    pub fn volumes(&self) -> usize {
        self.frames.len()
    }

    pub fn pixels(&self) -> usize {
        self.width * self.height
    }

    /// `ApXY / max(abs(ApXY(:))) * scaling_factor`, as `samsrf_fit_prf` and `samsrf_revcor_prf` do.
    pub fn scaled_xy(&self, scaling_factor: f64) -> Vec<[f64; 2]> {
        let largest = max_abs(&self.xy);
        self.xy
            .iter()
            .map(|[x, y]| [x / largest * scaling_factor, y / largest * scaling_factor])
            .collect()
    }

    /// The dense `ApFrm` (pixels x volumes, column-major) for parity checks and exports.
    pub fn to_dense(&self) -> Vec<f64> {
        let pixels = self.xy.len();
        let mut dense = vec![0.0; pixels * self.frames.len()];
        for (column, frame) in dense.chunks_exact_mut(pixels).zip(&self.frames) {
            for (index, value) in frame.indices.iter().zip(&frame.values) {
                column[*index as usize] = *value;
            }
        }
        dense
    }

    /// Whether any pixel value is negative (SamSrf prints a warning).
    pub fn has_negative_values(&self) -> bool {
        self.frames.iter().any(|frame| frame.values.iter().any(|value| *value < 0.0))
    }
}

fn sparse_frame(column: &[f64]) -> Frame {
    let mut indices = Vec::new();
    let mut values = Vec::new();
    for (index, value) in column.iter().enumerate() {
        if *value != 0.0 {
            indices.push(index as u32);
            values.push(*value);
        }
    }
    Frame { indices, values }
}

fn check_conditions(conditions: Option<&[f64]>, volumes: usize) -> Result<()> {
    match conditions {
        Some(labels) if labels.len() != volumes => Err(Error::Shape(format!(
            "ApCond has {} labels but the apertures have {volumes} volumes",
            labels.len()
        ))),
        _ => Ok(()),
    }
}

/// `[-n/2:-1 1:n/2]`: the pixel centres along one side, skipping zero.
fn side(n: usize) -> Vec<f64> {
    let half = (n / 2) as f64;
    (0..n)
        .map(|i| {
            let i = i as f64;
            if i < half {
                i - half
            } else {
                i - half + 1.0
            }
        })
        .collect()
}

/// `ApXY` exactly as VectoriseApertures computes it, column-major over (row, column).
fn grid_xy(height: usize, width: usize) -> Vec<[f64; 2]> {
    let scaling = if width > height {
        [1.0, height as f64 / width as f64]
    } else if width < height {
        [width as f64 / height as f64, 1.0]
    } else {
        [1.0, 1.0]
    };
    let half_x = (width / 2) as f64;
    let half_y = (height / 2) as f64;
    let xs = side(width);
    let mut ys = side(height);
    ys.reverse();
    let mut xy = Vec::with_capacity(width * height);
    for x in &xs {
        for y in &ys {
            xy.push([x / half_x * scaling[0], y / half_y * scaling[1]]);
        }
    }
    xy
}

/// `(height, width)` when `xy` is a VectoriseApertures grid up to a uniform scale.
fn grid_shape(xy: &[[f64; 2]]) -> Option<(usize, usize)> {
    let pixels = xy.len();
    let height = xy.iter().take_while(|point| point[0] == xy[0][0]).count();
    if height == 0 || !pixels.is_multiple_of(height) {
        return None;
    }
    let width = pixels / height;
    if height % 2 != 0 || !width.is_multiple_of(2) {
        return None;
    }
    let grid = grid_xy(height, width);
    let scale = max_abs(xy) / max_abs(&grid);
    let tolerance = 1e-9 * scale;
    let matches = xy.iter().zip(&grid).all(|(point, expected)| {
        (point[0] - expected[0] * scale).abs() <= tolerance && (point[1] - expected[1] * scale).abs() <= tolerance
    });
    matches.then_some((height, width))
}

fn max_abs(xy: &[[f64; 2]]) -> f64 {
    xy.iter().flatten().fold(0.0, |largest: f64, value| largest.max(value.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4 rows x 6 columns x 2 volumes, column-major: 1 at (row 0, col 0) and (row 3, col 5)
    /// in volume 0, 0.5 at (row 1, col 2) in volume 1.
    fn movie() -> Vec<f64> {
        let mut data = vec![0.0; 4 * 6 * 2];
        data[0] = 1.0;
        data[3 + 5 * 4] = 1.0;
        data[24 + 1 + 2 * 4] = 0.5;
        data
    }

    #[test]
    fn rectangular_movie_matches_vectorise_apertures() {
        let apertures = Apertures::from_dense(4, 6, 2, &movie(), None).expect("valid movie");
        assert_eq!((apertures.height, apertures.width, apertures.volumes()), (4, 6, 2));
        assert_eq!(apertures.frames[0], Frame { indices: vec![0, 23], values: vec![1.0, 1.0] });
        assert_eq!(apertures.frames[1], Frame { indices: vec![9], values: vec![0.5] });
        // meshgrid([-3:-1 1:3], fliplr([-2:-1 1:2])), then X / 3 * 1 and Y / 2 * (4/6).
        let s = 4.0 / 6.0;
        let mut expected = Vec::new();
        for x in [-3.0, -2.0, -1.0, 1.0, 2.0, 3.0] {
            for y in [2.0, 1.0, -1.0, -2.0] {
                expected.push([x / 3.0 * 1.0, y / 2.0 * s]);
            }
        }
        assert_eq!(apertures.xy, expected);
        assert_eq!(apertures.xy[0], [-1.0, 2.0 / 2.0 * s]);
        assert_eq!(apertures.xy[9], [-1.0 / 3.0, 1.0 / 2.0 * s]);
        assert_eq!(apertures.xy[23], [1.0, -2.0 / 2.0 * s]);
        assert_eq!(apertures.to_dense(), movie());
    }

    #[test]
    fn tall_movie_shrinks_x() {
        let apertures = Apertures::from_dense(6, 4, 1, &[0.0; 24], None).expect("valid movie");
        let s = 4.0 / 6.0;
        assert_eq!(apertures.xy[0], [-2.0 / 2.0 * s, 3.0 / 3.0]);
        assert_eq!(apertures.xy[5], [-2.0 / 2.0 * s, -3.0 / 3.0]);
        assert_eq!(apertures.xy[23], [2.0 / 2.0 * s, -1.0]);
    }

    #[test]
    fn odd_side_wrong_length_and_wrong_conditions_are_refused() {
        let odd = Apertures::from_dense(4, 5, 1, &[0.0; 20], None);
        assert!(matches!(odd, Err(Error::Shape(message)) if message.contains("X dimension")));
        let short = Apertures::from_dense(4, 6, 2, &[0.0; 47], None);
        assert!(short.is_err());
        let conditions = Apertures::from_dense(4, 6, 2, &movie(), Some(vec![1.0]));
        assert!(conditions.is_err());
    }

    #[test]
    fn scaled_xy_normalises_to_the_largest_coordinate() {
        let apertures = Apertures::from_dense(4, 6, 2, &movie(), None).expect("valid movie");
        let scaled = apertures.scaled_xy(10.0);
        let s = 4.0 / 6.0;
        assert_eq!(scaled[0], [-10.0, 2.0 / 2.0 * s / 1.0 * 10.0]);
        assert_eq!(scaled[23], [10.0, -2.0 / 2.0 * s / 1.0 * 10.0]);
    }

    #[test]
    fn vectorised_round_trip_recovers_shape_and_conditions() {
        let dense = Apertures::from_dense(4, 6, 2, &movie(), Some(vec![1.0, 2.0])).expect("valid movie");
        let ap_xy: Vec<f64> = dense.xy.iter().map(|p| p[0]).chain(dense.xy.iter().map(|p| p[1])).collect();
        let mut ap_frm = Vec::new();
        for (label, column) in [1.0, 2.0].iter().zip(dense.to_dense().chunks(24)) {
            ap_frm.push(*label);
            ap_frm.extend_from_slice(column);
        }
        let vectorised = Apertures::from_vectorised(25, 2, &ap_frm, &ap_xy).expect("valid vectorised");
        assert_eq!(vectorised, dense);
        let plain = Apertures::from_vectorised(24, 2, &dense.to_dense(), &ap_xy).expect("valid vectorised");
        assert_eq!(plain.conditions, None);
        assert_eq!(plain.frames, dense.frames);
    }

    #[test]
    fn vectorised_pre_981_scaled_grid_keeps_its_shape_and_values() {
        let dense = Apertures::from_dense(4, 6, 1, &[0.0; 24], None).expect("valid movie");
        let ap_xy: Vec<f64> = dense.xy.iter().map(|p| p[0] * 8.5).chain(dense.xy.iter().map(|p| p[1] * 8.5)).collect();
        let vectorised = Apertures::from_vectorised(24, 1, &[0.0; 24], &ap_xy).expect("valid vectorised");
        assert_eq!((vectorised.height, vectorised.width), (4, 6));
        assert_eq!(vectorised.xy[0], [-8.5, dense.xy[0][1] * 8.5]);
    }

    #[test]
    fn vectorised_scattered_pixels_become_a_strip() {
        let ap_xy = [0.1, 0.5, -0.3, 0.2, 0.0, 0.9];
        let vectorised = Apertures::from_vectorised(3, 1, &[1.0, 0.0, 2.0], &ap_xy).expect("valid vectorised");
        assert_eq!((vectorised.height, vectorised.width), (1, 3));
        assert_eq!(vectorised.xy, vec![[0.1, 0.2], [0.5, 0.0], [-0.3, 0.9]]);
        assert_eq!(vectorised.frames[0], Frame { indices: vec![0, 2], values: vec![1.0, 2.0] });
        let mismatch = Apertures::from_vectorised(5, 1, &[0.0; 5], &ap_xy);
        assert!(mismatch.is_err());
    }
}
