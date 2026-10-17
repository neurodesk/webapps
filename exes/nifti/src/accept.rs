//! Image acceptance for single-file NIfTI-1, matching pybabel/nibabel: validation, nibabel's load-time
//! repairs and the sform > qform > base affine policy.

use crate::Nifti1Header;

pub struct Header {
    pub shape: Vec<usize>,
    pub zooms: Vec<f64>,
    pub affine: [[f64; 4]; 3],
}

impl Header {
    pub fn ndim(&self) -> usize {
        self.shape.len()
    }
}

/// pybabel `Nifti1Header`: validate, apply nibabel's load-time repairs, then sform > qform > base affine.
pub fn parse(raw: &[u8]) -> Result<Header, String> {
    if raw.len() < 348 {
        return Err("file too short for NIfTI-1 header".into());
    }
    let le = i32::from_le_bytes(raw[0..4].try_into().unwrap()) == 348;
    if !le && i32::from_be_bytes(raw[0..4].try_into().unwrap()) != 348 {
        return Err("not a NIfTI-1 header (sizeof_hdr != 348; NIfTI-2 is not supported)".into());
    }
    let magic = &raw[344..348];
    if magic != b"n+1\0" {
        return Err(format!(
            "invalid NIfTI-1 magic {:?}; only single-file .nii/.nii.gz is supported",
            String::from_utf8_lossy(&magic[..3])
        ));
    }
    let hdr = Nifti1Header::decode(raw[..348].try_into().unwrap());
    let nd = hdr.dim[0];
    if !(1..=7).contains(&nd) {
        return Err(format!("invalid dim[0] {nd}"));
    }
    let nd = nd as usize;
    if hdr.dim[1..=nd].iter().any(|&d| d < 1) {
        return Err(format!("invalid dimensions {:?}", &hdr.dim[1..=nd]));
    }
    let shape: Vec<usize> = hdr.dim[1..=nd].iter().map(|&d| d as usize).collect();
    // nibabel check_fix: qfac -> 1 unless +-1; pixdim[1:4] -> abs, 0 -> 1; unknown xform codes -> 0
    let mut pix: Vec<f64> = hdr.pixdim.iter().map(|&v| v as f64).collect();
    if pix[0] != 1.0 && pix[0] != -1.0 {
        pix[0] = 1.0;
    }
    for p in &mut pix[1..4] {
        *p = if *p == 0.0 { 1.0 } else { p.abs() };
    }
    if pix[1..=nd.min(7)].iter().any(|p| !p.is_finite()) {
        return Err("non-finite voxel size".into());
    }
    let code = |c: i16| if (0..=5).contains(&c) { c } else { 0 };
    let affine = if code(hdr.sform_code) != 0 {
        hdr.srow.map(|r| r.map(|v| v as f64))
    } else if code(hdr.qform_code) != 0 {
        qform(&hdr, &pix)?
    } else {
        let n = |a: usize| *shape.get(a).unwrap_or(&1) as f64;
        let z = |a: usize| if a < nd { pix[a + 1] } else { 1.0 };
        [
            [-z(0), 0.0, 0.0, (n(0) - 1.0) / 2.0 * z(0)],
            [0.0, z(1), 0.0, -(n(1) - 1.0) / 2.0 * z(1)],
            [0.0, 0.0, z(2), -(n(2) - 1.0) / 2.0 * z(2)],
        ]
    };
    if affine.iter().flatten().any(|v| !v.is_finite()) {
        return Err("non-finite affine".into());
    }
    Ok(Header {
        zooms: pix[1..=nd].to_vec(),
        shape,
        affine,
    })
}

fn qform(hdr: &Nifti1Header, pix: &[f64]) -> Result<[[f64; 4]; 3], String> {
    let [b, c, d] = hdr.quaternion.map(|v| v as f64);
    let mut w2 = 1.0 - (b * b + c * c + d * d);
    if w2.abs() < 3.0 * 2f64.powi(-23) {
        w2 = 0.0; // nibabel fillpositive
    } else if w2 < 0.0 {
        return Err(format!("w2 should be positive, but is {w2:e}"));
    }
    let (w, x, y, z) = (w2.sqrt(), b, c, d);
    let s = 2.0 / (w * w + x * x + y * y + z * z);
    let (xs, ys, zs) = (x * s, y * s, z * s);
    let r = [
        [1.0 - (y * ys + z * zs), x * ys - w * zs, x * zs + w * ys],
        [x * ys + w * zs, 1.0 - (x * xs + z * zs), y * zs - w * xs],
        [x * zs - w * ys, y * zs + w * xs, 1.0 - (x * xs + y * ys)],
    ];
    let vox = [pix[1], pix[2], pix[3] * pix[0]];
    let off = hdr.qoffset.map(|v| v as f64);
    Ok(std::array::from_fn(|i| {
        [r[i][0] * vox[0], r[i][1] * vox[1], r[i][2] * vox[2], off[i]]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn header(dims: &[i16], pixdim: &[f32], sform: Option<[[f32; 4]; 3]>) -> Vec<u8> {
        let mut b = vec![0u8; 352];
        b[0..4].copy_from_slice(&348i32.to_le_bytes());
        let mut dim = [1i16; 8];
        dim[0] = dims.len() as i16;
        dim[1..=dims.len()].copy_from_slice(dims);
        for (i, d) in dim.iter().enumerate() {
            b[40 + 2 * i..42 + 2 * i].copy_from_slice(&d.to_le_bytes());
        }
        b[70..72].copy_from_slice(&16i16.to_le_bytes());
        for (i, p) in pixdim.iter().enumerate() {
            b[80 + 4 * i..84 + 4 * i].copy_from_slice(&p.to_le_bytes());
        }
        if let Some(s) = sform {
            b[254..256].copy_from_slice(&1i16.to_le_bytes());
            for (k, v) in s.iter().flatten().enumerate() {
                b[280 + 4 * k..284 + 4 * k].copy_from_slice(&v.to_le_bytes());
            }
        }
        b[344..348].copy_from_slice(b"n+1\0");
        b
    }

    #[test]
    fn affine_policy_and_validation() {
        let h = parse(&header(&[64, 64, 30, 10], &[2.0, 2.0, 3.0, 1.5], None)).unwrap();
        assert_eq!(h.shape, [64, 64, 30, 10]);
        assert_eq!(h.zooms, [2.0, 2.0, 3.0, 1.5]);
        assert_eq!(h.affine[0], [-2.0, 0.0, 0.0, 63.0]); // base affine (no sform/qform)
        let s = [
            [1.0, 0.0, 0.0, -90.0],
            [0.0, 1.0, 0.0, -126.0],
            [0.0, 0.0, 1.0, -72.0],
        ];
        assert_eq!(
            parse(&header(&[10, 10, 10], &[1.0; 3], Some(s)))
                .unwrap()
                .affine[1][3],
            -126.0
        );
        let mut bad = header(&[10, 10, 10], &[1.0; 3], None);
        bad[344..348].copy_from_slice(b"ni1\0");
        assert!(parse(&bad).err().unwrap().contains("single-file"));
        assert!(parse(&header(&[0, 10], &[1.0; 2], None)).is_err());
        assert!(parse(&bad[..100]).is_err());
    }
}
