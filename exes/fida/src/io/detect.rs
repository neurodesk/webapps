//! "Drop your files": sniff a set of named files, group them into datasets
//! (a reader plus its companion files), pair each metabolite dataset with its
//! water reference by FID-A's naming conventions, and load them.
//!
//! Names may carry a relative path (`press_w/acqp`, as a browser directory
//! drop gives them); the directory is used for Bruker scans and for the
//! `<name>_w/` water directories of FID-A's example scripts.
//!
//! Water pairing (the conventions of FID-A's run_*proc scripts, and of the
//! vendors' and spec2nii's file names):
//! * `<stem>_w`, `<stem>_ref`, `<stem>_wref`, `<stem>_water`, `<stem>_h2o`,
//!   `<stem>_water_off`, `<stem>_nows` (file stem or containing directory)
//!   pair with `<stem>`, `<stem>_ws` or `<stem>_act` (Philips' names, and
//!   spec2nii's when it converts them);
//! * unmatched Siemens DICOM series pair within a folder only when their
//!   StudyInstanceUID matches and there is one spectrum and one water series;
//! * a Siemens DICOM water series also serves every spectrum of its folder,
//!   study and protocol (the averaged `_ave` and unaveraged series of one
//!   acquisition) when it is that protocol's only water series;
//! * LCModel `<stem>.H2O` pairs with `<stem>.RAW`;
//! * GE P-files carry their own water frames, and some twix sequences
//!   (CMRR / Columbia sLASER) their own water scans.

use super::common::{maybe_gunzip, Res};
use super::geometry::{self, Voxel};
use crate::spectra::Spectra;
use std::collections::{HashMap, HashSet};

/// One input file.
#[derive(Clone, Copy, Debug)]
pub struct NamedFile<'a> {
    /// File name, optionally with a relative directory (`/`-separated).
    pub name: &'a str,
    pub bytes: &'a [u8],
}

/// The reader a dataset needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    /// Siemens twix raw data (.dat), `io_loadspec_twix`.
    Twix,
    /// GE P-file (P*.7), `io_loadspec_GE`.
    GePfile,
    /// Siemens .rda, `io_loadspec_rda`.
    SiemensRda,
    /// Siemens spectroscopy DICOM / IMA, `io_loadspec_dicom_siemens`.
    SiemensDicom,
    /// Philips SDAT + SPAR, `io_loadspec_sdat`.
    PhilipsSdat,
    /// NIfTI-MRS, `io_loadspec_niimrs`.
    NiftiMrs,
    /// LCModel .RAW / .H2O, `io_readlcmraw`.
    LcModelRaw,
    /// Bruker scan directory (acqp, method, fid...), `io_loadspec_bruk`.
    Bruker,
}

impl Format {
    pub fn label(&self) -> &'static str {
        match self {
            Format::Twix => "Siemens twix (.dat)",
            Format::GePfile => "GE P-file",
            Format::SiemensRda => "Siemens RDA",
            Format::SiemensDicom => "Siemens spectroscopy DICOM",
            Format::PhilipsSdat => "Philips SDAT/SPAR",
            Format::NiftiMrs => "NIfTI-MRS",
            Format::LcModelRaw => "LCModel RAW",
            Format::Bruker => "Bruker",
        }
    }
}

/// A group of files one reader turns into one FID-A structure.
#[derive(Clone, Debug, PartialEq)]
pub struct Dataset {
    pub format: Format,
    /// Indices into the input list; the primary file first (SDAT before SPAR;
    /// for DICOM every file of the series; for Bruker every file of the scan).
    pub files: Vec<usize>,
    /// Display name: the file stem, or the directory for Bruker/DICOM.
    pub name: String,
    /// True when the naming says this is a water reference.
    pub is_water: bool,
}

/// A metabolite dataset and the water reference paired with it.
#[derive(Clone, Debug, PartialEq)]
pub struct Pairing {
    pub metabolite: Dataset,
    pub water: Option<Dataset>,
    /// True when `water` was automatically shared from another run rather than
    /// paired by name/stem or DICOM study series.
    pub water_shared: bool,
}

/// An anatomical image or DICOM image series, using original file indices.
#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub name: String,
    pub files: Vec<usize>,
}

/// Result of [`detect`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Detection {
    pub pairs: Vec<Pairing>,
    pub images: Vec<Image>,
    /// Water datasets with no metabolite partner.
    pub unpaired_water: Vec<Dataset>,
    /// (file name, reason) for files no reader applies to.
    pub ignored: Vec<(String, String)>,
}

fn split_path(name: &str) -> (&str, &str) {
    let name = name.trim_start_matches("./");
    match name.rfind(['/', '\\']) {
        Some(k) => (&name[..k], &name[k + 1..]),
        None => ("", name),
    }
}

fn ext_lower(file: &str) -> String {
    let f = file.to_ascii_lowercase();
    if let Some(s) = f.strip_suffix(".gz") {
        if let Some(k) = s.rfind('.') {
            return format!("{}.gz", &s[k + 1..]);
        }
    }
    f.rfind('.').map(|k| f[k + 1..].to_string()).unwrap_or_default()
}

fn stem_of(file: &str) -> String {
    let mut s = file.to_string();
    for suf in [".nii.gz", ".NII.GZ"] {
        if let Some(x) = s.strip_suffix(suf) {
            return x.to_string();
        }
    }
    if let Some(k) = s.rfind('.') {
        s.truncate(k);
    }
    s
}

fn is_nifti(b: &[u8]) -> bool {
    let head: std::borrow::Cow<[u8]> = if b.len() >= 2 && b[0] == 0x1f && b[1] == 0x8b {
        // only the header is needed; decompress a prefix
        use std::io::Read;
        let mut out = vec![0u8; 552];
        let mut d = flate2::read::MultiGzDecoder::new(b);
        let mut got = 0;
        while got < out.len() {
            match d.read(&mut out[got..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        out.truncate(got);
        std::borrow::Cow::Owned(out)
    } else {
        std::borrow::Cow::Borrowed(b)
    };
    if head.len() < 348 {
        return false;
    }
    let sz = i32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let szb = i32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    match (sz, szb) {
        (348, _) | (_, 348) => &head[344..347] == b"n+1" || &head[344..347] == b"ni1",
        (540, _) | (_, 540) => head.len() >= 8 && (&head[4..7] == b"n+2" || &head[4..7] == b"ni2"),
        _ => false,
    }
}

fn is_twix(b: &[u8]) -> bool {
    if b.len() < 64 {
        return false;
    }
    let u = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
    let first = u(0);
    let second = u(4);
    let hdr_at = if first < 10000 && second <= 64 && second > 0 {
        let o = 16 + 152 * (second - 1);
        if o + 8 > b.len() {
            return false;
        }
        u64::from_le_bytes(b[o..o + 8].try_into().unwrap()) as usize
    } else {
        0
    };
    // measurement header: hdr_len, nbuffers, then the first buffer name ("Config")
    hdr_at + 16 <= b.len() && {
        let nb = u(hdr_at + 4);
        (1..=64).contains(&nb) && b[hdr_at + 8..].starts_with(b"Config\0")
    }
}

fn is_ge(b: &[u8]) -> bool {
    if b.len() < 4096 {
        return false;
    }
    let rev = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    let known = [14.3f32, 16.0, 20.006, 20.007, 24.0, 26.002, 27.0, 27.001, 28.002, 28.003, 30.0, 30.1, 9.0, 11.0];
    let be = f32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    known.contains(&rev) || be == 7.0 || be == 8.0 || (be > 5.0 && be < 6.0)
}

fn is_dicom(b: &[u8]) -> bool {
    b.len() > 132 && &b[128..132] == b"DICM"
}

fn text_prefix(b: &[u8], n: usize) -> String {
    String::from_utf8_lossy(&b[..b.len().min(n)]).into_owned()
}

/// Which reader a single file is for, from its bytes and name (companion
/// files such as SPAR or Bruker parameter files are classified by [`detect`]).
pub fn sniff(name: &str, bytes: &[u8]) -> Option<Format> {
    let (_, file) = split_path(name);
    let ext = ext_lower(file);
    if bytes.starts_with(b">>> Begin of header <<<") {
        return Some(Format::SiemensRda);
    }
    if is_nifti(bytes) {
        return (!super::niimrs::is_anatomical(bytes).unwrap_or(false)).then_some(Format::NiftiMrs);
    }
    if is_dicom(bytes) || ext == "ima" {
        return Some(Format::SiemensDicom);
    }
    if is_twix(bytes) {
        return Some(Format::Twix);
    }
    if ext == "sdat" {
        return Some(Format::PhilipsSdat);
    }
    let t = text_prefix(bytes, 4096);
    if (t.contains("$NMID") || t.contains("$nmid")) && (t.contains("$END") || t.contains("$end")) {
        return Some(Format::LcModelRaw);
    }
    if (ext == "7" || file.starts_with('P')) && is_ge(bytes) {
        return Some(Format::GePfile);
    }
    None
}

const WATER_SUFFIXES: [&str; 9] = ["_w", "_ref", "_wref", "_water", "_h2o", "_water_off", "_nows", "_onlyrfoff", "_rfoff"];
const METABOLITE_SUFFIXES: [&str; 3] = ["_ws", "_act", "_metab"];

fn water_base(stem: &str) -> Option<String> {
    let low = stem.to_ascii_lowercase();
    for s in WATER_SUFFIXES {
        if let Some(b) = low.strip_suffix(s) {
            if !b.is_empty() {
                return Some(b.to_string());
            }
        }
    }
    None
}

/// Strip Siemens TWIX `meas_MID<digits>_` / `FID<digits>` wrappers so raw
/// scanner exports (`meas_MID310_STEAM_metab_FID115673` +
/// `meas_MID312_STEAM_wref3_FID115675`) expose their protocol stem.
fn twix_protocol_stem(stem: &str) -> Option<String> {
    let low = stem.to_ascii_lowercase();
    let rest = low.strip_prefix("meas_mid")?;
    let digits_end = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_end == 0 || rest.as_bytes().get(digits_end) != Some(&b'_') {
        return None;
    }
    let parts: Vec<&str> = rest[digits_end + 1..]
        .split('_')
        .filter(|p| !p.is_empty())
        .filter(|p| !p.strip_prefix("fid").is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("_"))
    }
}

/// Water base of a TWIX protocol stem: standard water suffixes plus numbered
/// water-reference tokens such as `_wref3` or `_water1`.
fn twix_water_base(protocol: &str) -> Option<String> {
    if let Some(base) = water_base(protocol) {
        return Some(base);
    }
    let trimmed = protocol.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.len() == protocol.len() {
        return None;
    }
    for s in ["_wref", "_water", "_ref", "_h2o"] {
        if let Some(b) = trimmed.strip_suffix(s) {
            if !b.is_empty() {
                return Some(b.to_string());
            }
        }
    }
    None
}

fn twix_metab_protocol(ds: &Dataset) -> Option<String> {
    if ds.format != Format::Twix {
        return None;
    }
    twix_protocol_stem(&ds.name).map(|p| metabolite_base(&p).to_string())
}

fn twix_water_protocol(ds: &Dataset) -> Option<String> {
    if ds.format != Format::Twix {
        return None;
    }
    twix_protocol_stem(&ds.name)
        .and_then(|p| twix_water_base(&p))
        .map(|b| metabolite_base(&b).to_string())
}

fn twix_plain_water_protocol(ds: &Dataset) -> Option<String> {
    if ds.format != Format::Twix {
        return None;
    }
    twix_water_base(&ds.name.to_ascii_lowercase()).map(|b| metabolite_base(&b).to_string())
}

fn twix_effective_metab_protocol(ds: &Dataset) -> Option<String> {
    if ds.format != Format::Twix {
        return None;
    }
    twix_metab_protocol(ds).or_else(|| Some(metabolite_base(&ds.name.to_ascii_lowercase()).to_string()))
}

fn twix_effective_water_protocol(ds: &Dataset) -> Option<String> {
    if ds.format != Format::Twix {
        return None;
    }
    twix_water_protocol(ds).or_else(|| twix_plain_water_protocol(ds))
}

struct TwixAcquisition {
    voxel: Option<Voxel>,
    study: String,
    frame_of_reference: String,
    patient: String,
}

fn twix_header_text(hdr: &super::twix::TwixHeader, keys: &[(&str, &str)]) -> String {
    for &(buf, key) in keys {
        if let Some(val) = hdr.get(buf, key) {
            let s = val.text().trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    String::new()
}

fn twix_acquisition(ds: &Dataset, files: &[NamedFile]) -> Option<TwixAcquisition> {
    if ds.format != Format::Twix {
        return None;
    }
    let hdr = super::twix::parse_header(files[ds.files[0]].bytes).ok()?;
    Some(TwixAcquisition {
        voxel: geometry::twix(&hdr),
        study: twix_header_text(&hdr, &[("Config", "StudyLOID"), ("Meas", "StudyLOID"), ("Dicom", "StudyLOID")]),
        frame_of_reference: twix_header_text(
            &hdr,
            &[("Config", "FrameOfReference"), ("Meas", "FrameOfReference"), ("Dicom", "FrameOfReference")],
        ),
        patient: twix_header_text(
            &hdr,
            &[
                ("Config", "PatientID"),
                ("Meas", "PatientID"),
                ("Dicom", "PatientID"),
                ("Config", "tPatientName"),
                ("Meas", "tPatientName"),
                ("Dicom", "tPatientName"),
            ],
        ),
    })
}

fn same_twix_voxel(a: &Voxel, b: &Voxel) -> bool {
    let ca = a.center_mm();
    let cb = b.center_mm();
    let sa = a.size_mm();
    let sb = b.size_mm();
    (0..3).all(|i| (ca[i] - cb[i]).abs() <= 1.0 && (sa[i] - sb[i]).abs() <= 1.0)
}

fn conflicting_twix_acquisition(a: Option<&TwixAcquisition>, b: Option<&TwixAcquisition>) -> bool {
    let (Some(a), Some(b)) = (a, b) else { return false };
    a.voxel.as_ref().zip(b.voxel.as_ref()).is_some_and(|(va, vb)| !same_twix_voxel(va, vb))
        || (!a.study.is_empty() && !b.study.is_empty() && a.study != b.study)
        || (!a.frame_of_reference.is_empty() && !b.frame_of_reference.is_empty() && a.frame_of_reference != b.frame_of_reference)
        || (!a.patient.is_empty() && !b.patient.is_empty() && a.patient != b.patient)
}

/// The name a metabolite's water reference is named after: Philips (and
/// spec2nii's conversions of Philips data) name the pair `<stem>_act` /
/// `<stem>_ref` or `<stem>_ws` / `<stem>_w`.
fn metabolite_base(name: &str) -> &str {
    METABOLITE_SUFFIXES.iter().find_map(|s| name.strip_suffix(s).filter(|b| !b.is_empty())).unwrap_or(name)
}

/// Whether a parsed DICOM file holds spectroscopy data FID-A can read
/// (XA SpectroscopyData or the CSA non-image element). The VE reader takes
/// (7FE1,1010) whether or not its private creator is labelled, so this does
/// too. Files that do not parse are kept, so the reader reports why.
fn dicom_has_spectrum(bytes: &[u8]) -> bool {
    match super::dicom_siemens::parse_dicom(bytes) {
        Ok(d) => {
            d.get(0x5600, 0x0020).is_some() || d.get(0x7fe1, 0x1010).is_some() || d.private(0x7fe1, "SIEMENS CSA NON-IMAGE", 0x10).is_some()
        }
        Err(_) => true,
    }
}

pub fn dicom_identity(ds: &Dataset, files: &[NamedFile]) -> Option<(String, String)> {
    if ds.format != Format::SiemensDicom {
        return None;
    }
    let i = ds.files.iter().copied().find(|&i| !split_path(files[i].name).1.starts_with('.'))?;
    let d = super::dicom_siemens::parse_dicom(files[i].bytes).ok()?;
    Some((d.string(0x0020, 0x000d).unwrap_or_default(), d.string(0x0010, 0x0020).unwrap_or_default()))
}

pub fn conflicting_dicom_identity(a: Option<&(String, String)>, b: Option<&(String, String)>) -> bool {
    let (Some((a_study, a_patient)), Some((b_study, b_patient))) = (a, b) else { return false };
    (!a_study.is_empty() && !b_study.is_empty() && a_study != b_study)
        || (!a_patient.is_empty() && !b_patient.is_empty() && a_patient != b_patient)
}

fn same_dicom_study(a: Option<&(String, String)>, b: Option<&(String, String)>) -> bool {
    let (Some((a_study, a_patient)), Some((b_study, b_patient))) = (a, b) else { return false };
    !a_study.is_empty() && a_study == b_study
        && (a_patient.is_empty() || b_patient.is_empty() || a_patient == b_patient)
}

/// The protocol a Siemens series was acquired with: its description, else
/// the name of its own folder (`own_folder`: no other series shares that
/// folder), after the series number and without the suffixes Siemens and
/// sites add for the averaged and water-unsuppressed series of one acquisition.
fn dicom_protocol(ds: &Dataset, files: &[NamedFile], own_folder: bool) -> Option<String> {
    let i = ds.files.iter().copied().find(|&i| !split_path(files[i].name).1.starts_with('.'))?;
    let dicom = super::dicom_siemens::parse_dicom(files[i].bytes).ok()?;
    let description = dicom.string(0x0008, 0x103e).unwrap_or_default();
    let series_number = dicom.string(0x0020, 0x0011).and_then(|s| s.trim().parse::<u32>().ok());
    let (name, folder_name) = match description.trim() {
        "" if own_folder => (split_path(split_path(files[i].name).0).1, true),
        "" => return None,
        d => (d, false),
    };
    let name = name.to_ascii_lowercase();
    let name = after_series_number(&name, series_number, folder_name);
    let name = water_base(name).unwrap_or_else(|| name.to_string());
    let name = name.strip_suffix("_ave").unwrap_or(&name);
    (!name.is_empty()).then(|| name.to_string())
}

/// Strip a leading SeriesNumber, or a `sub-<subject>-<series>-` folder prefix.
/// Protocol parameters such as the 30 in `PRESS-30-TE` are never a prefix.
fn after_series_number(name: &str, series_number: Option<u32>, folder_name: bool) -> &str {
    let subject_prefix = folder_name.then(|| name.strip_prefix("sub-")).flatten()
        .and_then(|rest| rest.split_once('-'))
        .filter(|(subject, _)| !subject.is_empty() && subject.bytes().all(|b| b.is_ascii_alphanumeric()))
        .map(|(_, rest)| rest);
    let candidate = subject_prefix.unwrap_or(name);
    let Some((prefix, protocol)) = candidate.split_once('-') else { return name };
    let Ok(prefix) = prefix.parse::<u32>() else { return name };
    if series_number.map_or(subject_prefix.is_some(), |number| number == prefix) {
        protocol
    } else {
        name
    }
}

/// Leading directory components two paths share.
fn shared_dirs(a: &str, b: &str) -> usize {
    let parts = |p: &str| p.trim_start_matches("./").split(['/', '\\']).filter(|c| !c.is_empty()).map(str::to_ascii_lowercase).collect::<Vec<_>>();
    parts(a).iter().zip(parts(b).iter()).take_while(|(x, y)| x == y).count()
}

fn bruker_file(file: &str) -> bool {
    matches!(file, "acqp" | "method" | "fid" | "fid.raw" | "rawdata.job0" | "fid.ref" | "fid.refscan" | "fid_refscan.64" | "acqus")
}

/// Group and pair the files.
pub fn detect(files: &[NamedFile]) -> Detection {
    let mut det = Detection::default();
    let mut datasets: Vec<Dataset> = Vec::new();
    let mut used = vec![false; files.len()];

    // Bruker: directories holding acqp + method
    let mut dirs: Vec<String> = Vec::new();
    for f in files {
        let (d, file) = split_path(f.name);
        if file == "acqp" && !dirs.contains(&d.to_string()) {
            dirs.push(d.to_string());
        }
    }
    for d in dirs {
        // pdata/<n>/ files belong to the scan directory d as well
        let members: Vec<usize> = (0..files.len())
            .filter(|&i| {
                let (fd, file) = split_path(files[i].name);
                (fd == d && bruker_file(file)) || (fd.starts_with(&format!("{d}/pdata/")) && file == "fid_refscan.64")
            })
            .collect();
        let has_method = members.iter().any(|&i| split_path(files[i].name).1 == "method");
        if !has_method {
            continue;
        }
        for &i in &members {
            used[i] = true;
        }
        let name = split_path(&d).1.to_string();
        let name = if name.is_empty() { "bruker".to_string() } else { name };
        datasets.push(Dataset { format: Format::Bruker, files: members, is_water: water_base(&name).is_some(), name });
    }

    // Philips: SDAT + SPAR by stem
    for i in 0..files.len() {
        if used[i] {
            continue;
        }
        let (d, file) = split_path(files[i].name);
        if ext_lower(file) != "sdat" {
            continue;
        }
        let stem = stem_of(file);
        let spar = (0..files.len()).find(|&j| {
            let (dj, fj) = split_path(files[j].name);
            dj == d && ext_lower(fj) == "spar" && stem_of(fj) == stem
        });
        match spar {
            Some(j) => {
                used[i] = true;
                used[j] = true;
                let is_water = water_base(&stem).is_some();
                datasets.push(Dataset { format: Format::PhilipsSdat, files: vec![i, j], name: stem, is_water });
            }
            None => {
                used[i] = true;
                det.ignored.push((files[i].name.to_string(), "SDAT file without its SPAR header (same name, .SPAR)".into()));
            }
        }
    }


    let mut dicom_groups: Vec<((bool, String, String, String), Vec<usize>, String)> = Vec::new();
    for i in 0..files.len() {
        let (dir, file) = split_path(files[i].name);
        if file.starts_with('.') {
            used[i] = true;
        }
        if used[i] || sniff(files[i].name, files[i].bytes) != Some(Format::SiemensDicom) {
            continue;
        }
        used[i] = true;
        let parsed = super::dicom_siemens::parse_dicom(files[i].bytes).ok();
        let tag = |group, element| parsed.as_ref().and_then(|d| d.string(group, element)).unwrap_or_default();
        let study = tag(0x0020, 0x000d);
        let series = tag(0x0020, 0x000e);
        let patient = tag(0x0010, 0x0020);
        let spectrum = dicom_has_spectrum(files[i].bytes);
        let location = if series.is_empty() { format!("folder:{dir}") } else { format!("series:{series}") };
        let key = (spectrum, study, location, patient);
        let folder_name = if dir.is_empty() { stem_of(file) } else { split_path(dir).1.to_string() };
        let description = tag(0x0008, 0x103e);
        let name = if series.is_empty() || description.is_empty() || water_base(&folder_name).is_some() { folder_name } else { description };
        match dicom_groups.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, members, _)) => members.push(i),
            None => dicom_groups.push((key, vec![i], name)),
        }
    }
    let mut spectroscopy_per_folder: HashMap<&str, usize> = HashMap::new();
    for ((spectrum, _, _, _), members, _) in &dicom_groups {
        if *spectrum {
            *spectroscopy_per_folder.entry(split_path(files[members[0]].name).0).or_default() += 1;
        }
    }
    for ((spectrum, _, _, _), members, mut name) in dicom_groups {
        if spectrum {
            let (dir, file) = split_path(files[members[0]].name);
            if spectroscopy_per_folder.get(dir) == Some(&1) {
                name = if dir.is_empty() { stem_of(file) } else { split_path(dir).1.to_string() };
            }
            let is_water = water_base(&name).is_some()
                || members.iter().any(|&i| water_base(&stem_of(split_path(files[i].name).1)).is_some());
            datasets.push(Dataset { format: Format::SiemensDicom, files: members, is_water, name });
        } else {
            det.images.push(Image { name, files: members });
        }
    }

    // single-file formats
    for i in 0..files.len() {
        if used[i] {
            continue;
        }
        let (d, file) = split_path(files[i].name);
        let ext = ext_lower(file);
        if is_nifti(files[i].bytes) && super::niimrs::is_anatomical(files[i].bytes).unwrap_or(false) {
            det.images.push(Image { name: stem_of(file), files: vec![i] });
            continue;
        }
        match sniff(files[i].name, files[i].bytes) {
            Some(fmt) => {
                used[i] = true;
                let stem = stem_of(file);
                let dir_water = water_base(split_path(d).1).is_some();
                let is_water = match fmt {
                    Format::LcModelRaw => ext == "h2o" || water_base(&stem).is_some(),
                    Format::GePfile => false,
                    Format::Twix => {
                        twix_water_base(&stem.to_ascii_lowercase()).is_some()
                            || twix_protocol_stem(&stem).and_then(|p| twix_water_base(&p)).is_some()
                            || dir_water
                    }
                    _ => water_base(&stem).is_some() || dir_water,
                };
                datasets.push(Dataset { format: fmt, files: vec![i], name: stem, is_water });
            }
            None => {
                let reason = if ext == "spar" {
                    "SPAR header without its SDAT data file"
                } else {
                    "not a spectroscopy format FID-A reads"
                };
                det.ignored.push((files[i].name.to_string(), reason.into()));
            }
        }
    }

    // pairing: when several water datasets match by name (subjects in
    // separate folders with the same file names), the one closest in the
    // directory tree wins, so a folder of subjects pairs within each subject.
    let identities: HashMap<usize, (String, String)> = datasets.iter()
        .filter_map(|ds| dicom_identity(ds, files).map(|identity| (ds.files[0], identity)))
        .collect();
    // Where a Siemens series was acquired, for sharing its water series: the
    // session folder above a folder of its own, else its exact folder.
    let dicom: Vec<&Dataset> = datasets.iter().filter(|ds| ds.format == Format::SiemensDicom).collect();
    let dir_of = |ds: &Dataset| split_path(files[ds.files[0]].name).0;
    let mut scopes: HashMap<usize, String> = HashMap::new();
    let mut protocols: HashMap<usize, String> = HashMap::new();
    let mut voxels: HashMap<usize, Voxel> = HashMap::new();
    for ds in &dicom {
        let own_folder = !dir_of(ds).is_empty() && dicom.iter().filter(|other| dir_of(other) == dir_of(ds)).count() == 1;
        scopes.insert(ds.files[0], if own_folder { split_path(dir_of(ds)).0 } else { dir_of(ds) }.to_string());
        if let Some(protocol) = dicom_protocol(ds, files, own_folder) {
            protocols.insert(ds.files[0], protocol);
        }
        if let Some(voxel) = geometry::siemens_dicom(&super::dicom_siemens::protocol_text(files[ds.files[0]].bytes)) {
            voxels.insert(ds.files[0], voxel);
        }
    }
    // Any `(dir, protocol)` containing a scanner-named twix file routes every
    // twix metabolite and water reference for that `(dir, protocol)` (whether
    // scanner-named or renamed) through the scoped twix post-pass so greedy
    // stem/folder matching cannot bypass same-folder and uniqueness checks.
    let scanner_twix_scopes: HashSet<(String, String)> = datasets
        .iter()
        .filter(|ds| ds.format == Format::Twix)
        .filter_map(|ds| {
            let proto = if ds.is_water { twix_water_protocol(ds) } else { twix_metab_protocol(ds) }?;
            Some((dir_of(ds).to_string(), proto))
        })
        .collect();
    let twix_acqs: HashMap<usize, TwixAcquisition> = if !scanner_twix_scopes.is_empty() {
        datasets.iter().filter_map(|ds| twix_acquisition(ds, files).map(|acq| (ds.files[0], acq))).collect()
    } else {
        HashMap::new()
    };
    let key = |ds: &Dataset| -> (Format, String) { (ds.format, ds.name.to_ascii_lowercase()) };
    let (water, metab): (Vec<Dataset>, Vec<Dataset>) = datasets.into_iter().partition(|d| d.is_water);
    let mut water: Vec<Option<Dataset>> = water.into_iter().map(Some).collect();
    for m in metab {
        let (fmt, mname) = key(&m);
        let mpath = split_path(files[m.files[0]].name).0;
        let mdir = split_path(mpath).1.to_ascii_lowercase();
        let defer_twix = fmt == Format::Twix
            && (twix_metab_protocol(&m).is_some()
                || twix_effective_metab_protocol(&m)
                    .is_some_and(|proto| scanner_twix_scopes.contains(&(mpath.to_string(), proto))));
        let mut best: Option<(usize, usize)> = None;
        if !defer_twix {
            for (wi, w) in water.iter().enumerate() {
                let Some(w) = w else { continue };
                if w.format != fmt {
                    continue;
                }
                if fmt == Format::Twix
                    && (twix_protocol_stem(&w.name).is_some()
                        || twix_effective_water_protocol(w)
                            .is_some_and(|proto| scanner_twix_scopes.contains(&(dir_of(w).to_string(), proto))))
                {
                    continue;
                }
                let wname = w.name.to_ascii_lowercase();
                let wpath = split_path(files[w.files[0]].name).0;
                let wdir = split_path(wpath).1.to_ascii_lowercase();
                let hit = match fmt {
                    Format::LcModelRaw => wname == mname || water_base(&wname).as_deref() == Some(&mname),
                    _ => {
                        let wb = water_base(&wname);
                        wb.as_deref() == Some(&mname)
                            || wb.as_deref() == Some(metabolite_base(&mname))
                            || (!mdir.is_empty() && water_base(&wdir).as_deref() == Some(&mdir))
                    }
                };
                // TWIX files live either in the same folder or in a sibling water folder
                // (e.g. `megapress/` + `megapress_w/` under the same parent); never pair
                // across different subject folders (e.g. `sub-01/` and `sub-02/`).
                let twix_folder_ok = fmt != Format::Twix
                    || wpath == mpath
                    || (!mdir.is_empty()
                        && water_base(&wdir).as_deref() == Some(&mdir)
                        && split_path(wpath).0 == split_path(mpath).0);
                let twix_voi_ok = fmt != Format::Twix || {
                    let mv = super::twix::parse_header(files[m.files[0]].bytes).ok().and_then(|h| geometry::twix(&h));
                    let wv = super::twix::parse_header(files[w.files[0]].bytes).ok().and_then(|h| geometry::twix(&h));
                    mv.zip(wv).is_none_or(|(a, b)| same_twix_voxel(&a, &b))
                };
                if hit && twix_folder_ok && twix_voi_ok && !conflicting_dicom_identity(identities.get(&m.files[0]), identities.get(&w.files[0])) {
                    let shared = shared_dirs(mpath, wpath);
                    if best.is_none_or(|(_, s)| shared > s) {
                        best = Some((wi, shared));
                    }
                }
            }
        }
        let w = best.and_then(|(k, _)| water[k].take());
        det.pairs.push(Pairing { metabolite: m, water: w, water_shared: false });
    }
    // Siemens series names include different numbers and descriptions, so
    // unmatched series need a shared study identifier as well as one of each.
    let folder = |ds: &Dataset| {
        let dir = split_path(files[ds.files[0]].name).0;
        if ds.format == Format::SiemensDicom || ds.format == Format::Bruker { split_path(dir).0.to_string() } else { dir.to_string() }
    };
    let left: Vec<Option<(Format, String)>> = water.iter().map(|w| w.as_ref().map(|w| (w.format, folder(w)))).collect();
    for (wi, place) in left.iter().enumerate() {
        let Some((fmt, wf)) = place else { continue };
        if left.iter().flatten().filter(|&(f, d)| f == fmt && d == wf).count() != 1 {
            continue;
        }
        let here: Vec<usize> = (0..det.pairs.len()).filter(|&k| det.pairs[k].metabolite.format == *fmt && folder(&det.pairs[k].metabolite) == *wf).collect();
        if let [k] = here[..] {
            if det.pairs[k].water.is_none() && water[wi].as_ref().is_some_and(|w| same_dicom_study(identities.get(&det.pairs[k].metabolite.files[0]), identities.get(&w.files[0]))) {
                det.pairs[k].water = water[wi].take();
            }
        }
    }
    // The averaged and unaveraged series of one Siemens acquisition share its
    // water series, paired or not: every spectrum of the same folder, study
    // and protocol gets it, when it is that protocol's only water series.
    let together = |a: &Dataset, b: &Dataset| {
        scopes.get(&a.files[0]).is_some_and(|scope| scopes.get(&b.files[0]) == Some(scope))
            && same_dicom_study(identities.get(&a.files[0]), identities.get(&b.files[0]))
    };
    let shares = |a: &Dataset, b: &Dataset| {
        let protocol = protocols.get(&a.files[0]);
        protocol.is_some() && protocol == protocols.get(&b.files[0]) && together(a, b)
    };
    // A water series of unknown protocol beside it may be the right one.
    let rivals = |a: &Dataset, b: &Dataset| together(a, b) && (!protocols.contains_key(&b.files[0]) || shares(a, b));
    let sources: Vec<(Dataset, Option<usize>)> = det.pairs.iter().filter_map(|p| p.water.clone().map(|w| (w, None)))
        .chain(water.iter().enumerate().filter_map(|(wi, w)| w.clone().map(|w| (w, Some(wi)))))
        .collect();
    for (w, unpaired) in &sources {
        if sources.iter().filter(|(other, _)| rivals(w, other)).count() != 1 {
            continue;
        }
        let targets: Vec<usize> = (0..det.pairs.len()).filter(|&k| {
            let metabolite = &det.pairs[k].metabolite;
            // A repeated protocol at another known VOI is a different acquisition.
            det.pairs[k].water.is_none() && shares(w, metabolite)
                && voxels.get(&w.files[0]).zip(voxels.get(&metabolite.files[0])).is_none_or(|(a, b)| a == b)
        }).collect();
        for &k in &targets {
            det.pairs[k].water = Some(w.clone());
            det.pairs[k].water_shared = true;
        }
        if let (Some(wi), false) = (unpaired, targets.is_empty()) {
            water[*wi] = None;
        }
    }
    // Siemens TWIX scans carry distinct MID/FID prefixes (e.g.
    // meas_MID00116_FID179112_SV_Steam_OnlyRFoff.dat alongside a session's
    // metabolite runs), so share an unambiguous single water TWIX scan within
    // the same folder only when frequency, dwell time and recorded VOI geometry
    // affirmatively agree.
    let twix_meta = |ds: &Dataset| -> Option<(f64, f64, Voxel)> {
        if ds.format != Format::Twix {
            return None;
        }
        let hdr = super::twix::parse_header(files[ds.files[0]].bytes).ok()?;
        let freq = hdr
            .get("MeasYaps", "sTXSPEC.asNucleusInfo[0].lFrequency")
            .and_then(|v| v.num())
            .or_else(|| hdr.get("Config", "Frequency").and_then(|v| v.num()))
            .or_else(|| hdr.get("Dicom", "lFrequency").and_then(|v| v.num()))
            .or_else(|| hdr.get("Meas", "lFrequency").and_then(|v| v.num()))?;
        let dwell = hdr
            .get("MeasYaps", "sRXSPEC.alDwellTime[0]")
            .and_then(|v| v.num())
            .or_else(|| hdr.get("Config", "DwellTime").and_then(|v| v.num()))?;
        if !(freq.is_finite() && freq > 0.0 && dwell.is_finite() && dwell > 0.0) {
            return None;
        }
        // Require verified voxel geometry on both scans for automatic cross-run sharing.
        let voxel = geometry::twix(&hdr)?;
        Some((freq, dwell, voxel))
    };
    let twix_compatible = |a: &(f64, f64, Voxel), b: &(f64, f64, Voxel)| -> bool {
        if (a.0 - b.0).abs() > a.0.abs() * 0.001 {
            return false;
        }
        if (a.1 - b.1).abs() > a.1.abs().max(1.0) * 1e-6 {
            return false;
        }
        same_twix_voxel(&a.2, &b.2)
    };
    let twix_sources: Vec<(Dataset, String, Option<usize>)> = det
        .pairs
        .iter()
        .filter_map(|p| p.water.as_ref().filter(|w| w.format == Format::Twix).map(|w| (w.clone(), folder(w), None)))
        .chain(
            water
                .iter()
                .enumerate()
                .filter_map(|(wi, w)| w.as_ref().filter(|w| w.format == Format::Twix).map(|w| (w.clone(), folder(w), Some(wi)))),
        )
        .collect();
    for (w, wf, unpaired) in &twix_sources {
        let wlow = w.name.to_ascii_lowercase();
        let rf_off = wlow.ends_with("_onlyrfoff") || wlow.ends_with("_rfoff");
        if !rf_off && twix_effective_water_protocol(w).is_some_and(|proto| scanner_twix_scopes.contains(&(wf.clone(), proto))) {
            continue;
        }
        if twix_sources.iter().filter(|(_, other_dir, _)| other_dir == wf).count() != 1 {
            continue;
        }
        let Some(wmeta) = twix_meta(w) else { continue };
        let targets: Vec<usize> = (0..det.pairs.len())
            .filter(|&k| {
                det.pairs[k].water.is_none()
                    && det.pairs[k].metabolite.format == Format::Twix
                    && folder(&det.pairs[k].metabolite) == *wf
                    && twix_meta(&det.pairs[k].metabolite).is_some_and(|mmeta| twix_compatible(&wmeta, &mmeta))
            })
            .collect();
        for &k in &targets {
            det.pairs[k].water = Some(w.clone());
            det.pairs[k].water_shared = true;
        }
        if let (Some(wi), false) = (unpaired, targets.is_empty()) {
            water[*wi] = None;
        }
    }
    // Siemens twix scanner exports carry MID/FID counters around the protocol
    // name (`meas_MID310_STEAM_metab_FID115673` + `meas_MID312_STEAM_wref3_FID115675`).
    // Pair only a unique metabolite and unique water reference for that protocol
    // within the exact same folder and with non-conflicting twix acquisition
    // metadata (VOI, study, frame of reference, patient); leave ambiguous or
    // cross-folder references unpaired for manual assignment.
    let twix_water_matches = |w: &Dataset, proto: &str| {
        twix_effective_water_protocol(w).as_deref() == Some(proto)
    };
    let twix_metab_matches = |m: &Dataset, proto: &str| {
        twix_effective_metab_protocol(m).as_deref() == Some(proto)
    };
    let twix_waters: Vec<Option<(String, String)>> = water
        .iter()
        .map(|w| {
            w.as_ref().and_then(|w| {
                let proto = twix_effective_water_protocol(w)?;
                let wdir = dir_of(w).to_string();
                scanner_twix_scopes.contains(&(wdir.clone(), proto.clone())).then_some((wdir, proto))
            })
        })
        .collect();
    for (wi, candidate) in twix_waters.iter().enumerate() {
        let Some((wdir, proto)) = candidate else { continue };
        let water_count = water
            .iter()
            .flatten()
            .chain(det.pairs.iter().filter_map(|p| p.water.as_ref()))
            .filter(|w| dir_of(w) == wdir && twix_water_matches(w, proto))
            .count();
        if water_count != 1 {
            continue;
        }
        let metab_targets: Vec<usize> = (0..det.pairs.len())
            .filter(|&k| dir_of(&det.pairs[k].metabolite) == wdir && twix_metab_matches(&det.pairs[k].metabolite, proto))
            .collect();
        if let [k] = metab_targets[..] {
            if det.pairs[k].water.is_none()
                && water[wi].as_ref().is_some_and(|w| {
                    !conflicting_twix_acquisition(twix_acqs.get(&det.pairs[k].metabolite.files[0]), twix_acqs.get(&w.files[0]))
                })
            {
                det.pairs[k].water = water[wi].take();
            }
        }
    }
    let mut unpaired: Vec<Dataset> = water.into_iter().flatten().collect();
    // a lone water dataset is still data the user may want
    det.unpaired_water.append(&mut unpaired);
    det
}

/// Options for [`load_dataset`].
#[derive(Clone, Copy, Debug)]
pub struct LoadOptions {
    /// Subspectra for readers that cannot tell (GE, Philips): 2 for MEGA-PRESS.
    pub subspecs: usize,
    /// For Siemens IMA files without the needed header (io_loadspec_IMA):
    /// field strength (T), spectral width (Hz), te and tr (ms).
    pub ima_bo: Option<f64>,
    pub ima_sw: Option<f64>,
    pub ima_te: Option<f64>,
    pub ima_tr: Option<f64>,
}

impl Default for LoadOptions {
    fn default() -> Self {
        LoadOptions { subspecs: 1, ima_bo: None, ima_sw: None, ima_te: None, ima_tr: None }
    }
}

/// A loaded dataset: the FID-A structure, any water reference the file
/// itself carries (GE water frames, embedded twix water scans, Bruker
/// reference scans) and the voxel geometry when the header records it.
#[derive(Clone, Debug)]
pub struct Loaded {
    pub out: Spectra,
    pub embedded_water: Option<Spectra>,
    pub voxel: Option<Voxel>,
    /// Why a format that records the voxel gave none (GE: the header values).
    pub voxel_note: Option<String>,
}

/// Read one dataset with its reader.
pub fn load_dataset(ds: &Dataset, files: &[NamedFile], opts: &LoadOptions) -> Res<Loaded> {
    let f = |k: usize| -> Res<&NamedFile> { ds.files.get(k).and_then(|&i| files.get(i)).ok_or_else(|| "internal error: dataset file index".to_string()) };
    let one = |s: Spectra, voxel: Option<Voxel>| Loaded { out: s, embedded_water: None, voxel, voxel_note: None };
    match ds.format {
        Format::Twix => {
            let r = super::twix::load(f(0)?.bytes)?;
            let voxel = geometry::twix(&r.header);
            Ok(Loaded { out: r.out, embedded_water: r.out_w, voxel, voxel_note: None })
        }
        Format::GePfile => {
            let r = super::ge::load(f(0)?.bytes, opts.subspecs)?;
            Ok(Loaded { out: r.out, embedded_water: Some(r.out_w), voxel: r.voxel, voxel_note: r.voxel_note })
        }
        Format::SiemensRda => {
            let b = f(0)?.bytes;
            Ok(one(super::rda::load(b)?, geometry::rda(b)))
        }
        Format::NiftiMrs => {
            let b = f(0)?.bytes;
            Ok(one(super::niimrs::load(b)?, geometry::nifti(b)))
        }
        Format::PhilipsSdat => {
            let spar = f(1)?.bytes;
            let voxel = geometry::spar(&String::from_utf8_lossy(spar));
            Ok(one(super::sdat::load(f(0)?.bytes, spar, opts.subspecs)?, voxel))
        }
        Format::LcModelRaw => {
            let b = f(0)?.bytes;
            let t = text_prefix(b, 8192);
            let kind = if t.contains("NumberOfPoints") && t.contains("dwellTime") {
                super::lcmraw::RawType::Dat
            } else if t.contains("Sweep Width") {
                super::lcmraw::RawType::Raw
            } else {
                super::lcmraw::RawType::Sim
            };
            Ok(one(super::lcmraw::load(b, kind)?, None))
        }
        Format::SiemensDicom => load_dicom(ds, files, opts),
        Format::Bruker => load_bruker(ds, files),
    }
}

fn load_dicom(ds: &Dataset, files: &[NamedFile], opts: &LoadOptions) -> Res<Loaded> {
    let list: Vec<(String, &[u8])> = ds
        .files
        .iter()
        .map(|&i| (split_path(files[i].name).1.to_string(), files[i].bytes))
        .collect();
    match super::dicom_siemens::load_folder(&list) {
        Ok((s, _)) => {
            let voxel = list.first().and_then(|(_, b)| geometry::siemens_dicom(&super::dicom_siemens::protocol_text(b)));
            Ok(Loaded { out: s, embedded_water: None, voxel, voxel_note: None })
        }
        Err(e) => {
            // IMA files without a Phoenix protocol: io_loadspec_IMA needs the
            // acquisition parameters from the user
            if let (Some(bo), Some(sw)) = (opts.ima_bo, opts.ima_sw) {
                if list.len() == 1 {
                    return Ok(Loaded {
                        out: super::dicom_siemens::load_ima(list[0].1, bo, sw, opts.ima_te, opts.ima_tr)?,
                        embedded_water: None,
                        voxel: None,
                        voxel_note: None,
                    });
                }
            }
            Err(e)
        }
    }
}

fn load_bruker(ds: &Dataset, files: &[NamedFile]) -> Res<Loaded> {
    let scan: Vec<(String, &[u8])> = ds
        .files
        .iter()
        .map(|&i| {
            let (d, file) = split_path(files[i].name);
            let rel = match d.find("/pdata/") {
                Some(k) => format!("{}/{}", &d[k + 1..], file),
                None => file.to_string(),
            };
            (rel, files[i].bytes)
        })
        .collect();
    let r = super::bruker::load(&scan, true, 68)?;
    Ok(Loaded { out: r.out, embedded_water: r.ref_scan, voxel: None, voxel_note: None })
}

/// Everything in one call: the detected pairs, each loaded (metabolite and
/// water results are independent `Result`s so one bad file does not hide the
/// rest).
pub fn load_all(files: &[NamedFile], opts: &LoadOptions) -> (Detection, Vec<(Res<Loaded>, Option<Res<Loaded>>)>) {
    let det = detect(files);
    let loaded = det
        .pairs
        .iter()
        .map(|p| (load_dataset(&p.metabolite, files, opts), p.water.as_ref().map(|w| load_dataset(w, files, opts))))
        .collect();
    (det, loaded)
}

/// Decompress-aware check used by callers that want to know whether a file
/// is gzip-compressed NIfTI before reading it all.
pub fn looks_like_nifti(bytes: &[u8]) -> bool {
    is_nifti(bytes) || maybe_gunzip(bytes).map(|b| is_nifti(&b)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nf<'a>(name: &'a str, bytes: &'a [u8]) -> NamedFile<'a> {
        NamedFile { name, bytes }
    }

    #[test]
    fn mixed_dicom_folder_classifies_each_file_in_either_order() {
        let image = dicom_stub(false);
        let spectrum = dicom_stub(true);
        for files in [
            [nf("flat/image.dcm", &image), nf("flat/spec.dcm", &spectrum)],
            [nf("flat/spec.dcm", &spectrum), nf("flat/image.dcm", &image)],
        ] {
            let d = detect(&files);
            assert_eq!(d.pairs.len(), 1, "{d:?}");
            let names: Vec<_> = d.pairs[0].metabolite.files.iter().map(|&i| files[i].name).collect();
            assert_eq!(names, ["flat/spec.dcm"]);
        }
    }

    fn dicom_series(spectrum: bool, study: &str, series: &str, patient: &str, description: &str) -> Vec<u8> {
        let mut bytes = dicom_stub(spectrum);
        for (group, element, value) in [(0x0020u16, 0x000du16, study), (0x0020, 0x000e, series), (0x0010, 0x0020, patient), (0x0008, 0x103e, description)] {
            let mut value = value.as_bytes().to_vec();
            if value.len() % 2 != 0 { value.push(b' '); }
            bytes.extend_from_slice(&group.to_le_bytes());
            bytes.extend_from_slice(&element.to_le_bytes());
            bytes.extend_from_slice(b"LO");
            bytes.extend_from_slice(&(value.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&value);
        }
        bytes
    }

    fn with_series_number(mut bytes: Vec<u8>, number: &str) -> Vec<u8> {
        let mut value = number.as_bytes().to_vec();
        if value.len() % 2 != 0 { value.push(b' '); }
        bytes.extend_from_slice(&[0x20, 0, 0x11, 0, b'I', b'S']);
        bytes.extend_from_slice(&(value.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&value);
        bytes
    }

    #[test]
    fn flat_dicom_exports_group_by_series_and_pair_description_water() {
        let image = dicom_series(false, "study", "t1", "patient", "T1");
        let spectrum = dicom_series(true, "study", "spec", "patient", "press");
        let water = dicom_series(true, "study", "water", "patient", "press_ref");
        let files = [nf("flat/1.dcm", &image), nf("flat/2.dcm", &spectrum), nf("flat/3.dcm", &water), nf("flat/4.dcm", &spectrum), nf("flat/5.dcm", &image)];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 1, "{d:?}");
        assert_eq!(d.pairs[0].metabolite.files, [1, 3]);
        assert_eq!(d.pairs[0].water.as_ref().unwrap().files, [2]);
        assert_eq!(d.images, [Image { name: "T1".into(), files: vec![0, 4] }]);
    }

    #[test]
    fn dicom_series_descriptions_do_not_replace_existing_folder_water_names() {
        let bytes: Vec<_> = ["a", "b", "aw", "bw"].iter()
            .map(|series| dicom_series(true, "study", series, "patient", "PRESS")).collect();
        let files = [nf("session/a_act/1.dcm", &bytes[0]), nf("session/b_act/1.dcm", &bytes[1]), nf("session/a_ref/1.dcm", &bytes[2]), nf("session/b_ref/1.dcm", &bytes[3])];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 2, "{d:?}");
        assert_eq!(d.pairs[0].metabolite.name, "a_act");
        assert_eq!(d.pairs[0].water.as_ref().unwrap().files, [2]);
        assert_eq!(d.pairs[1].water.as_ref().unwrap().files, [3]);
    }

    #[test]
    fn dicom_grouping_never_merges_conflicting_studies_or_patients() {
        for series in ["series", ""] {
            let a = dicom_series(true, "study", series, "a", "press");
            let b = dicom_series(true, "other", series, "a", "press");
            let c = dicom_series(true, "study", series, "b", "press");
            let d = detect(&[nf("flat/a.dcm", &a), nf("flat/b.dcm", &b), nf("flat/c.dcm", &c)]);
            assert_eq!(d.pairs.iter().map(|p| p.metabolite.files.clone()).collect::<Vec<_>>(), [vec![0], vec![1], vec![2]]);
        }
    }

    #[test]
    fn ordinary_nifti_is_anatomy_but_damaged_mrs_is_not() {
        let mut bytes = nifti_stub();
        bytes[40..42].copy_from_slice(&3i16.to_le_bytes());
        bytes[70..72].copy_from_slice(&16i16.to_le_bytes());
        bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
        let d = detect(&[nf("T1.nii", &bytes)]);
        assert!(d.pairs.is_empty());
        assert_eq!(d.images, [Image { name: "T1".into(), files: vec![0] }]);
        bytes[328..331].copy_from_slice(b"mrs");
        let d = detect(&[nf("broken.nii", &bytes)]);
        assert!(d.images.is_empty());
        assert_eq!(d.pairs.len(), 1);
        bytes[328..331].fill(0);
        bytes[348] = 1;
        bytes[108..112].copy_from_slice(&368f32.to_le_bytes());
        bytes.extend_from_slice(&16i32.to_le_bytes());
        bytes.extend_from_slice(&44i32.to_le_bytes());
        let d = detect(&[nf("truncated.nii", &bytes)]);
        assert!(d.images.is_empty());
        assert_eq!(d.pairs.len(), 1);
    }

    #[test]
    fn pairs_by_name() {
        let raw = b" $SEQPAR\n hzpppm= 1\n $END\n $NMID\n $END\n 1 2\n".to_vec();
        let rda = b">>> Begin of header <<<\r\n".to_vec();
        let files = [
            nf("sub/metab.RAW", &raw),
            nf("sub/metab.H2O", &raw),
            nf("a.rda", &rda),
            nf("a_w.rda", &rda),
            nf("x.SDAT", b"...."),
            nf("x.SPAR", b"samples : 1"),
            nf("x_W.SDAT", b"...."),
            nf("x_W.SPAR", b"samples : 1"),
            nf("notes.txt", b"hello"),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 3, "{d:#?}");
        for p in &d.pairs {
            assert!(p.water.is_some(), "{p:#?}");
        }
        assert_eq!(d.ignored.len(), 1);
        let lcm = d.pairs.iter().find(|p| p.metabolite.format == Format::LcModelRaw).unwrap();
        assert_eq!(files[lcm.water.as_ref().unwrap().files[0]].name, "sub/metab.H2O");
    }

    #[test]
    fn subjects_in_folders_pair_within_each_subject() {
        let raw = b" $NMID\n $END\n 1 2\n".to_vec();
        let rda = b">>> Begin of header <<<\r\n".to_vec();
        // The same file names in every subject's folder, listed so that a
        // name-only match would pair sub-02's spectrum with sub-01's water.
        let files = [
            nf("group/sub-01/svs_w.rda", &rda),
            nf("group/sub-02/svs_w.rda", &rda),
            nf("group/sub-02/svs.rda", &rda),
            nf("group/sub-01/svs.rda", &rda),
            nf("group/sub-01/ses-1/mrs/press/metab.RAW", &raw),
            nf("group/sub-02/ses-1/mrs/press/metab.RAW", &raw),
            nf("group/sub-02/ses-1/mrs/press_ref/metab.H2O", &raw),
            nf("group/sub-01/ses-1/mrs/press_ref/metab.H2O", &raw),
            nf("group/sub-01/svs_dicom/a.IMA", &raw),
            nf("group/sub-01/svs_dicom_w/a.IMA", &raw),
            nf("group/sub-02/svs_dicom/a.IMA", &raw),
            nf("group/sub-02/svs_dicom_w/a.IMA", &raw),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 6, "{d:#?}");
        assert!(d.unpaired_water.is_empty(), "{d:#?}");
        for p in &d.pairs {
            let m = files[p.metabolite.files[0]].name;
            let w = files[p.water.as_ref().expect("paired").files[0]].name;
            let subject = |path: &str| path.split('/').nth(1).unwrap().to_string();
            assert_eq!(subject(m), subject(w), "{m} paired with {w}");
        }
    }

    fn nifti_stub() -> Vec<u8> {
        let mut b = vec![0u8; 352];
        b[..4].copy_from_slice(&348i32.to_le_bytes());
        for (i, dimension) in [4i16, 1, 1, 1, 1, 1, 1, 1].iter().enumerate() {
            b[40 + i * 2..42 + i * 2].copy_from_slice(&dimension.to_le_bytes());
        }
        b[70..72].copy_from_slice(&32i16.to_le_bytes());
        b[108..112].copy_from_slice(&352f32.to_le_bytes());
        b[344..348].copy_from_slice(b"n+1\0");
        b
    }

    /// A DICOM file with one element after the preamble: SpectroscopyData
    /// (5600,0020) or, for an image series, Modality (0008,0060).
    fn dicom_stub(spectrum: bool) -> Vec<u8> {
        let mut b = vec![0u8; 128];
        b.extend_from_slice(b"DICM");
        if spectrum {
            b.extend_from_slice(&[0x00, 0x56, 0x20, 0x00, b'O', b'F', 0, 0, 8, 0, 0, 0]);
            b.extend_from_slice(&[0u8; 8]);
        } else {
            b.extend_from_slice(&[0x08, 0x00, 0x60, 0x00, b'C', b'S', 2, 0, b'M', b'R']);
        }
        b
    }

    #[test]
    fn ve_spectrum_without_a_private_creator_label_is_kept() {
        // (7FE1,1010) OB with no (7FE1,0010) creator: the VE reader reads it directly.
        let mut b = vec![0u8; 128];
        b.extend_from_slice(b"DICM");
        b.extend_from_slice(&[0xe1, 0x7f, 0x10, 0x10, b'O', b'B', 0, 0, 8, 0, 0, 0]);
        b.extend_from_slice(&[0u8; 8]);
        assert!(dicom_has_spectrum(&b));
        assert!(!dicom_has_spectrum(&dicom_stub(false)));
    }

    #[test]
    fn an_image_series_is_available_for_anatomical_import() {
        let img = dicom_stub(false);
        let files = [nf("21-PRESS/a.dcm", &img), nf("21-PRESS/b.dcm", &img)];
        let d = detect(&files);
        assert!(d.pairs.is_empty(), "{d:#?}");
        assert!(d.ignored.is_empty());
        assert_eq!(d.images, [Image { name: "21-PRESS".into(), files: vec![0, 1] }]);
    }

    #[test]
    fn compressed_pixel_data_counts_as_pixel_data() {
        // Modality MR, then encapsulated Pixel Data: undefined length, one empty
        // item and the sequence delimiter, as JPEG and RLE transfer syntaxes write it.
        let mut b = dicom_stub(false);
        b.extend_from_slice(&[0xe0, 0x7f, 0x10, 0x00, b'O', b'B', 0, 0, 0xff, 0xff, 0xff, 0xff]);
        b.extend_from_slice(&[0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]);
        b.extend_from_slice(&[0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
        let d = super::super::dicom_siemens::parse_dicom(&b).unwrap();
        assert!(super::super::dicom_siemens::describe(&d).ends_with("with pixel data"), "{}", super::super::dicom_siemens::describe(&d));
    }

    #[test]
    fn act_and_ref_pair_in_every_format() {
        // spec2nii keeps Philips' names when it converts SDAT/SPAR pairs. Two
        // subjects share each folder, so only the names can pair them.
        let nii = nifti_stub();
        let rda = b">>> Begin of header <<<\r\n".to_vec();
        let files = [
            nf("mrs-nifti/sub-01_raw_act.nii.gz", &nii),
            nf("mrs-nifti/sub-02_raw_ref.nii.gz", &nii),
            nf("mrs-nifti/sub-01_raw_ref.nii.gz", &nii),
            nf("mrs-nifti/sub-02_raw_act.nii.gz", &nii),
            nf("rda/a_ws.rda", &rda),
            nf("rda/b_w.rda", &rda),
            nf("rda/a_w.rda", &rda),
            nf("rda/b_ws.rda", &rda),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 4, "{d:#?}");
        assert!(d.unpaired_water.is_empty(), "{d:#?}");
        for p in &d.pairs {
            let w = p.water.as_ref().expect("paired");
            assert_eq!(p.metabolite.name[..3], w.name[..3], "{p:#?}");
        }
    }

    #[test]
    fn a_session_folder_pairs_its_water_series() {
        // Siemens series exported with their own numbers and descriptions; the
        // water-unsuppressed series is named for its switched-off suppression,
        // and an image series of the same session is not a dataset.
        let spec = dicom_study("1.2.3", "subject-01");
        let spec2 = dicom_study("1.2.4", "subject-02");
        let image = dicom_stub(false);
        let files = [
            nf("sub-01/mrs/sub-01-20-PRESS_svs_se_30_ave/._1.dcm", &image),
            nf("sub-01/mrs/sub-01-20-PRESS_svs_se_30_ave/1.dcm", &spec),
            nf("sub-01/mrs/sub-01-20-PRESS_svs_se_30_ave/2.dcm", &spec),
            nf("sub-01/mrs/sub-01-21-PRESS_svs_se_30/1.dcm", &image),
            nf("sub-01/mrs/sub-01-22-PRESS_svs_se_30_water_off/1.dcm", &spec),
            nf("sub-02/mrs/sub-02-20-PRESS_svs_se_30_ave/1.dcm", &spec2),
            nf("sub-02/mrs/sub-02-22-PRESS_svs_se_30_water_off/1.dcm", &spec2),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 2, "{d:#?}");
        assert!(d.unpaired_water.is_empty(), "{d:#?}");
        for p in &d.pairs {
            let w = p.water.as_ref().expect("paired");
            assert!(p.metabolite.name.ends_with("_ave") && w.name.ends_with("_water_off"), "{p:#?}");
            assert_eq!(p.metabolite.name[..6], w.name[..6], "{p:#?}");
        }
        assert_eq!(d.images.len(), 1, "{d:#?}");
        assert!(files[d.images[0].files[0]].name.contains("-21-"), "{d:#?}");
    }

    #[test]
    fn a_water_series_serves_every_series_of_its_protocol() {
        // Siemens writes the averaged (`_ave`) and unaveraged series of one
        // acquisition beside the water-unsuppressed one; a second protocol in
        // the session must not take that water.
        for described in [true, false] {
            let series = |uid: &str, description: &str| if described {
                dicom_series(true, "1.2.3", uid, "subject-01", description)
            } else {
                dicom_study("1.2.3", "subject-01")
            };
            let ave = series("20", "PRESS_svs_se_30_ave");
            let raw = series("21", "PRESS_svs_se_30");
            let water = series("22", "PRESS_svs_se_30_water_off");
            let other = series("23", "PRESS_svs_se_144");
            let files = [
                nf("sub-01/mrs/sub-01-20-PRESS_svs_se_30_ave/1.dcm", &ave),
                nf("sub-01/mrs/sub-01-21-PRESS_svs_se_30/1.dcm", &raw),
                nf("sub-01/mrs/sub-01-22-PRESS_svs_se_30_water_off/1.dcm", &water),
                nf("sub-01/mrs/sub-01-23-PRESS_svs_se_144/1.dcm", &other),
            ];
            let d = detect(&files);
            assert!(d.unpaired_water.is_empty(), "{d:#?}");
            let water_of = |n: &str| d.pairs.iter().find(|p| files[p.metabolite.files[0]].name.contains(n)).unwrap().water.as_ref().map(|w| w.files.clone());
            assert_eq!(water_of("-20-"), Some(vec![2]), "{d:#?}");
            assert_eq!(water_of("-21-"), Some(vec![2]), "{d:#?}");
            assert_eq!(water_of("-23-"), None, "{d:#?}");
        }
    }

    #[test]
    fn a_water_series_paired_by_name_also_serves_the_averaged_series() {
        let series = |uid: &str, description: &str| dicom_series(true, "1.2.3", uid, "subject-01", description);
        let (plain, ave, water) = (series("21", "press"), series("20", "press_ave"), series("22", "press_water_off"));
        let files = [nf("flat/1.dcm", &plain), nf("flat/2.dcm", &ave), nf("flat/3.dcm", &water)];
        let d = detect(&files);
        assert!(d.unpaired_water.is_empty(), "{d:#?}");
        assert!(d.pairs.iter().all(|p| p.water.as_ref().is_some_and(|w| w.files == [2])), "{d:#?}");
        // Two water series of one protocol: neither is shared beyond its name match.
        let second = series("23", "press_water_off");
        let files = [nf("flat/1.dcm", &plain), nf("flat/2.dcm", &ave), nf("flat/3.dcm", &water), nf("flat/4.dcm", &second)];
        let d = detect(&files);
        let ave_pair = d.pairs.iter().find(|p| p.metabolite.files == [1]).unwrap();
        assert!(ave_pair.water.is_none(), "{d:#?}");
    }

    #[test]
    fn a_flat_folder_without_descriptions_names_no_protocol() {
        let series = |uid: &str| dicom_series(true, "1.2.3", uid, "subject-01", "");
        let (a, b, w) = (series("20"), series("21"), series("22"));
        let files = [nf("flat/press_water_off.dcm", &w), nf("flat/1.dcm", &a), nf("flat/2.dcm", &b)];
        let d = detect(&files);
        assert!(d.pairs.iter().all(|p| p.water.is_none()), "{d:#?}");
        assert_eq!(d.unpaired_water.len(), 1, "{d:#?}");
    }

    #[test]
    fn water_is_shared_only_within_one_flat_folder_and_without_rivals() {
        let series = |uid: &str, description: &str| dicom_series(true, "1.2.3", uid, "subject-01", description);
        let (plain, ave, water) = (series("21", "press"), series("20", "press_ave"), series("22", "press_water_off"));
        // Sibling flat exports of one study: run-b's averaged series stays without water.
        let ave_b = series("30", "press_ave");
        let files = [nf("root/run-a/1.dcm", &plain), nf("root/run-a/2.dcm", &water), nf("root/run-b/1.dcm", &ave_b)];
        let d = detect(&files);
        assert!(d.pairs.iter().find(|p| p.metabolite.files == [2]).unwrap().water.is_none(), "{d:#?}");
        // A second, undescribed water series makes the shared one ambiguous.
        let unknown = series("23", "");
        let files = [nf("flat/1.dcm", &plain), nf("flat/2.dcm", &ave), nf("flat/3.dcm", &water), nf("flat/4_water_off.dcm", &unknown)];
        let d = detect(&files);
        assert!(d.pairs.iter().find(|p| p.metabolite.files == [1]).unwrap().water.is_none(), "{d:#?}");
    }

    #[test]
    fn series_numbers_are_not_part_of_the_protocol() {
        assert_eq!(after_series_number("sub-01-20-PRESS_svs_se_30_ave", None, true), "PRESS_svs_se_30_ave");
        assert_eq!(after_series_number("20-PRESS", Some(20), false), "PRESS");
        assert_eq!(after_series_number("PRESS-2", Some(2), false), "PRESS-2");
        assert_eq!(after_series_number("press", None, false), "press");
        assert_eq!(after_series_number("PRESS-30-TE", Some(30), false), "PRESS-30-TE");
        assert_eq!(after_series_number("20-PRESS", None, false), "20-PRESS");
        assert_eq!(after_series_number("21-PRESS", Some(20), false), "21-PRESS");
        let series = |uid: &str, description: &str| with_series_number(dicom_series(true, "1.2.3", uid, "subject-01", description), uid);
        let (plain, ave, water) = (series("21", "21-press"), series("20", "20-press_ave"), series("22", "22-press_water_off"));
        let files = [nf("flat/1.dcm", &plain), nf("flat/2.dcm", &ave), nf("flat/3.dcm", &water)];
        let d = detect(&files);
        assert!(d.pairs.iter().all(|p| p.water.as_ref().is_some_and(|w| w.files == [2])), "{d:#?}");
    }

    #[test]
    fn hyphenated_protocol_parameters_do_not_share_water() {
        for described in [true, false] {
            let series = |number: &str, description: &str| with_series_number(
                dicom_series(true, "1.2.3", number, "subject-01", if described { description } else { "" }),
                number,
            );
            let ave = series("20", "PRESS-30-TE_ave");
            let raw = series("21", "PRESS-30-TE");
            let water = series("22", "PRESS-30-TE_water_off");
            let other = series("23", "PRESS-144-TE");
            let files = [
                nf("session/sub-01-20-PRESS-30-TE_ave/1.dcm", &ave),
                nf("session/sub-01-21-PRESS-30-TE/1.dcm", &raw),
                nf("session/sub-01-22-PRESS-30-TE_water_off/1.dcm", &water),
                nf("session/sub-01-23-PRESS-144-TE/1.dcm", &other),
            ];
            let d = detect(&files);
            for index in [0, 1] {
                assert_eq!(d.pairs.iter().find(|p| p.metabolite.files == [index]).unwrap().water.as_ref().map(|w| w.files.clone()), Some(vec![2]), "{d:#?}");
            }
            assert!(d.pairs.iter().find(|p| p.metabolite.files == [3]).unwrap().water.is_none(), "{d:#?}");
        }
    }

    #[test]
    fn unknown_numbered_prefixes_are_not_guessed() {
        let ave = dicom_series(true, "1.2.3", "20", "subject-01", "20-PRESS_ave");
        let raw = dicom_series(true, "1.2.3", "21", "subject-01", "21-PRESS");
        let water = dicom_series(true, "1.2.3", "22", "subject-01", "22-PRESS_water_off");
        let files = [nf("session/sub-01-20-PRESS_ave/1.dcm", &ave), nf("session/sub-01-21-PRESS/1.dcm", &raw), nf("session/sub-01-22-PRESS_water_off/1.dcm", &water)];
        let d = detect(&files);
        assert!(d.pairs.iter().all(|p| p.water.is_none()), "{d:#?}");
        assert_eq!(d.unpaired_water.len(), 1, "{d:#?}");
    }

    #[test]
    fn water_is_not_shared_with_a_different_known_voi() {
        let series = |number: &str, description: &str, z: i32| {
            let mut bytes = dicom_series(true, "1.2.3", number, "subject-01", description);
            let mut protocol = format!("ASCCONV BEGIN\nsSpecPara.sVoI.dReadoutFOV = 20\nsSpecPara.sVoI.dPhaseFOV = 20\nsSpecPara.sVoI.dThickness = 20\nsSpecPara.sVoI.sPosition.dTra = {z}\nASCCONV END\n").into_bytes();
            if protocol.len() % 2 != 0 { protocol.push(b' '); }
            bytes.extend_from_slice(&[0x29, 0, 0x20, 0x10, b'L', b'O']);
            bytes.extend_from_slice(&(protocol.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&protocol);
            bytes
        };
        let raw = series("20", "PRESS", 0);
        let ave = series("21", "PRESS_ave", 0);
        let water = series("22", "PRESS_water_off", 0);
        let other = series("23", "PRESS", 40);
        let voxel = |bytes: &[u8]| geometry::siemens_dicom(&super::super::dicom_siemens::protocol_text(bytes)).unwrap();
        assert_eq!(voxel(&raw).center_mm(), [0.0, 0.0, 0.0]);
        assert_eq!(voxel(&other).center_mm(), [0.0, 0.0, 40.0]);
        let files = [nf("session/sub-01-20-PRESS/1.dcm", &raw), nf("session/sub-01-21-PRESS_ave/1.dcm", &ave), nf("session/sub-01-22-PRESS_water_off/1.dcm", &water), nf("session/sub-01-23-PRESS/1.dcm", &other)];
        let d = detect(&files);
        for index in [0, 1] {
            assert_eq!(d.pairs.iter().find(|p| p.metabolite.files == [index]).unwrap().water.as_ref().map(|w| w.files.clone()), Some(vec![2]), "{d:#?}");
        }
        assert!(d.pairs.iter().find(|p| p.metabolite.files == [3]).unwrap().water.is_none(), "{d:#?}");
    }

    #[test]
    fn a_folder_of_several_spectra_keeps_an_unmatched_water_apart() {
        let rda = b">>> Begin of header <<<\r\n".to_vec();
        let files = [nf("flat/sub-01_svs.rda", &rda), nf("flat/sub-02_svs.rda", &rda), nf("flat/sub-03_svs_w.rda", &rda)];
        let d = detect(&files);
        assert!(d.pairs.iter().all(|p| p.water.is_none()), "{d:#?}");
        assert_eq!(d.unpaired_water.len(), 1, "{d:#?}");
    }

    #[test]
    fn unmatched_single_file_water_stays_unpaired() {
        let nii = nifti_stub();
        let rda = b">>> Begin of header <<<\r\n".to_vec();
        for (extension, bytes) in [("rda", &rda), ("nii", &nii)] {
            for suffix in ["water", "water_off"] {
                let spectrum = format!("flat/sub-01_svs.{extension}");
                let water = format!("flat/sub-02_{suffix}.{extension}");
                let files = [nf(&spectrum, bytes), nf(&water, bytes)];
                let d = detect(&files);
                assert_eq!(d.pairs.len(), 1, "{d:#?}");
                assert!(d.pairs[0].water.is_none(), "{d:#?}");
                assert_eq!(d.unpaired_water.len(), 1, "{d:#?}");
            }
        }
    }

    #[test]
    fn philips_water_suffixes_use_the_shared_naming_rule() {
        for suffix in ["ref", "w", "water", "water_off", "nows", "wref", "h2o"] {
            let water_data = format!("subject_{suffix}.sdat");
            let water_header = format!("subject_{suffix}.spar");
            let files = [
                nf("subject_act.sdat", b"data"),
                nf("subject_act.spar", b"! header"),
                nf(&water_data, b"data"),
                nf(&water_header, b"! header"),
            ];
            let d = detect(&files);
            assert_eq!(d.pairs.len(), 1, "{suffix}: {d:#?}");
            let water = d.pairs[0].water.as_ref().expect("water reference paired");
            assert_eq!(files[water.files[0]].name, water_data);
            assert!(d.unpaired_water.is_empty(), "{suffix}: {d:#?}");
        }
    }

    fn dicom_study(study: &str, patient: &str) -> Vec<u8> {
        let mut bytes = dicom_stub(true);
        for (group, element, vr, value) in [(0x0020u16, 0x000du16, b"UI", study), (0x0010, 0x0020, b"LO", patient)] {
            let mut value = value.as_bytes().to_vec();
            if value.len() % 2 != 0 {
                value.push(b' ');
            }
            bytes.extend_from_slice(&group.to_le_bytes());
            bytes.extend_from_slice(&element.to_le_bytes());
            bytes.extend_from_slice(vr);
            bytes.extend_from_slice(&(value.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&value);
        }
        bytes
    }

    #[test]
    fn fallback_requires_matching_dicom_study() {
        let spectrum = dicom_study("1.2.3", "subject-01");
        for (study, patient, paired) in [
            ("1.2.3", "subject-01", true),
            ("1.2.4", "subject-01", false),
            ("", "subject-01", false),
            ("1.2.3", "subject-02", false),
        ] {
            let water = dicom_study(study, patient);
            let files = [nf("session/20_PRESS_ave/1.dcm", &spectrum), nf("session/22_PRESS_water_off/1.dcm", &water)];
            let d = detect(&files);
            assert_eq!(d.pairs.len(), 1, "{d:#?}");
            assert_eq!(d.pairs[0].water.is_some(), paired, "{d:#?}");
            assert_eq!(d.unpaired_water.len(), usize::from(!paired), "{d:#?}");
        }
    }

    #[test]
    fn named_dicom_pairs_reject_conflicting_identifiers() {
        for name in ["20", "20_act", "20_ws"] {
            for (study, patient, water_study, water_patient, paired) in [
                ("1.2.3", "subject-01", "1.2.3", "subject-01", true),
                ("1.2.3", "subject-01", "1.2.4", "subject-01", false),
                ("1.2.3", "subject-01", "1.2.3", "subject-02", false),
                ("", "subject-01", "", "subject-02", false),
                ("1.2.3", "", "1.2.4", "", false),
                ("", "", "", "", true),
                ("1.2.3", "subject-01", "", "", true),
            ] {
                let spectrum = dicom_study(study, patient);
                let water = dicom_study(water_study, water_patient);
                let spectrum_path = format!("session/{name}/1.dcm");
                let files = [nf(&spectrum_path, &spectrum), nf("session/20_w/1.dcm", &water)];
                let d = detect(&files);
                assert_eq!(d.pairs.len(), 1, "{d:#?}");
                assert_eq!(d.pairs[0].water.is_some(), paired, "{name}: {d:#?}");
                assert_eq!(d.unpaired_water.len(), usize::from(!paired), "{d:#?}");
            }
        }
    }

    #[test]
    fn water_directories_and_bruker() {
        let files = [
            nf("press/acqp", b"##$ACQ"),
            nf("press/method", b"##$Method"),
            nf("press/fid", b"0000"),
            nf("press/pdata/1/2dseq", b"0000"),
            nf("press_w/acqp", b"##$ACQ"),
            nf("press_w/method", b"##$Method"),
            nf("press_w/fid", b"0000"),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 1, "{d:#?}");
        assert_eq!(d.pairs[0].metabolite.format, Format::Bruker);
        assert_eq!(d.pairs[0].metabolite.files.len(), 3);
        assert_eq!(d.pairs[0].water.as_ref().unwrap().name, "press_w");
        assert_eq!(d.ignored.len(), 1); // 2dseq
    }

    fn vb_twix(study: &str, voi_z: Option<i32>) -> Vec<u8> {
        let mut body = Vec::new();
        let nbufs: u32 = if voi_z.is_some() { 2 } else { 1 };
        body.extend_from_slice(&nbufs.to_le_bytes());
        let config = format!("<ParamString.\"StudyLOID\"> {{ \"{study}\" }}\n");
        body.extend_from_slice(b"Config\0");
        body.extend_from_slice(&(config.len() as u32).to_le_bytes());
        body.extend_from_slice(config.as_bytes());
        if let Some(z) = voi_z {
            let meas = format!(
                "### ASCCONV BEGIN ###\n\
                 sSpecPara.sVoI.dReadoutFOV = 20\n\
                 sSpecPara.sVoI.dPhaseFOV = 20\n\
                 sSpecPara.sVoI.dThickness = 20\n\
                 sSpecPara.sVoI.sPosition.dTra = {z}\n\
                 ### ASCCONV END ###\n"
            );
            body.extend_from_slice(b"MeasYaps\0");
            body.extend_from_slice(&(meas.len() as u32).to_le_bytes());
            body.extend_from_slice(meas.as_bytes());
        }
        let hdr_len = (4 + body.len()).max(10000) as u32;
        let mut twix = vec![0u8; hdr_len as usize + 16];
        twix[0..4].copy_from_slice(&hdr_len.to_le_bytes());
        twix[4..4 + body.len()].copy_from_slice(&body);
        twix
    }

    #[test]
    fn siemens_twix_scanner_names_pair_unique_same_folder_acquisitions() {
        let twix = vb_twix("study-1", Some(0));
        let files = [
            nf("sub-01/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("sub-01/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 1, "{d:#?}");
        assert_eq!(d.pairs[0].metabolite.name, "meas_MID310_STEAM_metab_FID115673");
        assert_eq!(d.pairs[0].water.as_ref().unwrap().name, "meas_MID312_STEAM_wref3_FID115675");
        assert!(d.unpaired_water.is_empty());

        let mismatched = [
            nf("meas_MID310_PRESS_metab_FID115673.dat", &twix),
            nf("meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let dm = detect(&mismatched);
        assert_eq!(dm.pairs.len(), 1);
        assert!(dm.pairs[0].water.is_none());
        assert_eq!(dm.unpaired_water.len(), 1);
    }

    #[test]
    fn siemens_twix_scanner_names_do_not_pair_across_folders_or_when_ambiguous() {
        let twix = vb_twix("study-1", Some(0));

        // Sibling subject folders must never cross-pair.
        let sibling = [
            nf("sub-01/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("sub-02/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let ds = detect(&sibling);
        assert_eq!(ds.pairs.len(), 1);
        assert!(ds.pairs[0].water.is_none(), "{ds:#?}");
        assert_eq!(ds.unpaired_water.len(), 1, "{ds:#?}");

        // Two metabolites + one water of the same protocol in one folder: ambiguous.
        let two_metabs = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/meas_MID320_STEAM_metab_FID115683.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let d2m = detect(&two_metabs);
        assert_eq!(d2m.pairs.len(), 2);
        assert!(d2m.pairs.iter().all(|p| p.water.is_none()), "{d2m:#?}");
        assert_eq!(d2m.unpaired_water.len(), 1, "{d2m:#?}");

        // One metabolite + two waters of the same protocol in one folder: ambiguous.
        let two_waters = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/meas_MID311_STEAM_wref1_FID115674.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let d2w = detect(&two_waters);
        assert_eq!(d2w.pairs.len(), 1);
        assert!(d2w.pairs[0].water.is_none(), "{d2w:#?}");
        assert_eq!(d2w.unpaired_water.len(), 2, "{d2w:#?}");

        // Conflicting VOI in the same folder must not auto-pair.
        let other_voi = vb_twix("study-1", Some(40));
        let diff_voi = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &other_voi),
        ];
        let dv = detect(&diff_voi);
        assert!(dv.pairs[0].water.is_none(), "{dv:#?}");
        assert_eq!(dv.unpaired_water.len(), 1, "{dv:#?}");

        // Folder-suffix sibling (`sub-01/` + `sub-01_w/`) must not bypass the scoped TWIX pass.
        let folder_suffix_bypass = [
            nf("sub-01/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("sub-01_w/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let dfb = detect(&folder_suffix_bypass);
        assert_eq!(dfb.pairs.len(), 1);
        assert!(dfb.pairs[0].water.is_none(), "{dfb:#?}");
        assert_eq!(dfb.unpaired_water.len(), 1, "{dfb:#?}");

        // Exact `_w` filename plus a second scanner-named reference in the same folder is ambiguous.
        let exact_w_plus_scanner = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/meas_MID310_STEAM_metab_FID115673_w.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let dew = detect(&exact_w_plus_scanner);
        assert_eq!(dew.pairs.len(), 1);
        assert!(dew.pairs[0].water.is_none(), "{dew:#?}");
        assert_eq!(dew.unpaired_water.len(), 2, "{dew:#?}");

        // Numbered non-scanner water alias (`STEAM_wref1.dat`) is classified as water and acts as a rival.
        let numbered_rival = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/STEAM_wref1.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &twix),
        ];
        let dnr = detect(&numbered_rival);
        assert_eq!(dnr.pairs.len(), 1, "{dnr:#?}");
        assert!(dnr.pairs[0].water.is_none(), "{dnr:#?}");
        assert_eq!(dnr.unpaired_water.len(), 2, "{dnr:#?}");

        // Scanner-named metabolite + single renamed numbered water alias in the same folder pairs cleanly.
        let mixed_unique = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/STEAM_wref1.dat", &twix),
        ];
        let dmu = detect(&mixed_unique);
        assert_eq!(dmu.pairs.len(), 1, "{dmu:#?}");
        assert_eq!(dmu.pairs[0].water.as_ref().unwrap().name, "STEAM_wref1");
        assert!(dmu.unpaired_water.is_empty());

        // Scanner-named metabolite + renamed metabolite + single water of the same protocol is ambiguous.
        let mixed_two_metabs = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/STEAM_metab.dat", &twix),
            nf("session/STEAM_w.dat", &twix),
        ];
        let dm2 = detect(&mixed_two_metabs);
        assert_eq!(dm2.pairs.len(), 2, "{dm2:#?}");
        assert!(dm2.pairs.iter().all(|p| p.water.is_none()), "{dm2:#?}");
        assert_eq!(dm2.unpaired_water.len(), 1, "{dm2:#?}");

        // Folder-suffix sibling with a scanner-named file lacking a water suffix must not cross-pair.
        let folder_water_scanner = [
            nf("session/STEAM_metab.dat", &twix),
            nf("session_w/meas_MID312_STEAM_FID115675.dat", &twix),
        ];
        let dfws = detect(&folder_water_scanner);
        assert_eq!(dfws.pairs.len(), 1, "{dfws:#?}");
        assert!(dfws.pairs[0].water.is_none(), "{dfws:#?}");
        assert_eq!(dfws.unpaired_water.len(), 1, "{dfws:#?}");

        // Conflicting StudyLOID in the same folder must not auto-pair.
        let other_study = vb_twix("study-2", Some(0));
        let diff_study = [
            nf("session/meas_MID310_STEAM_metab_FID115673.dat", &twix),
            nf("session/meas_MID312_STEAM_wref3_FID115675.dat", &other_study),
        ];
        let dst = detect(&diff_study);
        assert!(dst.pairs[0].water.is_none(), "{dst:#?}");
        assert_eq!(dst.unpaired_water.len(), 1, "{dst:#?}");
    }

    fn twix_stub(freq: f64, dwell: f64, pos_sag: f64) -> Vec<u8> {
        let cfg = format!(
            "### ASCCONV BEGIN ###\nsTXSPEC.asNucleusInfo[0].lFrequency = {freq}\nsRXSPEC.alDwellTime[0] = {dwell}\nsSpecPara.sVoI.dThickness = 20.0\nsSpecPara.sVoI.dPhaseFOV = 20.0\nsSpecPara.sVoI.dReadoutFOV = 32.0\nsSpecPara.sVoI.sPosition.dSag = {pos_sag}\nsSpecPara.sVoI.sPosition.dCor = 0.0\nsSpecPara.sVoI.sPosition.dTra = 0.0\nsSpecPara.sVoI.sNormal.dSag = 0.0\nsSpecPara.sVoI.sNormal.dCor = 0.0\nsSpecPara.sVoI.sNormal.dTra = 1.0\nsSpecPara.sVoI.dInPlaneRot = 0.0\n### ASCCONV END ###\n"
        );
        let mut body = Vec::new();
        body.extend_from_slice(&2u32.to_le_bytes());
        for name in ["Config", "MeasYaps"] {
            body.extend_from_slice(name.as_bytes());
            body.push(0);
            body.extend_from_slice(&(cfg.len() as u32).to_le_bytes());
            body.extend_from_slice(cfg.as_bytes());
        }
        // VD/VE single-RAID wrapper: id=0, nscans=1, 152-byte entry with offset=256.
        let offset = 256u64;
        let hdr_len = (4 + body.len()) as u32;
        let mut buf = vec![0u8; offset as usize];
        buf[0..4].copy_from_slice(&0u32.to_le_bytes());
        buf[4..8].copy_from_slice(&1u32.to_le_bytes());
        buf[16..24].copy_from_slice(&offset.to_le_bytes());
        buf[24..32].copy_from_slice(&(hdr_len as u64).to_le_bytes());
        buf.extend_from_slice(&hdr_len.to_le_bytes());
        buf.extend_from_slice(&body);
        buf
    }

    #[test]
    fn twix_onlyrfoff_is_water_and_shares_with_matching_folder_runs() {
        let cap = twix_stub(297208001.0, 83300.0, -39.0);
        let sal = twix_stub(297208001.0, 83300.0, -39.0);
        let water = twix_stub(297208001.0, 83300.0, -39.0);
        let other_voi = twix_stub(297208001.0, 83300.0, 12.0);
        let files = [
            nf("ses/meas_MID00115_FID179111_SV_Steam_Cap.dat", &cap),
            nf("ses/meas_MID00117_FID179113_SV_Steam_Saline.dat", &sal),
            nf("ses/meas_MID00118_FID179114_SV_Steam_OtherVOI.dat", &other_voi),
            nf("ses/meas_MID00116_FID179112_SV_Steam_OnlyRFoff.dat", &water),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 3, "{d:#?}");
        assert!(d.unpaired_water.is_empty(), "{d:#?}");
        assert_eq!(d.pairs[0].water.as_ref().unwrap().name, "meas_MID00116_FID179112_SV_Steam_OnlyRFoff");
        assert_eq!(d.pairs[1].water.as_ref().unwrap().name, "meas_MID00116_FID179112_SV_Steam_OnlyRFoff");
        assert!(d.pairs[2].water.is_none(), "different VOI must not share water");
    }

    #[test]
    fn twix_water_is_not_shared_when_two_water_files_exist() {
        let cap = twix_stub(297208001.0, 83300.0, -39.0);
        let w1 = twix_stub(297208001.0, 83300.0, -39.0);
        let w2 = twix_stub(297208001.0, 83300.0, -39.0);
        let files = [
            nf("ses/meas_MID00115_Cap.dat", &cap),
            nf("ses/meas_MID00116_OnlyRFoff.dat", &w1),
            nf("ses/meas_MID00119_rfoff.dat", &w2),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 1);
        assert!(d.pairs[0].water.is_none());
        assert_eq!(d.unpaired_water.len(), 2);
    }

    #[test]
    fn twix_water_is_not_shared_without_verified_voxel_geometry() {
        let twix_no_voi = |freq: f64, dwell: f64| -> Vec<u8> {
            let cfg = format!(
                "### ASCCONV BEGIN ###\nsTXSPEC.asNucleusInfo[0].lFrequency = {freq}\nsRXSPEC.alDwellTime[0] = {dwell}\n### ASCCONV END ###\n"
            );
            let mut body = Vec::new();
            body.extend_from_slice(&2u32.to_le_bytes());
            for name in ["Config", "MeasYaps"] {
                body.extend_from_slice(name.as_bytes());
                body.push(0);
                body.extend_from_slice(&(cfg.len() as u32).to_le_bytes());
                body.extend_from_slice(cfg.as_bytes());
            }
            let offset = 256u64;
            let hdr_len = (4 + body.len()) as u32;
            let mut buf = vec![0u8; offset as usize];
            buf[0..4].copy_from_slice(&0u32.to_le_bytes());
            buf[4..8].copy_from_slice(&1u32.to_le_bytes());
            buf[16..24].copy_from_slice(&offset.to_le_bytes());
            buf[24..32].copy_from_slice(&(hdr_len as u64).to_le_bytes());
            buf.extend_from_slice(&hdr_len.to_le_bytes());
            buf.extend_from_slice(&body);
            buf
        };
        let m1 = twix_no_voi(297208001.0, 83300.0);
        let m2 = twix_no_voi(297208001.0, 83300.0);
        let w = twix_no_voi(297208001.0, 83300.0);
        let files = [
            nf("ses/meas_MID00115_Cap.dat", &m1),
            nf("ses/meas_MID00117_Saline.dat", &m2),
            nf("ses/meas_MID00116_OnlyRFoff.dat", &w),
        ];
        let d = detect(&files);
        assert_eq!(d.pairs.len(), 2);
        assert!(d.pairs[0].water.is_none(), "must not share TWIX water when VOI geometry is absent");
        assert!(d.pairs[1].water.is_none(), "must not share TWIX water when VOI geometry is absent");
        assert_eq!(d.unpaired_water.len(), 1);

        // Named _onlyrfoff water in another subject folder must NEVER pair across subjects
        let cross_subject = [
            nf("sub-01/svs_steam.dat", &m1),
            nf("sub-02/svs_steam_onlyrfoff.dat", &w),
        ];
        let d_cross = detect(&cross_subject);
        assert_eq!(d_cross.pairs.len(), 1);
        assert!(d_cross.pairs[0].water.is_none(), "must not pair TWIX water across subject folders");
        assert_eq!(d_cross.unpaired_water.len(), 1);
    }
}
