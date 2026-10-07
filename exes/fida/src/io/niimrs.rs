//! NIfTI-MRS (.nii / .nii.gz with the JSON header extension, ecode 44):
//! FID-A `io_loadspec_niimrs` (which reads the file with dicm2nii's
//! `nii_tool`). NIfTI-1 and NIfTI-2, either byte order, complex64 or
//! complex128 data. Single-voxel data only, as in FID-A.
//!
//! The NIfTI-MRS dimension tags map to FID-A dimensions as FID-A maps them:
//! DIM_COIL -> coils, DIM_DYN -> averages, DIM_EDIT and DIM_ISIS -> subSpecs,
//! DIM_INDIRECT_0/1/2, DIM_PHASE_CYCLE, DIM_MEAS and DIM_USER_0/1/2 -> extras.
//! FID-A's quirks are kept: the data are conjugated, `te`/`tr` are the JSON
//! EchoTime/RepetitionTime in seconds (other FID-A readers give ms), and the
//! ppm axis uses 42.577 MHz/T and 4.65 ppm whatever the nucleus.

use super::common::{fresh_flags, maybe_gunzip, octave_range, Bytes, NdArray, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;
use serde_json::Value;

/// The parts of a NIfTI header FID-A uses.
#[derive(Clone, Debug)]
pub struct NiftiHeader {
    /// `dim[0..8]`
    pub dim: [i64; 8],
    /// `pixdim[0..8]`
    pub pixdim: [f64; 8],
    pub datatype: i16,
    pub vox_offset: usize,
    pub big_endian: bool,
    /// (ecode, content) of every header extension.
    pub extensions: Vec<(i32, Vec<u8>)>,
}

fn parse_header(b: &Bytes) -> Res<NiftiHeader> {
    let le = b.i32le(0)?;
    let be = i32::from_be_bytes(le.to_le_bytes());
    let (v2, big) = match (le, be) {
        (348, _) => (false, false),
        (540, _) => (true, false),
        (_, 348) => (false, true),
        (_, 540) => (true, true),
        _ => return Err("This is not a NIfTI file (the header size is neither 348 nor 540).".into()),
    };
    let rd = |off: usize, n: usize| -> Res<Vec<u8>> {
        let mut v = b.slice(off, n)?.to_vec();
        if big {
            v.reverse();
        }
        Ok(v)
    };
    let i16_ = |off| -> Res<i16> { let v = rd(off, 2)?; Ok(i16::from_le_bytes([v[0], v[1]])) };
    let i32_ = |off| -> Res<i32> { let v = rd(off, 4)?; Ok(i32::from_le_bytes([v[0], v[1], v[2], v[3]])) };
    let i64_ = |off| -> Res<i64> { let v = rd(off, 8)?; Ok(i64::from_le_bytes(v.try_into().unwrap())) };
    let f32_ = |off| -> Res<f32> { let v = rd(off, 4)?; Ok(f32::from_le_bytes([v[0], v[1], v[2], v[3]])) };
    let f64_ = |off| -> Res<f64> { let v = rd(off, 8)?; Ok(f64::from_le_bytes(v.try_into().unwrap())) };
    let mut dim = [0i64; 8];
    let mut pixdim = [0f64; 8];
    let (datatype, vox, ext_at);
    if v2 {
        datatype = i16_(12)?;
        for k in 0..8 {
            dim[k] = i64_(16 + 8 * k)?;
            pixdim[k] = f64_(104 + 8 * k)?;
        }
        vox = i64_(168)?;
        ext_at = 540;
    } else {
        datatype = i16_(70)?;
        for k in 0..8 {
            dim[k] = i16_(40 + 2 * k)? as i64;
            pixdim[k] = f32_(76 + 4 * k)? as f64;
        }
        vox = f32_(108)? as i64;
        ext_at = 348;
    }
    if vox < 0 {
        return Err("This NIfTI file has a negative data offset.".into());
    }
    let vox = vox as usize;
    let mut extensions = Vec::new();
    if b.len() >= ext_at + 4 && b.u8(ext_at)? != 0 {
        let mut p = ext_at + 4;
        while p + 8 <= vox && p + 8 <= b.len() {
            let esize = i32_(p)?;
            let ecode = i32_(p + 4)?;
            if esize < 8 || p + esize as usize > b.len() {
                break;
            }
            extensions.push((ecode, b.b[p + 8..p + esize as usize].to_vec()));
            p += esize as usize;
        }
    }
    if !(1..=7).contains(&dim[0]) {
        return Err(format!("This NIfTI file declares {} dimensions.", dim[0]));
    }
    Ok(NiftiHeader { dim, pixdim, datatype, vox_offset: vox, big_endian: big, extensions })
}

fn json_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Array(a) => a.first().and_then(json_f64),
        _ => None,
    }
}

fn json_strs(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

/// The NIfTI-MRS JSON header extension of a file.
pub fn header_json(data: &[u8]) -> Res<Value> {
    let raw = maybe_gunzip(data)?;
    let b = Bytes::new(&raw, "NIfTI-MRS");
    let h = parse_header(&b)?;
    json_of(&h)
}

fn json_of(h: &NiftiHeader) -> Res<Value> {
    let ext = h
        .extensions
        .iter()
        .find(|(c, _)| *c == 44)
        .or_else(|| h.extensions.first())
        .ok_or("This NIfTI file has no NIfTI-MRS header extension; it is not NIfTI-MRS.")?;
    let txt: Vec<u8> = ext.1.iter().copied().filter(|&c| c != 0).collect();
    serde_json::from_slice(&txt).map_err(|e| format!("The NIfTI-MRS header extension is not valid JSON: {e}"))
}

/// FID-A `io_loadspec_niimrs(filename)` on the bytes of a .nii or .nii.gz file.
pub fn load(data: &[u8]) -> Res<Spectra> {
    let raw = maybe_gunzip(data)?;
    let b = Bytes::new(&raw, "NIfTI-MRS");
    let h = parse_header(&b)?;
    let js = json_of(&h)?;
    let nd = h.dim[0] as usize;
    let shape: Vec<usize> = (1..=nd).map(|k| h.dim[k].max(0) as usize).collect();
    let n: usize = shape.iter().product();
    let (esz, cplx) = match h.datatype {
        32 => (8, true),
        1792 => (16, true),
        16 => (4, false),
        64 => (8, false),
        d => return Err(format!("This NIfTI-MRS file stores datatype {d}; FID-A expects complex data (complex64 or complex128).")),
    };
    let bytes = b.slice(h.vox_offset, n * esz)?;
    let rd = |o: usize, w: usize| -> f64 {
        let mut v = bytes[o..o + w].to_vec();
        if h.big_endian {
            v.reverse();
        }
        if w == 4 {
            f32::from_le_bytes([v[0], v[1], v[2], v[3]]) as f64
        } else {
            f64::from_le_bytes(v.try_into().unwrap())
        }
    };
    let img: Vec<Complex64> = (0..n)
        .map(|k| {
            if cplx {
                let w = esz / 2;
                Complex64::new(rd(k * esz, w), rd(k * esz + w, w))
            } else {
                Complex64::new(rd(k * esz, esz), 0.0)
            }
        })
        .collect();
    let mut shape = shape;
    if shape.len() == 1 {
        shape.push(1);
    }
    let fids = NdArray::new(img, shape);

    let f0 = js.get("SpectrometerFrequency").and_then(json_f64).ok_or("The NIfTI-MRS header has no SpectrometerFrequency.")?;
    let dt = h.pixdim[4];
    let sw = 1.0 / dt;
    // dims in FID-A's field order: x y z t coils averages subSpecs extras
    let mut d: [usize; 8] = [1, 2, 3, 4, 0, 0, 0, 0];
    for k in 5..=7 {
        if let Some(tag) = js.get(format!("dim_{k}")) {
            let tag = tag.as_str().unwrap_or("");
            let slot = match tag {
                "DIM_COIL" => 4,
                "DIM_DYN" => 5,
                "DIM_EDIT" | "DIM_ISIS" => 6,
                "DIM_INDIRECT_0" | "DIM_INDIRECT_1" | "DIM_INDIRECT_2" | "DIM_PHASE_CYCLE" | "DIM_MEAS" | "DIM_USER_0"
                | "DIM_USER_1" | "DIM_USER_2" => 7,
                other => return Err(format!("Unknown dimension value specified in dim_{k}: {other}")),
            };
            d[slot] = k;
        }
    }
    let all: Vec<usize> = (1..=7).map(|k| h.dim[k].max(0) as usize).collect();
    let ad = |k: usize| all[k - 1];
    let npts = ad(d[3]);
    let (averages, raw_averages) = if d[6] != 0 {
        if d[5] != 0 {
            let a = ad(d[5]) * ad(d[6]);
            (a, a)
        } else {
            (ad(d[6]), 1)
        }
    } else if d[5] != 0 {
        (ad(d[5]), ad(d[5]))
    } else {
        (1, 1)
    };
    let subspecs = if d[6] != 0 { ad(d[6]) } else { 1 };
    if ad(1) * ad(2) * ad(3) != 1 {
        return Err("This NIfTI-MRS file holds more than one voxel (MRSI); FID-A's reader handles single-voxel data only.".into());
    }
    let mut fids = fids.squeeze();
    let names = ["x", "y", "z", "t", "coils", "averages", "subSpecs", "extras"];
    let mut sqz = Vec::new();
    for k in 0..3 {
        d[k] = 0;
    }
    let mut squeezed_axis = [0usize; 8];
    let mut axis = 0;
    for k in 1..=nd {
        if h.dim[k] != 1 {
            axis += 1;
            squeezed_axis[k] = axis;
        }
    }
    for k in 3..8 {
        d[k] = squeezed_axis[d[k]];
        if d[k] != 0 {
            sqz.push(names[k]);
        }
    }
    let (t, c, a, s, e) = (d[3], d[4], d[5], d[6], d[7]);
    let dd = |t, coils, averages, sub_specs, extras| Dims { t, coils, averages, sub_specs, extras };
    let perm = |f: NdArray, o: &[usize]| -> Res<NdArray> {
        f.permute(o).map_err(|_| {
            "FID-A cannot order the dimensions of this NIfTI-MRS file (a tagged dimension has size 1?).".to_string()
        })
    };
    let mut dims = dd(t, c, a, s, e);
    match sqz.len() {
        5 => {
            fids = perm(fids, &[t, c, a, s, e])?;
            dims = dd(1, 2, 3, 4, 5);
        }
        4 => {
            if e == 0 {
                fids = perm(fids, &[t, c, a, s])?;
                dims = dd(1, 2, 3, 4, 0);
            } else if s == 0 {
                fids = perm(fids, &[t, c, a, e])?;
                dims = dd(1, 2, 3, 0, 4);
            } else if a == 0 {
                // FID-A's `dims;averages=0;` typo leaves averages at 0
                fids = perm(fids, &[t, c, s, e])?;
                dims = dd(1, 2, 0, 3, 4);
            } else if c == 0 {
                fids = perm(fids, &[t, a, s, e])?;
                dims = dd(1, 0, 2, 3, 4);
            }
        }
        3 => {
            if e == 0 && s == 0 {
                fids = perm(fids, &[t, c, a])?;
                dims = dd(1, 2, 3, 0, 0);
            } else if e == 0 && a == 0 {
                fids = perm(fids, &[t, c, s])?;
                dims = dd(1, 2, 0, 3, 0);
            } else if e == 0 && c == 0 {
                fids = perm(fids, &[t, a, s])?;
                dims = dd(1, 0, 2, 3, 0);
            }
        }
        2 => {
            if e == 0 && s == 0 && a == 0 {
                fids = perm(fids, &[t, c])?;
                dims = dd(1, 2, 0, 0, 0);
            } else if e == 0 && s == 0 && c == 0 {
                fids = perm(fids, &[t, a])?;
                dims = dd(1, 0, 2, 0, 0);
            } else if e == 0 && a == 0 && c == 0 {
                fids = perm(fids, &[t, s])?;
                dims = dd(1, 0, 0, 2, 0);
            }
        }
        1 => dims = dd(1, 0, 0, 0, 0),
        _ => {}
    }
    let sz = fids.shape.clone();
    let data: Vec<Complex64> = fids.data.iter().map(|z| z.conj()).collect();

    let nuclei = js.get("ResonantNucleus").map(json_strs).unwrap_or_default();
    if nuclei.is_empty() {
        return Err("The NIfTI-MRS header has no ResonantNucleus.".into());
    }
    let gamma = match nuclei[0].as_str() {
        "1H" => 42.577,
        "2H" => 6.536,
        "3HE" => -32.434,
        "7LI" => 16.546,
        "13C" => 10.708,
        "19F" => 40.052,
        "23NA" => 11.262,
        "31P" => 17.235,
        "129XE" => -11.777,
        other => return Err(format!("FID-A does not know the gyromagnetic ratio of {other}.")),
    };
    let bo = f0 / gamma;
    let np = npts as f64;
    let f = octave_range((-sw / 2.0) + (sw / (2.0 * np)), sw / np, (sw / 2.0) - (sw / (2.0 * np)));
    let ppm: Vec<f64> = f.iter().map(|&x| -x / (bo * 42.577) + 4.65).collect();
    let t_axis = if npts == 0 { Vec::new() } else { octave_range(0.0, dt, (np - 1.0) * dt) };
    let te = js.get("EchoTime").and_then(json_f64).ok_or("The NIfTI-MRS header has no EchoTime (FID-A requires it).")?;
    let tr = js.get("RepetitionTime").and_then(json_f64).ok_or("The NIfTI-MRS header has no RepetitionTime (FID-A requires it).")?;
    let mut flags = fresh_flags();
    flags.averaged = dims.averages == 0;
    flags.addedrcvrs = dims.coils == 0;
    flags.is_four_steps = dims.sub_specs != 0 && sz.get(dims.sub_specs - 1).copied() == Some(4);
    Ok(Spectra {
        fids: data,
        sz,
        dims,
        ppm,
        t: t_axis,
        spectralwidth: sw,
        dwelltime: dt,
        txfrq: f0 * 1e6,
        te,
        tr,
        bo,
        seq: js.get("SequenceName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        date: String::new(),
        averages,
        raw_averages,
        subspecs,
        raw_subspecs: subspecs,
        points_to_leftshift: 0.0,
        flags,
        nucleus: nuclei[0].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_nifti() {
        assert!(load(b"hello").is_err());
        assert!(load(&[0u8; 400]).is_err());
        let mut h = vec![0u8; 400];
        h[0..4].copy_from_slice(&348i32.to_le_bytes());
        h[40..42].copy_from_slice(&4i16.to_le_bytes());
        assert!(load(&h).is_err());
    }
}
