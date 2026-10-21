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

/// Pearson r over the pairs where both are finite; NaN with fewer than 3 or a constant side (NumPy `corrcoef`).
fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let (a, b): (Vec<f64>, Vec<f64>) = x
        .iter()
        .zip(y)
        .filter(|(p, q)| p.is_finite() && q.is_finite())
        .map(|(p, q)| (*p, *q))
        .unzip();
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (p, q) in a.iter().zip(&b) {
        sab += (p - ma) * (q - mb);
        saa += (p - ma) * (p - ma);
        sbb += (q - mb) * (q - mb);
    }
    if a.len() > 2 && saa > 0.0 && sbb > 0.0 {
        sab / (saa * sbb).sqrt()
    } else {
        f64::NAN
    }
}

/// R² of `y` on an intercept and `cols` (modified Gram-Schmidt; dependent columns add nothing).
fn r2(y: &[f64], cols: &[&[f64]]) -> f64 {
    let n = y.len();
    let mean = y.iter().sum::<f64>() / n as f64;
    let mut basis: Vec<Vec<f64>> = vec![];
    let ones = vec![1.0; n];
    for c in std::iter::once(ones.as_slice()).chain(cols.iter().copied()) {
        let mut v = c.to_vec();
        for q in &basis {
            let d: f64 = v.iter().zip(q).map(|(a, b)| a * b).sum();
            v.iter_mut().zip(q).for_each(|(a, b)| *a -= d * b);
        }
        let norm = v.iter().map(|a| a * a).sum::<f64>().sqrt();
        if norm > 1e-10 * (n as f64).sqrt() {
            basis.push(v.iter().map(|a| a / norm).collect());
        }
    }
    let mut e = y.to_vec();
    for q in &basis {
        let d: f64 = e.iter().zip(q).map(|(a, b)| a * b).sum();
        e.iter_mut().zip(q).for_each(|(a, b)| *a -= d * b);
    }
    1.0 - e.iter().map(|a| a * a).sum::<f64>()
        / y.iter().map(|a| (a - mean) * (a - mean)).sum::<f64>()
}

/// `--meica-qc` (glm.py `meica_qc`): per ICA component, r with each HRF-convolved trial type and, given several,
/// all of them summed; r with FD and the largest |r| with the 6 motion parameters; per regressor, R² of the rejected
/// and of the accepted components' time courses. Over the usable volumes; nonfinite FD skipped pairwise.
pub fn meica_qc(
    mixing: &str,
    metrics: &str,
    conf_tsv: &str,
    events_tsv: Option<&str>,
    sidecar: &str,
) -> Result<String, String> {
    let mix = columns(mixing);
    let num = |v: &String| {
        v.parse::<f64>()
            .map_err(|_| format!("mixing: '{v}' is not a number"))
    };
    let mix: Vec<(String, Vec<f64>)> = mix
        .into_iter()
        .map(|(k, v)| Ok((k, v.iter().map(num).collect::<Result<_, String>>()?)))
        .collect::<Result<_, String>>()?;
    let conf = confounds(conf_tsv)?;
    let raw = columns(conf_tsv);
    let col = |k: &str| {
        conf.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_slice())
            .ok_or(format!("confounds lack {k}"))
    };
    let nvol = col("trans_x")?.len();
    let drop = conf
        .iter()
        .filter(|(k, _)| k.starts_with("non_steady_state"))
        .count();
    let rows = mix.first().map_or(0, |(_, v)| v.len());
    if rows + drop != nvol {
        return Err("mixing rows must equal the usable volumes".into());
    }
    let side: Map<String, Value> =
        serde_json::from_str(sidecar).map_err(|e| format!("sidecar: {e}"))?;
    let mut regs: Vec<(String, Vec<f64>)> = vec![];
    // BIDS trial_type is optional: without it there is no task design to relate to
    if let Some(ev) = events_tsv.filter(|t| {
        columns(t)
            .iter()
            .any(|(k, v)| k == "trial_type" && !v.is_empty())
    }) {
        let ev = events(ev)?;
        let mut conds: Vec<&str> = ev.iter().map(|e| e.trial_type.as_str()).collect();
        conds.sort_unstable();
        conds.dedup();
        let (d, _) = design(
            nvol,
            repetition_time(&side)?,
            &ev,
            &conds,
            &conf,
            side.get("StartTime").and_then(Value::as_f64),
        )?;
        for (j, c) in conds.iter().enumerate() {
            regs.push((c.to_string(), (0..d.n).map(|r| d.at(r, j)).collect()));
        }
        if conds.len() > 1 {
            regs.push((
                "all".into(),
                (0..d.n)
                    .map(|r| (0..conds.len()).map(|j| d.at(r, j)).sum())
                    .collect(),
            ));
        }
    }
    let class: Vec<String> = columns(metrics)
        .into_iter()
        .find(|(k, _)| k == "classification")
        .ok_or("metrics: no classification column")?
        .1;
    let fd: Vec<f64> = raw
        .iter()
        .find(|(k, _)| k == "framewise_displacement")
        .ok_or("confounds lack framewise_displacement")?
        .1[drop..]
        .iter()
        .map(|v| v.parse().unwrap_or(f64::NAN))
        .collect();
    let of = |label: &str| -> Vec<&[f64]> {
        mix.iter()
            .zip(&class)
            .filter(|(_, c)| *c == label)
            .map(|((_, v), _)| v.as_slice())
            .collect()
    };
    let mut span = Map::new();
    for (c, y) in &regs {
        span.insert(
            c.clone(),
            json!({"rejected": r2(y, &of("rejected")), "accepted": r2(y, &of("accepted"))}),
        );
    }
    let mut comps = Map::new();
    for (name, m) in &mix {
        let task: Map<String, Value> = regs
            .iter()
            .map(|(c, y)| (c.clone(), json!(pearson(m, y))))
            .collect();
        let motion = crate::MOTION
            .iter()
            .map(|q| col(q).map(|v| pearson(m, &v[drop..]).abs()))
            .collect::<Result<Vec<f64>, _>>()?
            .into_iter()
            .fold(f64::NAN, f64::max);
        comps.insert(
            name.clone(),
            json!({"task": task, "fd": pearson(m, &fd), "motion": motion}),
        );
    }
    let conditions: Vec<&String> = regs.iter().map(|(c, _)| c).collect();
    Ok(
        json!({"conditions": conditions, "volumes": rows, "span": span, "components": comps})
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::{confounds, meica_qc};
    use serde_json::{Value, json};

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

    #[test]
    fn meica_qc_relates_components_to_task_and_fd() {
        let n = 40;
        let events = "onset\tduration\ttrial_type\n10\t10\tleft\n50\t10\tright\n";
        let motion = ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z"];
        let mut conf = format!(
            "non_steady_state_outlier00\tframewise_displacement\t{}\n",
            motion.join("\t")
        );
        for t in 0..n {
            let fd = if t == 0 {
                "n/a".to_string()
            } else {
                format!("{:.3}", (t - 1) as f64 / (n - 2) as f64)
            };
            conf += &format!(
                "{}\t{fd}\t0.0\t0.0\t0.0\t0.0\t0.0\t{}\n",
                (t == 0) as u8,
                t % 7
            );
        }
        let zero: Vec<(String, Vec<f64>)> = motion
            .iter()
            .map(|m| (m.to_string(), vec![0.0; n]))
            .chain([(
                "non_steady_state_outlier00".into(),
                (0..n).map(|t| (t == 0) as u8 as f64).collect(),
            )])
            .collect();
        let (d, _) = crate::design(
            n,
            2.0,
            &super::events(events).unwrap(),
            &["left", "right"],
            &zero,
            None,
        )
        .unwrap();
        let mut mix = "ICA_00\tICA_01\n".to_string();
        for r in 0..d.n {
            mix += &format!("{}\t{r}\n", d.at(r, 0));
        }
        let metrics = "Component\tclassification\nICA_00\trejected\nICA_01\taccepted\n";
        let q: Value = serde_json::from_str(
            &meica_qc(
                &mix,
                metrics,
                &conf,
                Some(events),
                r#"{"RepetitionTime": 2.0}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(q["conditions"], json!(["left", "right", "all"]));
        assert!((q["components"]["ICA_00"]["task"]["left"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        assert!((q["components"]["ICA_01"]["fd"].as_f64().unwrap() - 1.0).abs() < 1e-4); // FD's n/a row is the dummy
        assert!((q["span"]["left"]["rejected"].as_f64().unwrap() - 1.0).abs() < 1e-9);
    }
}
