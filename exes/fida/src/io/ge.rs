//! GE P-files (.7): FID-A `io_loadspec_GE` with Gannet's `GELoad` (as shipped
//! in FID-A's gannetTools), including the separate water reference frames.

use super::common::{fresh_flags, octave_range, time_axis, Bytes, NdArray, Res};
use super::geometry::{self, Voxel};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;

/// Result of reading a P-file: water-suppressed and water reference data.
#[derive(Clone, Debug)]
pub struct GeResult {
    pub out: Spectra,
    pub out_w: Spectra,
    /// `rdbm_rev_num`, the header revision.
    pub revision: f32,
    /// Pulse sequence name (`psd_nam`) when the header layout exposes it.
    pub psd_name: String,
    /// The voxel from the image header (not read by FID-A or GELoad).
    pub voxel: Option<Voxel>,
    /// Why there is no voxel: the header values it would be built from.
    pub voxel_note: Option<String>,
}

/// Header positions (1-based element indices, as in GELoad) per revision.
struct Layout {
    off_image: usize,
    off_data: usize,
    ps_mps_freq: usize,
    user0: usize,
    user4: usize,
    user19: usize,
    nechoes: usize,
    navs: usize,
    nframes: usize,
    point_size: usize,
    da_xres: usize,
    da_yres: usize,
    start_rcv: usize,
    stop_rcv: usize,
    image_te: usize,
    image_tr: usize,
    /// `user8`, the first of the voxel size (user8-10) and centre (user11-13).
    image_user8: usize,
    /// `tlhc_R`, the first of the tlhc, trhc and brhc corners (R, A, S each).
    image_tlhc: usize,
}

/// Octave `num2str` of a non-negative real scalar (the revision number).
fn num2str(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let mag = if x == 0.0 { 0 } else { x.abs().log10().floor() as i32 };
    let sig = (mag + 5).max(5).min(16);
    // %.{sig}g
    let prec = (sig - 1 - mag).max(0) as usize;
    let mut s = format!("{:.*}", prec, x);
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

fn layout(rev: &str) -> Option<Layout> {
    // The geometry fields sit at fixed distances before `te` (spec2nii's
    // ge_hdr_fields): 143 and 60 words up to revision 16, 169 and 86 after.
    let base = |te, tr, user8, tlhc| Layout {
        off_image: 377,
        off_data: 368,
        ps_mps_freq: 107,
        user0: 55,
        user4: 59,
        user19: 74,
        nechoes: 36,
        navs: 37,
        nframes: 38,
        point_size: 42,
        da_xres: 52,
        da_yres: 53,
        start_rcv: 101,
        stop_rcv: 102,
        image_te: te,
        image_tr: tr,
        image_user8: user8,
        image_tlhc: tlhc,
    };
    Some(match rev {
        "14.3" => base(181, 179, 38, 121),
        "16" => base(193, 191, 50, 133),
        "20.006" | "20.007" | "24" => base(267, 265, 98, 181),
        "26.002" | "27" | "27.001" | "28.002" | "28.003" | "30" | "30.1" => Layout {
            off_image: 11,
            off_data: 2,
            ps_mps_freq: 123,
            user0: 71,
            user4: 75,
            user19: 90,
            nechoes: 74,
            navs: 75,
            nframes: 76,
            point_size: 80,
            da_xres: 90,
            da_yres: 91,
            start_rcv: 133,
            stop_rcv: 134,
            image_te: 267,
            image_tr: 265,
            image_user8: 98,
            image_tlhc: 181,
        },
        _ => return None,
    })
}

struct GeLoad {
    full: NdArray,  // npoints x frames x receivers (squeezed)
    water: NdArray, // npoints x waterframes x receivers (squeezed)
    larmor: f64,
    sw: f64,
    te: f64,
    tr: f64,
    revision: f32,
    psd_name: String,
    voxel: Option<Voxel>,
    voxel_note: Option<String>,
}

/// GELoad(fname).
fn ge_load(data: &[u8]) -> Res<GeLoad> {
    let b = Bytes::new(data, "GE P-file");
    if data.len() < 4096 {
        return Err("This file is too small to be a GE P-file.".into());
    }
    let be_rev = b.f32be(0)?;
    let pfile_header_size_fixed: Option<usize>;
    let rev: f32;
    if be_rev == 7.0 || be_rev == 8.0 || (be_rev > 5.0 && be_rev < 6.0) {
        // Big-endian LX/MGD/5.x headers: GELoad has no field table for them and errors.
        return Err(format!(
            "This is a GE P-file with header revision {be_rev} (big-endian, pre-11.0), which FID-A's GE reader does not support."
        ));
    } else {
        rev = b.f32le(0)?;
        pfile_header_size_fixed = if rev == 9.0 {
            Some(61464)
        } else if rev == 11.0 {
            Some(66072)
        } else {
            None
        };
    }
    let revs = num2str(rev as f64);
    let lay = layout(&revs).ok_or_else(|| {
        format!(
            "This GE P-file has header revision {revs}; FID-A's GE reader supports revisions 14.3, 16, 20.006, 20.007, 24, 26.002, 27, 27.001, 28.002, 28.003, 30 and 30.1."
        )
    })?;
    let short = |k: usize| -> Res<i16> { b.i16le(2 * (k - 1)) };
    let float = |k: usize| -> Res<f32> { b.f32le(4 * (k - 1)) };
    let int = |k: usize| -> Res<i32> { b.i32le(4 * (k - 1)) };
    let pfile_header_size = if rev > 11.0 {
        let v = int(lay.off_data)?;
        if v <= 0 {
            return Err("This GE P-file's header gives an invalid data offset.".into());
        }
        v as usize
    } else {
        pfile_header_size_fixed.ok_or("unsupported GE revision")?
    };

    // psd_nam, to detect 'probe-s' (header layout of revision 26+; on older
    // layouts these offsets read other fields, as in GELoad)
    let off_exm = int(9)? as i64;
    let off_img = int(11)? as i64;
    let read_at = |off: i64, n: usize| -> Option<&[u8]> {
        if off < 0 {
            return None;
        }
        let o = off as usize;
        data.get(o..o.checked_add(n)?)
    };
    let psd_name: String = read_at(off_img + 1632, 33)
        .map(|s| s.iter().filter(|&&c| c > 0 && c < 128).map(|&c| c as char).collect())
        .unwrap_or_default();
    let larmor = if psd_name == "probe-s" {
        let bo_raw = read_at(off_exm + 572, 4)
            .map(|s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
            .ok_or("This GE 'probe-s' P-file is truncated (no field strength).")?;
        let bo = bo_raw as f64 * 1e-4;
        bo * 42.577
    } else {
        int(lay.ps_mps_freq)? as f64 / 1e7
    };
    let sw = float(lay.user0)? as f64;
    let nechoes = short(lay.nechoes)? as i64;
    let nex = short(lay.navs)? as f64;
    let nframes = short(lay.nframes)? as f64;
    let point_size = short(lay.point_size)?;
    let mut npoints = short(lay.da_xres)? as i64;
    let nrows = short(lay.da_yres)? as i64;
    let start_recv = short(lay.start_rcv)? as i64;
    let stop_recv = short(lay.stop_rcv)? as i64;
    let nreceivers = stop_recv - start_recv + 1;
    let mut dataframes = float(lay.user4)? as f64 / nex;
    let mut refframes = float(lay.user19)? as f64;

    let off_image = int(lay.off_image)?;
    if off_image < 0 {
        return Err("This GE P-file's header gives an invalid image header offset.".into());
    }
    let off_image = off_image as usize;
    let te = b.i32le(off_image + 4 * (lay.image_te - 1))? as f64 / 1e3;
    let tr = b.i32le(off_image + 4 * (lay.image_tr - 1))? as f64 / 1e3;
    let image_float = |k: usize| b.f32le(off_image + 4 * (k - 1)).ok().map(f64::from);
    let user: Option<Vec<f64>> = (0..6).map(|i| image_float(lay.image_user8 + i)).collect();
    let corners: Option<Vec<f64>> = (0..9).map(|i| image_float(lay.image_tlhc + i)).collect();
    let (voxel, voxel_note) = match user.zip(corners) {
        Some((u, c)) => match geometry::ge_pfile([u[0], u[1], u[2]], [u[3], u[4], u[5]], [[c[0], c[1], c[2]], [c[3], c[4], c[5]], [c[6], c[7], c[8]]]) {
            Some(v) => (Some(v), None),
            None => {
                let f = |x: &[f64]| x.iter().map(|v| format!("{v:.2}")).collect::<Vec<_>>().join(", ");
                let note = format!(
                    "GE P-file revision {revs}: these image header values do not make a voxel box: size user8-10 ({}) mm, centre user11-13 ({}) mm, corners tlhc ({}), trhc ({}), brhc ({})",
                    f(&u[0..3]),
                    f(&u[3..6]),
                    f(&c[0..3]),
                    f(&c[3..6]),
                    f(&c[6..9])
                );
                (None, Some(note))
            }
        },
        None => (None, Some(format!("GE P-file revision {revs}: the image header ends before the voxel fields (user8-13, tlhc/trhc/brhc)"))),
    };

    if npoints == 1 && nrows == 1 {
        npoints = 2048;
    }
    let totalframes = nrows * nechoes;
    if npoints <= 0 || totalframes <= 0 || nreceivers <= 0 || nechoes <= 0 {
        return Err("This GE P-file's header has no spectroscopy data (points, frames or receivers are zero).".into());
    }
    let (np, tf, nr) = (npoints as usize, totalframes as usize, nreceivers as usize);
    let n_elements = np * 2 * tf * nr;
    let psz = if point_size == 2 { 2 } else { 4 };
    let raw = b.slice(pfile_header_size, n_elements * psz).map_err(|_| {
        format!(
            "This GE P-file is truncated: the header announces {} receivers x {} frames x {} points after byte {}, beyond the end of the file.",
            nr, tf, np, pfile_header_size
        )
    })?;
    let sample = |k: usize| -> f64 {
        if psz == 2 {
            i16::from_le_bytes([raw[2 * k], raw[2 * k + 1]]) as f64
        } else {
            i32::from_le_bytes([raw[4 * k], raw[4 * k + 1], raw[4 * k + 2], raw[4 * k + 3]]) as f64
        }
    };
    // ShapeData(re/im, point, frame, receiver), column-major
    let shape = |c: usize, p: usize, f: usize, r: usize| sample(c + 2 * (p + np * (f + tf * r)));

    let frame_count = |x: f64, what: &str| -> Res<usize> {
        if x.is_finite() && x >= 0.0 && x.fract() == 0.0 {
            Ok(x as usize)
        } else {
            Err(format!("This GE P-file's header gives a non-integer number of {what} frames ({x})."))
        }
    };
    // (frame index list, sign list, multiplier) for data and water
    let (full_frames, full_sign, mult, water_frames, water_sign, multw): (Vec<usize>, Vec<f64>, f64, Vec<usize>, Vec<f64>, f64);
    if nechoes == 1 {
        let m;
        if dataframes + refframes != nframes {
            m = 1.0;
            dataframes *= nex;
            refframes = nframes - dataframes;
        } else {
            m = 1.0 / nex;
        }
        let rf = frame_count(refframes, "reference")?;
        if rf + 1 > tf {
            return Err("This GE P-file has fewer frames than its header's water reference count.".into());
        }
        water_frames = (1..rf + 1).collect();
        water_sign = vec![1.0; rf];
        full_frames = (rf + 1..tf).collect();
        full_sign = vec![1.0; tf - rf - 1];
        mult = m;
        multw = m;
    } else {
        let (m, mw, noadd);
        if dataframes + refframes != nframes {
            m = nex / 2.0;
            mw = nex;
            noadd = 1.0;
            dataframes *= nex;
            refframes = nframes - dataframes;
        } else {
            m = nex / 2.0;
            mw = 1.0;
            noadd = 0.0;
        }
        let rf = frame_count(refframes, "reference")?;
        let df = frame_count(dataframes, "data")?;
        let ne = nechoes as usize;
        if tf != (df + rf + 1) * ne {
            return Err("# of totalframes not same as (dataframes + refframes + 1) * nechoes".into());
        }
        let per = tf / ne;
        let mut wf = Vec::new();
        let mut ws = Vec::new();
        for x1 in 1..=rf {
            for x2 in 1..=ne {
                ws.push((-1f64).powf(noadd * (x1 as f64 - 1.0)));
                wf.push(per * (x2 - 1) + x1); // 1 + ... - 1 (0-based)
            }
        }
        let mut ff = Vec::new();
        let mut fs = Vec::new();
        for x1 in 1..=df {
            for x2 in 1..=ne {
                fs.push((-1f64).powf(noadd * (x1 as f64 - 1.0)));
                ff.push(rf + per * (x2 - 1) + x1);
            }
        }
        full_frames = ff;
        full_sign = fs;
        water_frames = wf;
        water_sign = ws;
        mult = m;
        multw = mw;
    }
    let build = |frames: &[usize], sign: &[f64], m: f64| -> NdArray {
        let nf = frames.len();
        let mut v = Vec::with_capacity(np * nf * nr);
        for r in 0..nr {
            for (fi, &f) in frames.iter().enumerate() {
                for p in 0..np {
                    // Y1 .* ShapeData * mult, then re + 1i*im
                    let re = sign[fi] * shape(0, p, f, r) * m;
                    let im = sign[fi] * shape(1, p, f, r) * m;
                    v.push(Complex64::new(re, 0.0) + Complex64::new(0.0, 1.0) * im);
                }
            }
        }
        NdArray::new(v, vec![np, nf, nr]).squeeze()
    };
    let full = build(&full_frames, &full_sign, mult);
    let water = build(&water_frames, &water_sign, multw);
    Ok(GeLoad { full, water, larmor, sw, te, tr, revision: rev, psd_name, voxel, voxel_note })
}

/// FID-A `io_loadspec_GE(filename, subspecs)` on the bytes of a P-file.
/// `subspecs` > 1 splits alternating frames into two subspectra (MEGA-PRESS).
pub fn load(data: &[u8], subspecs: usize) -> Res<GeResult> {
    let g = ge_load(data)?;
    let data_arr = if subspecs > 1 {
        // data(:,:,:,1)=GEout(:,1:2:end,:); data(:,:,:,2)=GEout(:,2:2:end,:)
        let a = &g.full;
        let n = a.dim(1);
        let odd: Vec<usize> = (0..n).step_by(2).collect();
        let even: Vec<usize> = (1..n).step_by(2).collect();
        if odd.len() != even.len() {
            return Err(format!(
                "This GE P-file has an odd number of transients ({n}); FID-A cannot split it into two subspectra."
            ));
        }
        let x = a.select(1, &odd)?;
        let y = a.select(1, &even)?;
        let (p, h, r) = (x.dim(0), x.dim(1), x.dim(2));
        let mut v = x.data;
        v.extend_from_slice(&y.data);
        NdArray::new(v, vec![p, h, r, 2])
    } else {
        g.full.clone()
    };
    let fids = data_arr.squeeze().permute(&[1, 3, 2, 4]).map_err(|_| {
        "FID-A cannot order the dimensions of this GE P-file.".to_string()
    })?;
    let fids_w = g.water.clone().squeeze().permute(&[1, 3, 2]).map_err(|_| {
        "FID-A cannot order the dimensions of this GE P-file's water frames (it has none?).".to_string()
    })?;
    let bo = g.larmor / 42.577;
    let dims = Dims { t: 1, coils: 2, averages: 3, sub_specs: if subspecs > 1 { 4 } else { 0 }, extras: 0 };
    let dims_w = Dims { t: 1, coils: 2, averages: 3, sub_specs: 0, extras: 0 };
    let spectralwidth = g.sw;
    let dwelltime = 1.0 / spectralwidth;
    let txfrq = g.larmor * 1e6;
    let gsz = |sz: &[usize], d: usize| sz.get(d - 1).copied().unwrap_or(1);
    let counts = |sz: &[usize], dims: &Dims| {
        let (averages, raw) = if dims.sub_specs != 0 {
            let a = gsz(sz, dims.averages) * gsz(sz, dims.sub_specs);
            (a, a)
        } else {
            (gsz(sz, dims.averages), gsz(sz, dims.averages))
        };
        let ss = if dims.sub_specs != 0 { gsz(sz, dims.sub_specs) } else { 1 };
        (averages, raw, ss)
    };
    let n = fids.dim(0);
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * n as f64)),
        spectralwidth / n as f64,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * n as f64)),
    );
    // GE: no sign flip of the frequency axis
    let ppm: Vec<f64> = f.iter().map(|&x| x / (bo * 42.577) + 4.65).collect();
    let t = time_axis(dwelltime, n);
    let make = |a: NdArray, dims: Dims, four: bool| -> Spectra {
        let sz = a.shape.clone();
        let (averages, raw_averages, ss) = counts(&sz, &dims);
        let mut flags = fresh_flags();
        flags.is_four_steps = four;
        Spectra {
            fids: a.data,
            sz,
            dims,
            ppm: ppm.clone(),
            t: t.clone(),
            spectralwidth,
            dwelltime,
            txfrq,
            te: g.te,
            tr: g.tr,
            bo,
            seq: String::new(),
            date: String::new(),
            averages,
            raw_averages,
            subspecs: ss,
            raw_subspecs: ss,
            points_to_leftshift: 0.0,
            flags,
            nucleus: "1H".into(),
        }
    };
    let four = dims.sub_specs != 0 && fids.dim(dims.sub_specs - 1) == 4;
    // out_w.flags.isFourSteps uses out's sizes (FID-A), only when out_w has subspecs (never)
    let out = make(fids, dims, four);
    let out_w = make(fids_w, dims_w, false);
    Ok(GeResult { out, out_w, revision: g.revision, psd_name: g.psd_name, voxel: g.voxel, voxel_note: g.voxel_note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_strings() {
        assert_eq!(num2str(24.0), "24");
        assert_eq!(num2str(20.006f32 as f64), "20.006");
        assert_eq!(num2str(14.3f32 as f64), "14.3");
        assert_eq!(num2str(30.1f32 as f64), "30.1");
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(load(&[0u8; 10], 1).is_err());
        assert!(load(&vec![0u8; 70000], 1).is_err());
    }
}
