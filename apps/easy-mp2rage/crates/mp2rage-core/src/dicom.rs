//! Minimal DICOM reader for uncompressed Siemens MP2RAGE/SA2RAGE series
//! (Explicit or Implicit VR Little Endian, single-frame). Pure Rust, std-only,
//! so it compiles to WASM. Compressed transfer syntaxes are rejected (route via
//! dcm2niix). Also parses the Siemens CSA/ASCCONV protocol for sequence params.

use std::collections::HashMap;

fn u16le(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn u32le(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

/// One parsed DICOM instance (the fields we need).
#[derive(Default, Clone)]
pub struct DicomFile {
    pub rows: usize,
    pub cols: usize,
    pub bits: u16,
    pub pixel_rep: u16,
    pub pixels: Vec<f64>, // rows*cols, rescaled
    pub ipp: [f64; 3],
    pub iop: [f64; 6],
    pub pixel_spacing: [f64; 2], // [row, col]
    pub slice_thickness: f64,
    pub instance: i32,
    pub echo: i32,
    pub acquisition: i32,
    pub series_number: i32,
    pub series_uid: String,
    pub series_desc: String,
    pub image_type: Vec<String>,
    pub scanning_seq: String,
    pub inversion_time: f64, // ms
    pub flip_angle: f64,
    pub repetition_time: f64, // ms
    pub field_strength: f64,
    pub ascconv: HashMap<String, String>,
}

const VR_LONG: [&[u8; 2]; 8] = [b"OB", b"OW", b"OF", b"SQ", b"UT", b"UN", b"UC", b"UR"];

fn ascii(b: &[u8]) -> String {
    String::from_utf8_lossy(b).trim_matches(|c: char| c == '\0' || c == ' ').to_string()
}
fn ds(b: &[u8]) -> f64 { ascii(b).parse().unwrap_or(0.0) }
fn ds_multi(b: &[u8]) -> Vec<f64> { ascii(b).split('\\').filter_map(|s| s.trim().parse().ok()).collect() }

/// Parse the Siemens CSA header text for the ASCCONV protocol (key=value).
fn parse_ascconv(raw: &[u8]) -> HashMap<String, String> {
    let txt = String::from_utf8_lossy(raw);
    let mut out = HashMap::new();
    if let Some(start) = txt.find("ASCCONV BEGIN") {
        let end = txt[start..].find("ASCCONV END").map(|e| start + e).unwrap_or(txt.len());
        for line in txt[start..end].lines() {
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim();
                if !k.is_empty() && !k.starts_with('#') {
                    out.insert(k.to_string(), v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    out
}

/// Parse one DICOM file's bytes.
pub fn parse(bytes: &[u8]) -> Result<DicomFile, String> {
    let mut pos = 0usize;
    // preamble + "DICM"
    if bytes.len() > 132 && &bytes[128..132] == b"DICM" {
        pos = 132;
    }
    // file-meta group (0002) is always Explicit VR LE; read TransferSyntaxUID
    let mut implicit = false;
    let mut df = DicomFile { pixel_spacing: [1.0, 1.0], slice_thickness: 1.0, ..Default::default() };
    let mut csa = Vec::<u8>::new();

    // helper to read one element header at `pos` for a given VR mode
    let read_elem = |b: &[u8], pos: &mut usize, implicit: bool| -> Option<(u16, u16, [u8; 2], usize)> {
        if *pos + 8 > b.len() { return None; }
        let group = u16le(b, *pos);
        let elem = u16le(b, *pos + 2);
        *pos += 4;
        if implicit && group != 0x0002 {
            let len = u32le(b, *pos) as usize; *pos += 4;
            Some((group, elem, *b"UN", len))
        } else {
            let vr = [b[*pos], b[*pos + 1]]; *pos += 2;
            let len = if VR_LONG.iter().any(|v| *v == &vr) {
                *pos += 2; // reserved
                if *pos + 4 > b.len() { return None; } // 4-byte length must fit
                let l = u32le(b, *pos) as usize; *pos += 4; l
            } else {
                let l = u16le(b, *pos) as usize; *pos += 2; l
            };
            Some((group, elem, vr, len))
        }
    };

    // first pass through file-meta (0002) explicit VR
    while pos < bytes.len() {
        let save = pos;
        let (g, e, vr, len) = match read_elem(bytes, &mut pos, false) { Some(x) => x, None => break };
        if g != 0x0002 { pos = save; break; } // meta group done
        if len == 0xFFFF_FFFF { return Err("undefined-length in meta".into()); }
        // subtract, do not add: `pos + len` wraps on wasm32 (32-bit usize) for a
        // hostile length near u32::MAX and would bypass this guard.
        if len > bytes.len().saturating_sub(pos) { return Err("truncated DICOM meta element".into()); }
        if g == 0x0002 && e == 0x0010 {
            let uid = ascii(&bytes[pos..pos + len]);
            if uid == "1.2.840.10008.1.2" { implicit = true; }
            else if uid != "1.2.840.10008.1.2.1" && uid != "1.2.840.10008.1.2.2" {
                return Err(format!("unsupported/compressed transfer syntax {uid}"));
            }
        }
        let _ = vr;
        pos += len;
    }

    // main dataset
    while pos < bytes.len() {
        let (g, e, vr, len) = match read_elem(bytes, &mut pos, implicit) { Some(x) => x, None => break };
        // skip sequences (defined or undefined length)
        if &vr == b"SQ" || len == 0xFFFF_FFFF {
            if len == 0xFFFF_FFFF {
                // walk to sequence delimiter (FFFE,E0DD)
                while pos + 8 <= bytes.len() {
                    let tg = u16le(bytes, pos); let te = u16le(bytes, pos + 2);
                    let il = u32le(bytes, pos + 4) as usize; pos += 8;
                    if tg == 0xFFFE && te == 0xE0DD { break; }
                    if il != 0xFFFF_FFFF { pos = pos.saturating_add(il); if pos > bytes.len() { break; } }
                }
            } else { pos += len; }
            continue;
        }
        if len > bytes.len().saturating_sub(pos) { break; } // subtract: pos+len wraps on wasm32
        let v = &bytes[pos..pos + len];
        match (g, e) {
            (0x0008, 0x0008) => df.image_type = ascii(v).split('\\').map(|s| s.trim().to_string()).collect(),
            (0x0008, 0x103E) => df.series_desc = ascii(v),
            (0x0018, 0x0020) => df.scanning_seq = ascii(v),
            (0x0018, 0x0050) => df.slice_thickness = ds(v),
            (0x0018, 0x0080) => df.repetition_time = ds(v),
            (0x0018, 0x0082) => df.inversion_time = ds(v),
            (0x0018, 0x0086) => df.echo = ascii(v).parse().unwrap_or(0),
            (0x0018, 0x0087) => df.field_strength = ds(v),
            (0x0018, 0x1314) => df.flip_angle = ds(v),
            (0x0020, 0x000E) => df.series_uid = ascii(v),
            (0x0020, 0x0011) => df.series_number = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0012) => df.acquisition = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0013) => df.instance = ascii(v).parse().unwrap_or(0),
            (0x0020, 0x0032) => { let a = ds_multi(v); if a.len() == 3 { df.ipp = [a[0], a[1], a[2]]; } }
            (0x0020, 0x0037) => { let a = ds_multi(v); if a.len() == 6 { df.iop.copy_from_slice(&a); } }
            (0x0028, 0x0010) => { if v.len() >= 2 { df.rows = u16le(v, 0) as usize; } }
            (0x0028, 0x0011) => { if v.len() >= 2 { df.cols = u16le(v, 0) as usize; } }
            (0x0028, 0x0030) => { let a = ds_multi(v); if a.len() == 2 { df.pixel_spacing = [a[0], a[1]]; } }
            (0x0028, 0x0100) => { if v.len() >= 2 { df.bits = u16le(v, 0); } }
            (0x0028, 0x0103) => { if v.len() >= 2 { df.pixel_rep = u16le(v, 0); } }
            (0x0029, 0x1010) | (0x0029, 0x1020) => csa.extend_from_slice(v),
            (0x7FE0, 0x0010) => {
                let n = df.rows.saturating_mul(df.cols);
                let need = if df.bits == 16 { n.saturating_mul(2) } else { n };
                if v.len() < need { return Err("truncated or inconsistent pixel data".into()); }
                let mut px = Vec::with_capacity(n);
                if df.bits == 16 {
                    for i in 0..n {
                        let raw = u16le(v, 2 * i);
                        px.push(if df.pixel_rep == 1 { raw as i16 as f64 } else { raw as f64 });
                    }
                } else {
                    for i in 0..n { px.push(v[i] as f64); }
                }
                df.pixels = px;
                pos += len;
                break; // pixel data is last
            }
            _ => {}
        }
        pos += len;
    }
    if df.pixels.is_empty() { return Err("no pixel data".into()); }
    df.ascconv = parse_ascconv(&csa);
    Ok(df)
}

/// Extract MP2RAGE sequence params from the ASCCONV protocol, in the units the
/// UI form expects: `[TR_s, TI1_s, TI2_s, FA1_deg, FA2_deg, NZ1, NZ2]`.
/// Returns None if the key fields aren't present (e.g. a non-MP2RAGE series).
pub fn mp2rage_params(f: &DicomFile) -> Option<Vec<f64>> {
    let a = &f.ascconv;
    let g = |k: &str| -> Option<f64> {
        let s = a.get(k)?;
        if let Some(h) = s.strip_prefix("0x") {
            return i64::from_str_radix(h, 16).ok().map(|x| x as f64);
        }
        s.parse::<f64>().ok()
    };
    let tr = g("alTR[0]")? / 1e6;
    let ti1 = g("alTI[0]")? / 1e6;
    let ti2 = g("alTI[1]")? / 1e6;
    let fa1 = g("adFlipAngleDegree[0]")?;
    let fa2 = g("adFlipAngleDegree[1]")?;
    let n_sl = g("sKSpace.lImagesPerSlab").or_else(|| g("sKSpace.lPartitions"))?;
    let pf = match g("sKSpace.ucSlicePartialFourier").unwrap_or(16.0) as i64 {
        1 => 0.5, 2 => 0.625, 4 => 0.75, 8 => 0.875, _ => 1.0,
    };
    let acc = g("sPat.lAccelFact3D").unwrap_or(1.0).max(1.0);
    let nz1 = (n_sl * (pf - 0.5) / acc).round();
    let nz2 = (n_sl * 0.5 / acc).round();
    Some(vec![tr, ti1, ti2, fa1, fa2, nz1, nz2])
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Infer the MP2RAGE role from image type / description (matches dicom_io.classify).
pub fn classify(f: &DicomFile) -> String {
    let itype: Vec<String> = f.image_type.iter().map(|s| s.to_uppercase()).collect();
    let desc = format!("{} {}", f.series_desc, f.scanning_seq).to_lowercase();
    if itype.iter().any(|s| s == "FLIP ANGLE MAP") { return "B1 map".into(); }
    if desc.contains("sa2rage") { return "SA2RAGE".into(); }
    if itype.iter().any(|s| s == "UNI") { return "UNI".into(); }
    if f.scanning_seq.contains("IR") && itype.iter().any(|s| s == "M") {
        if desc.contains("inv1") { return "INV1".into(); }
        if desc.contains("inv2") { return "INV2".into(); }
        return "INV2".into();
    }
    "(ignore)".into()
}

/// An assembled DICOM series as a volume (i-fastest flat) + RAS affine.
pub struct Series {
    pub data: Vec<f32>, // len = nx*ny*nz*nt, index i + nx*(j + ny*(k + nz*t))
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    pub nt: usize,
    pub affine: [[f64; 4]; 4],
    pub role: String,
    pub rep: DicomFile,
}

/// Assemble slices (one series) into a volume, sorting by position along the
/// slice normal and separating volumes by echo (SA2RAGE has 2). Builds an RAS
/// affine (LPS negated in x,y, matching nibabel/dcm2niix conventions).
pub fn assemble(files: Vec<DicomFile>) -> Result<Series, String> {
    if files.is_empty() { return Err("empty series".into()); }
    let f0 = &files[0];
    let (nx, ny) = (f0.cols, f0.rows);
    let row = [f0.iop[0], f0.iop[1], f0.iop[2]];
    let col = [f0.iop[3], f0.iop[4], f0.iop[5]];
    let normal = cross(row, col);
    let proj = |f: &DicomFile| f.ipp[0] * normal[0] + f.ipp[1] * normal[1] + f.ipp[2] * normal[2];

    // group by position (rounded projection along the normal)
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<i64, Vec<DicomFile>> = BTreeMap::new();
    for f in files {
        let key = (proj(&f) * 1000.0).round() as i64;
        groups.entry(key).or_default().push(f);
    }
    let nz = groups.len();
    let mut nt = 0usize;
    for g in groups.values() { nt = nt.max(g.len()); }
    let mut data = vec![0f32; nx * ny * nz * nt];
    let rep = groups.values().next().unwrap()[0].clone();
    let mut ipp0 = rep.ipp;
    let mut projs: Vec<f64> = Vec::new();
    for (k, (_, grp)) in groups.iter_mut().enumerate() {
        grp.sort_by(|a, b| a.echo.cmp(&b.echo).then(a.acquisition.cmp(&b.acquisition)).then(a.instance.cmp(&b.instance)));
        if k == 0 { ipp0 = grp[0].ipp; }
        projs.push(grp[0].ipp[0] * normal[0] + grp[0].ipp[1] * normal[1] + grp[0].ipp[2] * normal[2]);
        for (t, f) in grp.iter().enumerate() {
            let base = nx * ny * (k + nz * t);
            for j in 0..ny {
                for i in 0..nx {
                    data[base + i + nx * j] = f.pixels[j * nx + i] as f32;
                }
            }
        }
    }
    let slice_sp = if nz > 1 { (projs[nz - 1] - projs[0]) / (nz as f64 - 1.0) } else { rep.slice_thickness.max(1.0) };
    let cs = rep.pixel_spacing[1]; // column spacing (along row dir / i)
    let rs = rep.pixel_spacing[0]; // row spacing (along col dir / j)
    // LPS affine columns: i->row_cosines*cs, j->col_cosines*rs, k->normal*slice_sp
    let mut a = [
        [row[0] * cs, col[0] * rs, normal[0] * slice_sp, ipp0[0]],
        [row[1] * cs, col[1] * rs, normal[1] * slice_sp, ipp0[1]],
        [row[2] * cs, col[2] * rs, normal[2] * slice_sp, ipp0[2]],
        [0.0, 0.0, 0.0, 1.0],
    ];
    // LPS -> RAS: negate x and y rows
    for c in 0..4 { a[0][c] = -a[0][c]; a[1][c] = -a[1][c]; }
    let role = classify(&rep);
    Ok(Series { data, nx, ny, nz, nt, affine: a, role, rep })
}

// ===========================================================================
// Derived-series writer: clone the source MR slices, swap in the T1 pixels and
// a few tags -> a DERIVED\SECONDARY MR Image Storage series any viewer loads.
// Explicit VR Little Endian only (our Siemens case).
// ===========================================================================
struct Elem { group: u16, elem: u16, vr: [u8; 2], data: Vec<u8> }

fn is_long_vr(vr: &[u8; 2]) -> bool { VR_LONG.iter().any(|v| *v == vr) }

/// Parse every top-level element (skipping sequences) of an Explicit-VR-LE file.
fn parse_all(bytes: &[u8]) -> Result<Vec<Elem>, String> {
    let mut pos = if bytes.len() > 132 && &bytes[128..132] == b"DICM" { 132 } else {
        return Err("missing DICM preamble".into());
    };
    let mut out = Vec::new();
    while pos + 8 <= bytes.len() {
        let group = u16le(bytes, pos);
        let elem = u16le(bytes, pos + 2);
        pos += 4;
        let vr = [bytes[pos], bytes[pos + 1]];
        pos += 2;
        // require explicit VR: VR bytes must be uppercase ASCII
        if !(vr[0].is_ascii_uppercase() && vr[1].is_ascii_uppercase()) {
            return Err("DICOM output needs Explicit VR Little Endian source".into());
        }
        let len = if is_long_vr(&vr) {
            pos += 2;
            let l = u32le(bytes, pos) as usize; pos += 4; l
        } else {
            let l = u16le(bytes, pos) as usize; pos += 2; l
        };
        if &vr == b"SQ" || len == 0xFFFF_FFFF {
            // skip sequences (drop from the derived object)
            if len == 0xFFFF_FFFF {
                while pos + 8 <= bytes.len() {
                    let tg = u16le(bytes, pos); let te = u16le(bytes, pos + 2);
                    let il = u32le(bytes, pos + 4) as usize; pos += 8;
                    if tg == 0xFFFE && te == 0xE0DD { break; }
                    if il != 0xFFFF_FFFF { pos = pos.saturating_add(il); if pos > bytes.len() { break; } }
                }
            } else { pos += len; }
            continue;
        }
        if len > bytes.len().saturating_sub(pos) { break; } // subtract: pos+len wraps on wasm32
        out.push(Elem { group, elem, vr, data: bytes[pos..pos + len].to_vec() });
        pos += len;
    }
    Ok(out)
}

fn even(mut d: Vec<u8>, pad: u8) -> Vec<u8> {
    if d.len() % 2 == 1 { d.push(pad); }
    d
}

fn set_elem(elems: &mut Vec<Elem>, group: u16, elem: u16, vr: &[u8; 2], data: Vec<u8>) {
    let data = even(data, if vr == b"UI" || vr == b"OW" || vr == b"OB" { 0 } else { b' ' });
    if let Some(e) = elems.iter_mut().find(|e| e.group == group && e.elem == elem) {
        e.vr = *vr; e.data = data;
    } else {
        elems.push(Elem { group, elem, vr: *vr, data });
    }
}
fn get_elem<'a>(elems: &'a [Elem], group: u16, elem: u16) -> Option<&'a [u8]> {
    elems.iter().find(|e| e.group == group && e.elem == elem).map(|e| e.data.as_slice())
}
/// Strip patient/identifying tags from a single slice's elements in place.
///
/// This is a fail-safe *whitelist*: every element that is not an enumerated
/// technical/geometry/rendering/UID tag, a blanked Type-2 identity tag, an
/// enumerated image-pixel tag (group 0x0028), an enumerated file-meta tag (group
/// 0x0002), or the pixel data (0x7FE0) is dropped. The whitelist is applied even
/// inside groups 0x0002 and 0x0028 (no wholesale group keeps), because both carry
/// identity-bearing members: 0x0002 has PrivateInformation (0002,0102) and its
/// creator UID (0002,0100), and 0x0028 has free-text comments (0028,4000).
/// Anything the source carries that we did not enumerate is removed by omission,
/// so no un-listed source PHI (dates, physicians, patient history, private/CSA
/// text) can survive. The UIDs that would otherwise link the object back to the
/// source study / frame of reference are re-mapped from `salt`. Only then is
/// PatientIdentityRemoved=YES stamped, so the flag is accurate.
fn deidentify_elems(elems: &mut Vec<Elem>, salt: &str) {
    // Type-2 identity tags: DICOM requires them present, but they may be empty.
    // Keep present-but-blank so the object stays conformant for PACS that index
    // on them, while carrying no value.
    let blanks: &[(u16, u16, &[u8; 2])] = &[
        (0x0010, 0x0010, b"PN"), // PatientName
        (0x0010, 0x0020, b"LO"), // PatientID
        (0x0008, 0x0020, b"DA"), // StudyDate
        (0x0008, 0x0030, b"TM"), // StudyTime
        (0x0008, 0x0023, b"DA"), // ContentDate
        (0x0008, 0x0033, b"TM"), // ContentTime
        (0x0008, 0x0050, b"SH"), // AccessionNumber
        (0x0008, 0x0090, b"PN"), // ReferringPhysicianName
        (0x0020, 0x0010, b"SH"), // StudyID
    ];
    // Technical / geometry / rendering / UID tags safe to keep verbatim and
    // needed for a valid, viewable derived MR image.
    const KEEP: &[(u16, u16)] = &[
        (0x0008, 0x0005), // SpecificCharacterSet
        (0x0008, 0x0008), // ImageType
        (0x0008, 0x0016), // SOPClassUID
        (0x0008, 0x0018), // SOPInstanceUID
        (0x0008, 0x0060), // Modality
        (0x0008, 0x0064), // ConversionType
        (0x0008, 0x0070), // Manufacturer (vendor, not patient identity)
        (0x0008, 0x103E), // SeriesDescription (overwritten by caller)
        (0x0008, 0x1090), // ManufacturerModelName
        (0x0018, 0x0020), // ScanningSequence
        (0x0018, 0x0021), // SequenceVariant
        (0x0018, 0x0023), // MRAcquisitionType
        (0x0018, 0x0050), // SliceThickness
        (0x0018, 0x0080), // RepetitionTime
        (0x0018, 0x0081), // EchoTime
        (0x0018, 0x0088), // SpacingBetweenSlices
        (0x0018, 0x1314), // FlipAngle
        (0x0018, 0x5100), // PatientPosition (orientation, not identity)
        (0x0020, 0x000D), // StudyInstanceUID (re-mapped below)
        (0x0020, 0x000E), // SeriesInstanceUID (overwritten by caller)
        (0x0020, 0x0011), // SeriesNumber
        (0x0020, 0x0012), // AcquisitionNumber
        (0x0020, 0x0013), // InstanceNumber
        (0x0020, 0x0032), // ImagePositionPatient
        (0x0020, 0x0037), // ImageOrientationPatient
        (0x0020, 0x0052), // FrameOfReferenceUID (re-mapped below)
        (0x0020, 0x1041), // SliceLocation
        (0x0012, 0x0062), // PatientIdentityRemoved (stamped below)
        (0x0012, 0x0063), // DeidentificationMethod (stamped below)
    ];
    // File-meta (0x0002) safe members. NOT kept wholesale: 0002,0100/0102 carry a
    // private-information blob and its creator UID, and 0002,0016/0017 the AE title.
    const KEEP_META: &[u16] = &[0x0000, 0x0001, 0x0002, 0x0003, 0x0010, 0x0012, 0x0013];
    // Image-pixel (0x0028) technical members. NOT kept wholesale: 0028,4000
    // (Image Presentation Comments) is operator free text; 0028,0301
    // (BurnedInAnnotation) is set explicitly below rather than inherited.
    const KEEP_28: &[u16] = &[
        0x0002, 0x0004, 0x0006, 0x0010, 0x0011, 0x0030,
        0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107,
        0x1050, 0x1051, 0x1052, 0x1053, 0x1054,
    ];
    elems.retain(|e| {
        e.group == 0x7FE0
            || (e.group == 0x0028 && KEEP_28.contains(&e.elem))
            || (e.group == 0x0002 && KEEP_META.contains(&e.elem))
            || KEEP.contains(&(e.group, e.elem))
            || blanks.iter().any(|&(g, el, _)| g == e.group && el == e.elem)
    });
    for &(g, e, vr) in blanks {
        set_elem(elems, g, e, vr, Vec::new());
    }
    // The derived pixel data is a freshly computed map with no burned-in text, so
    // assert BurnedInAnnotation=NO rather than inheriting the source flag.
    set_elem(elems, 0x0028, 0x0301, b"CS", b"NO".to_vec());
    // Re-map the UIDs that would otherwise link this object back to the source
    // study / frame of reference (a re-identification vector). The two-component
    // ".900.1"/".900.2" tails cannot collide with the single-component per-slice
    // SOP / series UID tails, whatever the slice count.
    set_elem(elems, 0x0020, 0x000D, b"UI", format!("1.2.826.0.1.3680043.2.1125.{salt}.900.1").into_bytes());
    if get_elem(elems, 0x0020, 0x0052).is_some() {
        set_elem(elems, 0x0020, 0x0052, b"UI", format!("1.2.826.0.1.3680043.2.1125.{salt}.900.2").into_bytes());
    }
    // Stamp the PS3.15 de-identification flags (now accurate: nothing un-listed survives).
    set_elem(elems, 0x0012, 0x0062, b"CS", b"YES".to_vec());
    set_elem(elems, 0x0012, 0x0063, b"LO", b"Easy-MP2RAGE-T1-Map whitelist de-identification".to_vec());
}

fn write_elem(out: &mut Vec<u8>, e: &Elem) {
    out.extend_from_slice(&e.group.to_le_bytes());
    out.extend_from_slice(&e.elem.to_le_bytes());
    out.extend_from_slice(&e.vr);
    if is_long_vr(&e.vr) {
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
    } else {
        out.extend_from_slice(&(e.data.len() as u16).to_le_bytes());
    }
    out.extend_from_slice(&e.data);
}

fn serialize(elems: &[Elem]) -> Vec<u8> {
    let mut out = vec![0u8; 128];
    out.extend_from_slice(b"DICM");
    // meta group (0002): recompute its group length
    let mut meta: Vec<&Elem> = elems.iter().filter(|e| e.group == 0x0002 && e.elem != 0x0000).collect();
    meta.sort_by_key(|e| e.elem);
    let mut meta_bytes = Vec::new();
    for e in &meta { write_elem(&mut meta_bytes, e); }
    let glen = Elem { group: 0x0002, elem: 0x0000, vr: *b"UL", data: (meta_bytes.len() as u32).to_le_bytes().to_vec() };
    write_elem(&mut out, &glen);
    out.extend_from_slice(&meta_bytes);
    // dataset, sorted by (group, elem)
    let mut ds: Vec<&Elem> = elems.iter().filter(|e| e.group != 0x0002).collect();
    ds.sort_by_key(|e| (e.group, e.elem));
    for e in &ds { write_elem(&mut out, e); }
    out
}

/// Build a derived T1 (ms) DICOM series from the source slices + the computed
/// volume (i-fastest, same grid/order the source assembled to). `salt` is a
/// numeric string that makes the generated UIDs unique.
pub fn write_derived_series(sources: &[&[u8]], t1: &[f32], nx: usize, ny: usize, nz: usize, salt: &str, deidentify: bool)
    -> Result<Vec<Vec<u8>>, String> {
    // order source files by position along the slice normal (same as assemble)
    let mut parsed: Vec<(usize, f64)> = Vec::new();
    let mut normal = [0.0; 3];
    for (idx, &b) in sources.iter().enumerate() {
        let f = parse(b)?;
        if idx == 0 {
            let row = [f.iop[0], f.iop[1], f.iop[2]];
            let col = [f.iop[3], f.iop[4], f.iop[5]];
            normal = cross(row, col);
        }
        parsed.push((idx, f.ipp[0] * normal[0] + f.ipp[1] * normal[1] + f.ipp[2] * normal[2]));
    }
    // total_cmp, not partial_cmp().unwrap(): a source slice with a non-finite
    // ImagePositionPatient would make the projection NaN and panic the unwrap.
    parsed.sort_by(|a, b| a.1.total_cmp(&b.1));
    if parsed.len() != nz {
        return Err(format!("source slices ({}) != volume slices ({nz})", parsed.len()));
    }
    let root = "1.2.826.0.1.3680043.2.1125";
    let series_uid = format!("{root}.{salt}.1");
    let mut files = Vec::with_capacity(nz);
    for (k, &(src_idx, _)) in parsed.iter().enumerate() {
        let mut elems = parse_all(sources[src_idx])?;
        // new pixel data (uint16 ms) for slice k, in row-major (row*cols+col)
        let mut px = vec![0u8; nx * ny * 2];
        for row in 0..ny {
            for coln in 0..nx {
                let v = t1[coln + nx * (row + ny * k)].max(0.0).round().min(65535.0) as u16;
                let o = (row * nx + coln) * 2;
                px[o] = (v & 0xff) as u8;
                px[o + 1] = (v >> 8) as u8;
            }
        }
        let sop = format!("{root}.{salt}.{}", k + 2);
        set_elem(&mut elems, 0x7FE0, 0x0010, b"OW", px);
        set_elem(&mut elems, 0x0008, 0x0018, b"UI", sop.clone().into_bytes());
        set_elem(&mut elems, 0x0002, 0x0003, b"UI", sop.into_bytes());
        set_elem(&mut elems, 0x0020, 0x000E, b"UI", series_uid.clone().into_bytes());
        set_elem(&mut elems, 0x0008, 0x103E, b"LO", b"T1 map (ms) - Easy-MP2RAGE-T1-Map".to_vec());
        set_elem(&mut elems, 0x0008, 0x0008, b"CS", b"DERIVED\\SECONDARY".to_vec());
        set_elem(&mut elems, 0x0020, 0x0011, b"IS", b"9001".to_vec());
        set_elem(&mut elems, 0x0028, 0x1052, b"DS", b"0".to_vec());
        set_elem(&mut elems, 0x0028, 0x1053, b"DS", b"1".to_vec());
        set_elem(&mut elems, 0x0028, 0x1054, b"LO", b"ms".to_vec());
        set_elem(&mut elems, 0x0028, 0x0100, b"US", 16u16.to_le_bytes().to_vec());
        set_elem(&mut elems, 0x0028, 0x0101, b"US", 16u16.to_le_bytes().to_vec());
        set_elem(&mut elems, 0x0028, 0x0102, b"US", 15u16.to_le_bytes().to_vec());
        set_elem(&mut elems, 0x0028, 0x0103, b"US", 0u16.to_le_bytes().to_vec());
        // ensure a Modality is present (keep source's if any)
        if get_elem(&elems, 0x0008, 0x0060).is_none() {
            set_elem(&mut elems, 0x0008, 0x0060, b"CS", b"MR".to_vec());
        }
        if deidentify {
            deidentify_elems(&mut elems, salt);
        }
        files.push(serialize(&elems));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(group: u16, elem: u16, vr: &[u8; 2], data: &[u8]) -> Elem {
        Elem { group, elem, vr: *vr, data: data.to_vec() }
    }
    fn has(elems: &[Elem], g: u16, e: u16) -> bool {
        get_elem(elems, g, e).is_some()
    }

    #[test]
    fn deidentify_is_a_fail_safe_whitelist() {
        // A slice carrying a spread of real-world PHI plus the technical tags a
        // viewer needs. The whitelist must strip every PHI tag (even ones not
        // individually enumerated) while keeping the technical/geometry set.
        let mut elems = vec![
            // PHI that a blacklist would miss:
            el(0x0010, 0x21B0, b"LT", b"MRN 12345 John Smith"), // AdditionalPatientHistory
            el(0x0010, 0x2160, b"SH", b"WHITE"),                // EthnicGroup
            el(0x0010, 0x0032, b"TM", b"0930"),                 // PatientBirthTime
            el(0x0010, 0x21C0, b"US", &[0, 0]),                 // PregnancyStatus
            el(0x0008, 0x1030, b"LO", b"BRAIN w/ contrast"),    // StudyDescription
            el(0x0008, 0x002A, b"DT", b"20240101093000"),       // AcquisitionDateTime
            el(0x0008, 0x0012, b"DA", b"20240101"),             // InstanceCreationDate
            el(0x0008, 0x1048, b"PN", b"Dr^Referrer"),          // PhysiciansOfRecord
            el(0x0008, 0x009C, b"PN", b"Dr^Consult"),           // ConsultingPhysicianName
            el(0x0029, 0x1010, b"OB", b"CSA private blob"),     // Siemens private group (odd)
            el(0x0002, 0x0102, b"OB", b"vendor PHI blob"),      // file-meta PrivateInformation
            el(0x0002, 0x0100, b"UI", b"1.2.3.4.creator"),      // PrivateInformationCreatorUID
            el(0x0028, 0x4000, b"LT", b"typed by operator: John Smith"), // Image Presentation Comments
            // identity that must be present-but-empty:
            el(0x0010, 0x0010, b"PN", b"Smith^John"),           // PatientName
            el(0x0010, 0x0020, b"LO", b"PT-0001"),              // PatientID
            // linkage UIDs that must be re-mapped:
            el(0x0020, 0x000D, b"UI", b"1.2.3.4.original.study"),
            el(0x0020, 0x0010, b"SH", b"STUDY-42"),             // StudyID (dropped)
            el(0x0020, 0x0052, b"UI", b"1.2.3.4.original.for"),
            el(0x0002, 0x0016, b"AE", b"SCANNER01"),            // SourceApplicationEntityTitle (dropped)
            // technical / geometry that must survive:
            el(0x0028, 0x0010, b"US", &16u16.to_le_bytes()),    // Rows
            el(0x0020, 0x0037, b"DS", b"1\\0\\0\\0\\1\\0"),      // ImageOrientationPatient
            el(0x0008, 0x0060, b"CS", b"MR"),                   // Modality
            el(0x7FE0, 0x0010, b"OW", b"\x00\x01\x02\x03"),      // PixelData
        ];
        deidentify_elems(&mut elems, "97531");

        // every un-enumerated PHI tag is gone
        for (g, e) in [
            (0x0010, 0x21B0), (0x0010, 0x2160), (0x0010, 0x0032), (0x0010, 0x21C0),
            (0x0008, 0x1030), (0x0008, 0x002A), (0x0008, 0x0012), (0x0008, 0x1048),
            (0x0008, 0x009C),
        ] {
            assert!(!has(&elems, g, e), "PHI tag ({g:04X},{e:04X}) survived de-identification");
        }
        // private/odd group and source AE title dropped
        assert!(!elems.iter().any(|e| e.group % 2 == 1), "a private (odd-group) tag survived");
        assert!(!has(&elems, 0x0002, 0x0016), "SourceApplicationEntityTitle survived");
        // file-meta private-info and image-pixel free text dropped (no wholesale group keep)
        assert!(!has(&elems, 0x0002, 0x0102), "file-meta PrivateInformation survived");
        assert!(!has(&elems, 0x0002, 0x0100), "PrivateInformationCreatorUID survived");
        assert!(!has(&elems, 0x0028, 0x4000), "Image Presentation Comments (free text) survived");
        // BurnedInAnnotation asserted NO (derived pixels are freshly computed)
        assert_eq!(get_elem(&elems, 0x0028, 0x0301).map(|v| v.trim_ascii_end()), Some(&b"NO"[..]));

        // identity kept present but blank (Type-2 conformance; value removed)
        assert_eq!(get_elem(&elems, 0x0010, 0x0010), Some(&b""[..]), "PatientName not blanked");
        assert_eq!(get_elem(&elems, 0x0010, 0x0020), Some(&b""[..]), "PatientID not blanked");
        assert_eq!(get_elem(&elems, 0x0020, 0x0010), Some(&b""[..]), "StudyID not blanked");

        // linkage UIDs re-mapped away from the source values
        assert_ne!(get_elem(&elems, 0x0020, 0x000D), Some(&b"1.2.3.4.original.study"[..]));
        assert_ne!(get_elem(&elems, 0x0020, 0x0052), Some(&b"1.2.3.4.original.for"[..]));

        // technical/geometry/pixel survive
        for (g, e) in [(0x0028, 0x0010), (0x0020, 0x0037), (0x0008, 0x0060), (0x7FE0, 0x0010)] {
            assert!(has(&elems, g, e), "technical tag ({g:04X},{e:04X}) was dropped");
        }

        // the PS3.15 flag is now accurate (CS value is padded to even length)
        assert_eq!(get_elem(&elems, 0x0012, 0x0062).map(|v| v.trim_ascii_end()), Some(&b"YES"[..]));
    }
}
