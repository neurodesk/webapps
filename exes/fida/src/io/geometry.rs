//! Where the spectroscopy voxel sits: its position, size and orientation in
//! the scanner's patient coordinates, read from the vendor header.
//!
//! Not part of FID-A, which keeps no geometry. The conventions are those of
//! spec2nii (W. Clarke), which writes the NIfTI-MRS affine for every format,
//! and agree with Osprey's and Gannet's voxel masks:
//!
//! * The voxel is a NIfTI-style 4x4 affine for a 1x1x1 image, mapping index
//!   coordinates to RAS+ world millimetres (NIfTI-MRS's sform). Index
//!   (0, 0, 0) is the voxel centre and the box spans -0.5..0.5 along each
//!   index axis, so the three columns are the box edges, their lengths the
//!   voxel size.
//! * Siemens (twix, DICOM, RDA) positions are in DICOM LPS; the readout,
//!   phase and slice directions come from the slice normal and in-plane
//!   rotation through Siemens' `fGSLCalcPRS` (spec2nii's `calc_prs`), with
//!   the readout FOV along the row (readout) direction.
//! * Philips SPAR angles and offsets are LR/AP/CC in LPH (= LPS): the box is
//!   rotated by Rx(lr) Ry(ap) Rz(cc) (intrinsic XYZ) about its centre, as in
//!   Osprey's `coreg_sdat` and spec2nii's `_philips_orientation`.
//!
//! LPS becomes RAS by negating x and y. A sign flip of one column describes
//! the same box, so only the centre and the three edge vectors matter.

use super::common::{maybe_gunzip, parse_number, Bytes};
use super::twix::TwixHeader;
use serde_json::{json, Value};

/// The MRS voxel: affine from 1x1x1 index space to RAS+ mm, row-major.
#[derive(Clone, Debug, PartialEq)]
pub struct Voxel {
    pub affine: [[f64; 4]; 4],
    /// Which header fields the geometry came from.
    pub source: &'static str,
}

impl Voxel {
    /// Edge lengths in mm (the affine's column norms).
    pub fn size_mm(&self) -> [f64; 3] {
        let a = &self.affine;
        let n = |c: usize| (a[0][c] * a[0][c] + a[1][c] * a[1][c] + a[2][c] * a[2][c]).sqrt();
        [n(0), n(1), n(2)]
    }

    pub fn center_mm(&self) -> [f64; 3] {
        [self.affine[0][3], self.affine[1][3], self.affine[2][3]]
    }

    pub fn to_json(&self) -> Value {
        json!({
            "affine": self.affine,
            "sizeMm": self.size_mm(),
            "centerMm": self.center_mm(),
            "space": "RAS",
            "source": self.source,
        })
    }

    /// Edges (columns, unit vectors times size) and centre, all already RAS.
    fn from_columns(cols: [[f64; 3]; 3], center: [f64; 3], source: &'static str) -> Voxel {
        let mut a = [[0.0; 4]; 4];
        for r in 0..3 {
            for c in 0..3 {
                a[r][c] = cols[c][r];
            }
            a[r][3] = center[r];
        }
        a[3][3] = 1.0;
        Voxel { affine: a, source }
    }

    fn valid(self) -> Option<Voxel> {
        let s = self.size_mm();
        let finite = self.affine.iter().flatten().all(|v| v.is_finite());
        (finite && s.iter().all(|&v| v > 0.0 && v < 1000.0)).then_some(self)
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    if n == 0.0 {
        a
    } else {
        scale(a, 1.0 / n)
    }
}

fn lps_to_ras(a: [f64; 3]) -> [f64; 3] {
    [-a[0], -a[1], a[2]]
}

fn det3(c: [[f64; 3]; 3]) -> f64 {
    let [a, b, d] = c;
    a[0] * (b[1] * d[2] - b[2] * d[1]) - b[0] * (a[1] * d[2] - a[2] * d[1]) + d[0] * (a[1] * b[2] - a[2] * b[1])
}

/// numpy `isclose` with its default tolerances.
fn isclose(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-8 + 1e-5 * b.abs()
}

/// Siemens `fGSLClassOri`: 0 sagittal, 1 coronal, 2 transverse.
fn class_ori(sag: f64, cor: f64, tra: f64) -> usize {
    let (s, c, t) = (sag.abs(), cor.abs(), tra.abs());
    let (sc, st, ct) = (isclose(s, c), isclose(s, t), isclose(c, t));
    if (sc && st) || (sc && s < t) || (st && s > c) || (ct && c > s) || (s > c && s < t) || (s < c && c < t) || (s < t && t > c) || (c < t && t > s) {
        2
    } else if (sc && s > t) || (st && s < c) || (s < c && c > t) || (s > t && s < c) || (s < t && t < c) {
        1
    } else {
        0
    }
}

/// Siemens `fGSLCalcPRS`: phase and readout directions (LPS) for a slice
/// normal `gs` and an in-plane rotation `phi` (radians).
fn calc_prs(gs: [f64; 3], phi: f64) -> ([f64; 3], [f64; 3]) {
    let mut gp = match class_ori(gs[0], gs[1], gs[2]) {
        2 => {
            let k = (1.0 / (gs[1] * gs[1] + gs[2] * gs[2])).sqrt();
            [0.0, gs[2] * k, -gs[1] * k]
        }
        1 => {
            let k = (1.0 / (gs[0] * gs[0] + gs[1] * gs[1])).sqrt();
            [gs[1] * k, -gs[0] * k, 0.0]
        }
        _ => {
            let k = (1.0 / (gs[0] * gs[0] + gs[1] * gs[1])).sqrt();
            [-gs[1] * k, gs[0] * k, 0.0]
        }
    };
    let gr = cross(gs, gp);
    let (c, s) = (phi.cos(), phi.sin());
    gp = [c * gp[0] - s * gr[0], c * gp[1] - s * gr[1], c * gp[2] - s * gr[2]];
    (gp, cross(gs, gp))
}

/// A Siemens VOI from its protocol fields (`sSpecPara.sVoI.*`, LPS mm).
/// Siemens omits zero-valued fields from the protocol, so absent ones are 0.
pub fn siemens_voi(get: impl Fn(&str) -> Option<f64>, source: &'static str) -> Option<Voxel> {
    let v = |k: &str| get(&format!("sSpecPara.sVoI.{k}"));
    let ro = v("dReadoutFOV")?;
    let pe = v("dPhaseFOV")?;
    let thk = v("dThickness")?;
    let mut normal = [v("sNormal.dSag").unwrap_or(0.0), v("sNormal.dCor").unwrap_or(0.0), v("sNormal.dTra").unwrap_or(0.0)];
    if normal == [0.0; 3] {
        normal[0] = 1.0;
    }
    let mut pos = [
        v("sPosition.dSag").unwrap_or(0.0),
        v("sPosition.dCor").unwrap_or(0.0),
        v("sPosition.dTra").unwrap_or(0.0),
    ];
    // Table position (spec2nii adds lScanRegionPos*).
    for (k, axis) in ["Sag", "Cor", "Tra"].iter().enumerate() {
        pos[k] += get(&format!("lScanRegionPos{axis}")).unwrap_or(0.0);
    }
    let (gp, gr) = calc_prs(normal, v("dInPlaneRot").unwrap_or(0.0));
    Some(prs_voxel(gr, gp, pos, [ro, pe, thk], source)).and_then(Voxel::valid)
}

/// DICOM-style row (readout) and column (phase) directions in LPS, sizes
/// along row, column and slice: the box as spec2nii's `nifti_dicom2mat`
/// builds it, then LPS to RAS.
fn prs_voxel(row: [f64; 3], col: [f64; 3], pos_lps: [f64; 3], size: [f64; 3], source: &'static str) -> Voxel {
    let r = unit(row);
    let c = unit(col);
    let mut n = cross(r, c);
    if det3([r, c, n]) < 0.0 {
        n = scale(n, -1.0);
    }
    let cols = [lps_to_ras(scale(r, size[0])), lps_to_ras(scale(c, size[1])), lps_to_ras(scale(n, size[2]))];
    Voxel::from_columns(cols, lps_to_ras(pos_lps), source)
}

/// Siemens twix: the VOI of the MeasYaps protocol.
pub fn twix(hdr: &TwixHeader) -> Option<Voxel> {
    siemens_voi(|k| hdr.get("MeasYaps", k).and_then(|v| v.num()), "Siemens twix MeasYaps sSpecPara.sVoI")
}

/// Siemens spectroscopy DICOM: the VOI of the embedded Phoenix protocol.
pub fn siemens_dicom(protocol: &str) -> Option<Voxel> {
    let get = |k: &str| -> Option<f64> {
        // `key = value` lines; the key must match whole (sPosition.dSag, not ...dSagX).
        protocol.lines().find_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name.trim() == k).then(|| parse_number(value.trim())).flatten()
        })
    };
    siemens_voi(get, "Siemens DICOM Phoenix protocol sSpecPara.sVoI")
}

/// Siemens .rda: VOIPosition (LPS), RowVector / ColumnVector, VOIReadoutFOV
/// (along the row), VOIPhaseFOV (along the column) and VOIThickness.
pub fn rda(data: &[u8]) -> Option<Voxel> {
    let marker = b">>> End of header <<<";
    let end = data.windows(marker.len()).position(|w| w == marker)?;
    let text: String = data[..end].iter().map(|&c| c as char).collect();
    let get = |k: &str| -> Option<f64> {
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == k).then(|| parse_number(value.trim())).flatten()
        })
    };
    let vec3 = |k: &str| -> Option<[f64; 3]> { Some([get(&format!("{k}[0]"))?, get(&format!("{k}[1]"))?, get(&format!("{k}[2]"))?]) };
    let pos = [get("VOIPositionSag")?, get("VOIPositionCor")?, get("VOIPositionTra")?];
    let size = [get("VOIReadoutFOV")?, get("VOIPhaseFOV")?, get("VOIThickness")?];
    prs_voxel(vec3("RowVector")?, vec3("ColumnVector")?, pos, size, "Siemens RDA VOIPosition, RowVector, ColumnVector").valid()
}

/// Philips SPAR: `lr/ap/cc_size`, `_off_center` and `_angulation`.
pub fn spar(text: &str) -> Option<Voxel> {
    let get = |k: &str| -> Option<f64> {
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == k).then(|| parse_number(value.trim())).flatten()
        })
    };
    let size = [get("lr_size")?, get("ap_size")?, get("cc_size")?];
    let off = [get("lr_off_center")?, get("ap_off_center")?, get("cc_off_center")?];
    let ang = [get("lr_angulation")?, get("ap_angulation")?, get("cc_angulation")?];
    // In RAS the LPS rotation Rx(lr) Ry(ap) Rz(cc) is Rx(-lr) Ry(-ap) Rz(cc),
    // as spec2nii writes it (calc_affine, intrinsic 'XYZ').
    let (sx, cx) = (-ang[0]).to_radians().sin_cos();
    let (sy, cy) = (-ang[1]).to_radians().sin_cos();
    let (sz, cz) = ang[2].to_radians().sin_cos();
    let rx = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]];
    let ry = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
    let rz = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]];
    let r = matmul(matmul(rx, ry), rz);
    // Columns of R scaled by the LR, AP and CC sizes.
    let col = |c: usize| scale([r[0][c], r[1][c], r[2][c]], size[c]);
    Voxel::from_columns([col(0), col(1), col(2)], lps_to_ras(off), "Philips SPAR off_center, angulation, size").valid()
}

fn matmul(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut m = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    m
}

/// NIfTI-MRS: the file's own sform (or qform), already in this convention.
pub fn nifti(data: &[u8]) -> Option<Voxel> {
    let raw = maybe_gunzip(data).ok()?;
    let b = Bytes::new(&raw, "NIfTI-MRS");
    let le = b.i32le(0).ok()?;
    let big = le != 348 && le != 540;
    let v2 = le == 540 || i32::from_be_bytes(le.to_le_bytes()) == 540;
    let rd = |off: usize, n: usize| -> Option<Vec<u8>> {
        let mut v = b.slice(off, n).ok()?.to_vec();
        if big {
            v.reverse();
        }
        Some(v)
    };
    let i16_ = |off| rd(off, 2).map(|v| i16::from_le_bytes([v[0], v[1]]));
    let f32_ = |off| rd(off, 4).map(|v| f32::from_le_bytes([v[0], v[1], v[2], v[3]]) as f64);
    let f64_ = |off| rd(off, 8).map(|v| f64::from_le_bytes(v.try_into().unwrap()));
    let (qcode, scode, q, srow, pix0): (i16, i16, [usize; 6], usize, usize);
    if v2 {
        let i32_ = |off| rd(off, 4).map(|v| i32::from_le_bytes([v[0], v[1], v[2], v[3]]));
        qcode = i32_(344)?.clamp(-1, 255) as i16;
        scode = i32_(348)?.clamp(-1, 255) as i16;
        q = [352, 360, 368, 376, 384, 392];
        srow = 400;
        pix0 = 104;
    } else {
        qcode = i16_(252)?;
        scode = i16_(254)?;
        q = [256, 260, 264, 268, 272, 276];
        srow = 280;
        pix0 = 76;
    }
    let real = |off: usize| if v2 { f64_(off) } else { f32_(off) };
    let width = if v2 { 8 } else { 4 };
    let mut a = [[0.0; 4]; 4];
    a[3][3] = 1.0;
    if scode > 0 {
        for (r, row) in a.iter_mut().take(3).enumerate() {
            for (c, v) in row.iter_mut().enumerate() {
                *v = real(srow + width * (4 * r + c))?;
            }
        }
        return Voxel { affine: a, source: "NIfTI-MRS sform" }.valid();
    }
    if qcode <= 0 {
        return None;
    }
    // NIfTI qform: quaternion (b, c, d), offsets, pixdim and qfac (pixdim[0]).
    let (qb, qc, qd) = (real(q[0])?, real(q[1])?, real(q[2])?);
    let qa = (1.0 - (qb * qb + qc * qc + qd * qd)).max(0.0).sqrt();
    let qfac = if real(pix0)? < 0.0 { -1.0 } else { 1.0 };
    let pix = [real(pix0 + width)?, real(pix0 + 2 * width)?, real(pix0 + 3 * width)? * qfac];
    let r = [
        [qa * qa + qb * qb - qc * qc - qd * qd, 2.0 * (qb * qc - qa * qd), 2.0 * (qb * qd + qa * qc)],
        [2.0 * (qb * qc + qa * qd), qa * qa + qc * qc - qb * qb - qd * qd, 2.0 * (qc * qd - qa * qb)],
        [2.0 * (qb * qd - qa * qc), 2.0 * (qc * qd + qa * qb), qa * qa + qd * qd - qc * qc - qb * qb],
    ];
    for i in 0..3 {
        for j in 0..3 {
            a[i][j] = r[i][j] * pix[j];
        }
        a[i][3] = real(q[3 + i])?;
    }
    Voxel { affine: a, source: "NIfTI-MRS qform" }.valid()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(v: &Voxel, want: [[f64; 4]; 3], tol: f64) {
        for r in 0..3 {
            for c in 0..4 {
                assert!((v.affine[r][c] - want[r][c]).abs() < tol, "row {r} col {c}: {:?} vs {want:?}", v.affine);
            }
        }
    }

    fn protocol(fields: &[(&str, f64)]) -> String {
        fields.iter().map(|(k, v)| format!("sSpecPara.sVoI.{k}\t = {v}\n")).collect()
    }

    // Expected affines below are spec2nii 0.8.15's own (GSL.calc_prs +
    // dcm_to_nifti_orientation for Siemens, _philips_orientation for
    // Philips) on the same header values.

    #[test]
    fn siemens_oblique_matches_spec2nii() {
        let p = protocol(&[
            ("sNormal.dSag", 0.2),
            ("sNormal.dCor", -0.3),
            ("sNormal.dTra", 0.9327379053),
            ("dInPlaneRot", 0.4),
            ("sPosition.dSag", -12.5),
            ("sPosition.dCor", 30.25),
            ("sPosition.dTra", 18.0),
            ("dReadoutFOV", 25.0),
            ("dPhaseFOV", 20.0),
            ("dThickness", 15.0),
        ]);
        let v = siemens_dicom(&p).unwrap();
        close(
            &v,
            [
                [22.5612945729, -7.631009881, 3.0, 12.5],
                [-7.8577995212, -18.013416985, -4.5, -30.25],
                [7.3649829517, 4.1574627741, -13.9910685796, 18.0],
            ],
            1e-8,
        );
        let s = v.size_mm();
        assert!((s[0] - 25.0).abs() < 1e-9 && (s[1] - 20.0).abs() < 1e-9 && (s[2] - 15.0).abs() < 1e-9);
    }

    #[test]
    fn siemens_sagittal_and_coronal_match_spec2nii() {
        let sag = protocol(&[
            ("sNormal.dSag", 0.95),
            ("sNormal.dCor", 0.1),
            ("sNormal.dTra", -0.2958039892),
            ("dInPlaneRot", -1.1),
            ("sPosition.dSag", 3.0),
            ("sPosition.dCor", -4.0),
            ("sPosition.dTra", 5.0),
            ("dReadoutFOV", 18.0),
            ("dPhaseFOV", 22.0),
            ("dThickness", 12.0),
        ]);
        close(
            &siemens_dicom(&sag).unwrap(),
            [
                [-4.0812148587, -4.7231710413, 11.3999999998, -3.0],
                [15.7007599478, -10.5314242201, 1.2, 4.0],
                [7.7993475585, 18.7291419774, 3.5496478704, 5.0],
            ],
            1e-8,
        );
        // dInPlaneRot = 0 is omitted from the protocol, as Siemens writes it.
        let cor = protocol(&[
            ("sNormal.dSag", 0.1),
            ("sNormal.dCor", 0.98),
            ("sNormal.dTra", 0.1720465053),
            ("sPosition.dSag", 1.0),
            ("sPosition.dCor", 2.0),
            ("sPosition.dTra", 3.0),
            ("dReadoutFOV", 30.0),
            ("dPhaseFOV", 20.0),
            ("dThickness", 10.0),
        ]);
        close(
            &siemens_dicom(&cor).unwrap(),
            [
                [-0.5239522579, -19.8966828506, 1.0, -1.0],
                [-5.1347321273, 2.0302737603, 9.8000000001, -2.0],
                [-29.5526648547, 0.0, -1.720465053, 3.0],
            ],
            1e-8,
        );
    }

    #[test]
    fn philips_oblique_matches_spec2nii() {
        let spar_text = "lr_angulation : -4.5\r\nap_angulation : 12\r\ncc_angulation : 7.25\r\nlr_size : 20\r\nap_size : 30\r\ncc_size : 25\r\n\
                         lr_off_center : -6.5\r\nap_off_center : 30.25\r\ncc_off_center : 33.75\r\n";
        let v = spar(spar_text).unwrap();
        close(
            &v,
            [
                [19.4065452289, -3.7032365663, -5.1977922704, 6.5],
                [2.1925559268, 29.7301667445, -1.918614406, -30.25],
                [4.3103017048, 1.5502336199, 24.378307453, 33.75],
            ],
            1e-8,
        );
    }

    #[test]
    fn philips_osprey_press_example_matches_spec2nii() {
        // Osprey's exampledata/sdat/UnEdited/sub-01 PRESS voxel: 30 mm cube,
        // spec2nii's NIfTI-MRS sform for the same SPAR.
        let spar_text = "ap_size : 30\nlr_size : 30\ncc_size : 30\nap_off_center : 45.03344727\nlr_off_center : 0\n\
                         cc_off_center : 37.66220856\nap_angulation : 0\nlr_angulation : -4.347770214\ncc_angulation : 0\n";
        close(
            &spar(spar_text).unwrap(),
            [[30.0, 0.0, 0.0, 0.0], [0.0, 29.913668, -2.274303, -45.033447], [0.0, 2.274303, 29.913668, 37.662209]],
            1e-5,
        );
    }

    #[test]
    fn rda_uses_row_and_column_vectors() {
        // Transverse voxel, readout along LPS x, phase along LPS y.
        let text = b">>> Begin of header <<<\r\nVOIPositionSag: 10\r\nVOIPositionCor: -20\r\nVOIPositionTra: 30\r\n\
VOIThickness: 15\r\nVOIPhaseFOV: 20\r\nVOIReadoutFOV: 25\r\nRowVector[0]: 1\r\nRowVector[1]: 0\r\nRowVector[2]: 0\r\n\
ColumnVector[0]: 0\r\nColumnVector[1]: 1\r\nColumnVector[2]: 0\r\n>>> End of header <<<\r\n";
        let v = rda(text).unwrap();
        close(&v, [[-25.0, 0.0, 0.0, -10.0], [0.0, -20.0, 0.0, 20.0], [0.0, 0.0, 15.0, 30.0]], 1e-12);
        assert!(rda(b">>> Begin of header <<<\r\n>>> End of header <<<\r\n").is_none());
    }

    #[test]
    fn missing_fields_give_no_voxel() {
        assert!(spar("lr_size : 20\n").is_none());
        assert!(siemens_dicom("").is_none());
        assert!(nifti(b"not a nifti").is_none());
    }

    #[test]
    fn nifti_sform_and_qform() {
        let mut h = vec![0u8; 352];
        h[0..4].copy_from_slice(&348i32.to_le_bytes());
        h[344..348].copy_from_slice(b"n+1\0");
        // qform only: 90 degrees about z (b = c = 0, d = sin 45), pixdim 20, 10, 5.
        h[252..254].copy_from_slice(&1i16.to_le_bytes());
        let d = std::f32::consts::FRAC_1_SQRT_2;
        h[264..268].copy_from_slice(&d.to_le_bytes());
        for (k, v) in [1.0f32, 20.0, 10.0, 5.0].iter().enumerate() {
            h[76 + 4 * k..80 + 4 * k].copy_from_slice(&v.to_le_bytes());
        }
        for (k, v) in [1.5f32, -2.5, 3.5].iter().enumerate() {
            h[268 + 4 * k..272 + 4 * k].copy_from_slice(&v.to_le_bytes());
        }
        let v = nifti(&h).unwrap();
        close(&v, [[0.0, -10.0, 0.0, 1.5], [20.0, 0.0, 0.0, -2.5], [0.0, 0.0, 5.0, 3.5]], 1e-5);
        assert_eq!(v.source, "NIfTI-MRS qform");
        // An sform wins.
        h[254..256].copy_from_slice(&2i16.to_le_bytes());
        let srow = [[20.0f32, 0.0, 0.0, -32.9], [0.0, -20.0, 0.0, 10.6], [0.0, 0.0, -20.0, 21.3]];
        for (r, row) in srow.iter().enumerate() {
            for (c, x) in row.iter().enumerate() {
                h[280 + 16 * r + 4 * c..284 + 16 * r + 4 * c].copy_from_slice(&x.to_le_bytes());
            }
        }
        let v = nifti(&h).unwrap();
        assert_eq!(v.source, "NIfTI-MRS sform");
        close(&v, srow.map(|r| r.map(f64::from)), 1e-5);
    }
}
