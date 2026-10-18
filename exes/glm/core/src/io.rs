//! NIfTI and TSV I/O on bytes and text (files are the caller's concern), plus glm.py's two analyses.

use crate::{Event, design, gaussian_filter, mask, sigma, t_isf, tstat};
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use neurodesk_nifti::Nifti1Header;
use neurodesk_nifti::accept::parse;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};

pub const TASK_CONTRASTS: [(&str, [f64; 2]); 4] = [
    ("leftGreaterRight", [1.0, -1.0]),
    ("rightGreaterLeft", [-1.0, 1.0]),
    ("leftActive", [1.0, 0.0]),
    ("rightActive", [0.0, 1.0]),
];

pub struct Image {
    pub dims: [usize; 3],
    pub nvol: usize,
    pub zooms: [f64; 3],
    pub affine: [[f64; 4]; 3],
    pub data: Vec<f32>,
}

/// A 4D series from `.nii` or `.nii.gz` bytes, scaled as nibabel `get_fdata`.
pub fn decode(bytes: &[u8]) -> Result<Image, String> {
    let inflated;
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = vec![];
        MultiGzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|e| format!("corrupt gzip: {e}"))?;
        inflated = out;
        &inflated[..]
    } else {
        bytes
    };
    let h = parse(bytes)?;
    let raw = Nifti1Header::decode(bytes[..348].try_into().unwrap());
    if h.shape.len() < 4 || h.shape[4..].iter().any(|&n| n != 1) {
        return Err(format!("expected a 4D series, got shape {:?}", h.shape));
    }
    let dims = [h.shape[0], h.shape[1], h.shape[2]];
    let nvol = h.shape[3];
    let count = dims
        .iter()
        .product::<usize>()
        .checked_mul(nvol)
        .ok_or("image too large")?;
    let (width, decode) = raw.scalar_decoder()?;
    let offset = raw.vox_offset as usize;
    if !raw.vox_offset.is_finite()
        || raw.vox_offset < 348.0
        || offset
            .checked_add(count * width)
            .is_none_or(|end| end > bytes.len())
    {
        return Err("voxel data is truncated or vox_offset is invalid".into());
    }
    // nibabel get_fdata: scl_slope applies when finite and non-zero
    let (slope, inter) = (raw.scl_slope as f64, raw.scl_inter as f64);
    let scaled = slope.is_finite() && slope != 0.0 && (slope != 1.0 || inter != 0.0);
    let data = bytes[offset..offset + count * width]
        .chunks_exact(width)
        .map(|c| {
            if scaled {
                (decode(c) * slope + inter) as f32
            } else {
                decode(c) as f32
            }
        })
        .collect();
    Ok(Image {
        dims,
        nvol,
        zooms: [h.zooms[0], h.zooms[1], h.zooms[2]],
        affine: h.affine,
        data,
    })
}

/// float32 NIfTI-1 as nibabel writes a new image: sform (aligned) from the affine, qform unset.
pub fn encode(img: &Image, data: &[f32], intent_df: Option<f32>) -> Vec<u8> {
    let mut b = vec![0u8; 352];
    let put16 = |b: &mut Vec<u8>, o: usize, v: i16| b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    let put32 = |b: &mut Vec<u8>, o: usize, v: f32| b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    b[0..4].copy_from_slice(&348i32.to_le_bytes());
    for (i, d) in [3, img.dims[0], img.dims[1], img.dims[2], 1, 1, 1, 1]
        .iter()
        .enumerate()
    {
        put16(&mut b, 40 + 2 * i, *d as i16);
    }
    if let Some(df) = intent_df {
        put32(&mut b, 56, df);
        put16(&mut b, 68, 3); // NIFTI_INTENT_TTEST
    }
    put16(&mut b, 70, 16); // float32
    put16(&mut b, 72, 32);
    let a = &img.affine;
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    put32(&mut b, 76, if det < 0.0 { -1.0 } else { 1.0 });
    let zoom = |j: usize| (a[0][j].powi(2) + a[1][j].powi(2) + a[2][j].powi(2)).sqrt() as f32;
    (0..3).for_each(|j| put32(&mut b, 80 + 4 * j, zoom(j)));
    for j in 4..8 {
        put32(&mut b, 76 + 4 * j, 1.0);
    }
    put32(&mut b, 108, 352.0);
    put32(&mut b, 112, 1.0);
    put16(&mut b, 254, 2); // sform: aligned
    for (k, v) in a.iter().flatten().enumerate() {
        put32(&mut b, 280 + 4 * k, *v as f32);
    }
    b[344..348].copy_from_slice(b"n+1\0");
    b.extend(data.iter().flat_map(|v| v.to_le_bytes()));
    b
}

/// gzip, for `.nii.gz` outputs (nibabel and FSL pick compression from the name).
pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut z = GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    z.write_all(bytes)
        .and_then(|_| z.finish())
        .expect("gzip into memory")
}

/// Columns of a tab-separated file; 'n/a' and empty cells read as 0.
pub fn confounds(text: &str) -> Result<Vec<(String, Vec<f64>)>, String> {
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(r, l)| (r + 1, l.trim_end_matches('\r')))
        .filter(|(_, l)| !l.is_empty());
    let mut cols: Vec<(String, Vec<f64>)> = lines
        .next()
        .map_or("", |(_, l)| l)
        .split('\t')
        .map(|h| (h.to_string(), vec![]))
        .collect();
    for (r, line) in lines {
        let cells: Vec<&str> = line.split('\t').collect();
        if cells.len() != cols.len() {
            return Err(format!(
                "row {} has {} cells, header has {}",
                r,
                cells.len(),
                cols.len()
            ));
        }
        for ((name, col), cell) in cols.iter_mut().zip(cells) {
            let value = match cell {
                "n/a" | "" => 0.0,
                v => v
                    .parse::<f64>()
                    .map_err(|_| format!("row {r}, column {name}: '{v}' is not a number"))?,
            };
            if !value.is_finite() {
                return Err(format!(
                    "row {r}, column {name}: '{cell}' is not a finite number"
                ));
            }
            col.push(value);
        }
    }
    Ok(cols)
}

pub fn events(text: &str) -> Result<Vec<Event>, String> {
    let cols = columns(text);
    let col = |k: &str| {
        cols.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v)
            .ok_or(format!("events: no {k} column"))
    };
    let (onset, duration, kind) = (col("onset")?, col("duration")?, col("trial_type")?);
    let num = |v: &str| {
        v.parse::<f64>()
            .map_err(|_| format!("events: '{v}' is not a number"))
    };
    (0..onset.len())
        .map(|i| {
            Ok(Event {
                onset: num(&onset[i])?,
                duration: num(&duration[i])?,
                trial_type: kind[i].clone(),
            })
        })
        .collect()
}

fn columns(text: &str) -> Vec<(String, Vec<String>)> {
    let mut lines = text
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty());
    let mut cols: Vec<(String, Vec<String>)> = lines
        .next()
        .unwrap_or("")
        .split('\t')
        .map(|h| (h.to_string(), vec![]))
        .collect();
    for line in lines {
        // a short row (hand-edited events.tsv) reads as empty trailing cells
        let cells = line.split('\t').chain(std::iter::repeat(""));
        for ((_, col), cell) in cols.iter_mut().zip(cells) {
            col.push(cell.to_string());
        }
    }
    cols
}

/// First maximum in NumPy C order (x slowest) and its world position rounded half-to-even.
pub fn peak(img: &Image, t: &[f32]) -> (f32, Vec<i64>) {
    let [nx, ny, nz] = img.dims;
    let (mut best, mut at) = (f32::NEG_INFINITY, [0usize; 3]);
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                let v = t[i + nx * (j + ny * k)];
                if v > best {
                    (best, at) = (v, [i, j, k]);
                }
            }
        }
    }
    let mm = img.affine.iter().map(|r| {
        (r[0] * at[0] as f64 + r[1] * at[1] as f64 + r[2] * at[2] as f64 + r[3]).round_ties_even()
            as i64
    });
    (best, mm.collect())
}

/// NumPy median of float32 values (mean of the middle pair in float32).
pub fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(f32::total_cmp);
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// Smoothed series and glm.py's brain mask (computed before smoothing).
fn prepare(img: &mut Image, fwhm: f64) -> Vec<bool> {
    let nvox = img.dims.iter().product::<usize>();
    let m = mask(&img.data, nvox, img.nvol);
    if fwhm > 0.0 {
        let sig = sigma(fwhm, img.zooms);
        for v in img.data.chunks_exact_mut(nvox) {
            gaussian_filter(v, img.dims, sig);
        }
    }
    m
}

fn repetition_time(side: &Map<String, Value>) -> Result<f64, String> {
    side.get("RepetitionTime")
        .and_then(Value::as_f64)
        .ok_or_else(|| "sidecar lacks RepetitionTime".into())
}

/// `--task-analysis`: the four left/right t maps (`.nii.gz` bytes, t-test intent with df) and the JSON summary.
pub fn task_analysis(
    bold: &[u8],
    sidecar: &str,
    conf: &str,
    events_tsv: &str,
    fwhm: f64,
) -> Result<(Vec<Vec<u8>>, String), String> {
    let mut img = decode(bold)?;
    let m = prepare(&mut img, fwhm);
    let side: Map<String, Value> =
        serde_json::from_str(sidecar).map_err(|e| format!("sidecar: {e}"))?;
    let start = side.get("StartTime").and_then(Value::as_f64);
    let (d, drop) = design(
        img.nvol,
        repetition_time(&side)?,
        &events(events_tsv)?,
        &["left", "right"],
        &confounds(conf)?,
        start,
    )?;
    let df = d.n - d.p;
    let contrasts: Vec<Vec<f64>> = TASK_CONTRASTS.iter().map(|(_, c)| c.to_vec()).collect();
    let (maps, rho) = tstat(
        &img.data, img.dims, &m, &d, drop, img.zooms, true, 5.0, &contrasts,
    )?;
    let p_display = 0.001;
    let t_display = t_isf(p_display, df as f64);
    let nvox = m.len();
    let median_rho = median((0..nvox).filter(|&i| m[i]).map(|i| rho[i]).collect()) as f64;
    let mut res = Map::new();
    res.insert("df".into(), json!(df));
    res.insert("p_display".into(), json!(p_display));
    res.insert("t_display".into(), json!(t_display));
    let mut out = vec![];
    for ((label, _), t) in TASK_CONTRASTS.iter().zip(&maps) {
        out.push(encode(&img, t, Some(df as f32))); // viewers convert t to p/z from the stored df
        let (peak_t, peak_mm) = peak(&img, t);
        let above = t.iter().filter(|&&v| v as f64 > t_display).count();
        res.insert(
            (*label).into(),
            json!({"peak_t": peak_t as f64, "peak_mm": peak_mm, "voxels_above_display": above, "median_rho": median_rho}),
        );
    }
    Ok((out, Value::Object(res).to_string()))
}

/// Positional mode: one condition's t map (no intent, default mid-TR sampling) and glm.py's report line
/// (without the output path).
pub fn single(
    bold: &[u8],
    sidecar: &str,
    conf: &str,
    events_tsv: &str,
    condition: &str,
    fwhm: f64,
    ols: bool,
) -> Result<(Vec<u8>, String), String> {
    let mut img = decode(bold)?;
    let m = prepare(&mut img, fwhm);
    let side: Map<String, Value> =
        serde_json::from_str(sidecar).map_err(|e| format!("sidecar: {e}"))?;
    let (d, drop) = design(
        img.nvol,
        repetition_time(&side)?,
        &events(events_tsv)?,
        &[condition],
        &confounds(conf)?,
        None,
    )?;
    let (maps, rho) = tstat(
        &img.data,
        img.dims,
        &m,
        &d,
        drop,
        img.zooms,
        !ols,
        5.0,
        &[vec![1.0]],
    )?;
    let (peak_t, mm) = peak(&img, &maps[0]);
    let median_rho = median((0..m.len()).filter(|&i| m[i]).map(|i| rho[i]).collect());
    let above = maps[0].iter().filter(|&&v| v > 3.1).count();
    let mm: Vec<String> = mm.iter().map(i64::to_string).collect();
    let line = format!(
        "dropped {drop}, AR(1) rho median {median_rho:.2}, peak t {peak_t:.1} at [{}], voxels t>3.1: {above}",
        mm.join(", ")
    );
    Ok((encode(&img, &maps[0], None), line))
}

#[cfg(test)]
mod tests {
    use super::confounds;

    #[test]
    fn confounds_reject_nonfinite_cells_with_location() {
        for value in ["NaN", "inf", "-inf", "1e999"] {
            let text = format!("trans_x\trot_z\r\n0\t0\r\n\r\n0\t{value}\r\n");
            let error = confounds(&text).expect_err(value);
            assert_eq!(
                error,
                format!("row 4, column rot_z: '{value}' is not a finite number")
            );
        }
    }

    #[test]
    fn confounds_preserve_missing_cells_and_finite_numbers() {
        assert_eq!(
            confounds("trans_x\trot_z\nn/a\t\n-0.25\t1e-3\n").unwrap(),
            vec![
                ("trans_x".into(), vec![0.0, -0.25]),
                ("rot_z".into(), vec![0.0, 0.001]),
            ]
        );
    }
}
