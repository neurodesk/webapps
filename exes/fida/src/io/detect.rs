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
//! * `<stem>_w`, `<stem>_ref`, `<stem>_wref`, `<stem>_water`, `<stem>_h2o`
//!   (file stem or containing directory) pair with `<stem>`;
//! * Philips `<stem>_w` pairs with `<stem>_ws`; `<stem>_ref` with `<stem>_act`;
//! * LCModel `<stem>.H2O` pairs with `<stem>.RAW`;
//! * GE P-files carry their own water frames, and some twix sequences
//!   (CMRR / Columbia sLASER) their own water scans.

use super::common::{maybe_gunzip, Res};
use super::geometry::{self, Voxel};
use crate::spectra::Spectra;

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
}

/// Result of [`detect`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Detection {
    pub pairs: Vec<Pairing>,
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
        return Some(Format::NiftiMrs);
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

const WATER_SUFFIXES: [&str; 5] = ["_w", "_ref", "_wref", "_water", "_h2o"];

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
                let low = stem.to_ascii_lowercase();
                let is_water = (low.ends_with("_w") && !low.ends_with("_ws")) || low.ends_with("_ref") || low.ends_with("_water");
                datasets.push(Dataset { format: Format::PhilipsSdat, files: vec![i, j], name: stem, is_water });
            }
            None => {
                used[i] = true;
                det.ignored.push((files[i].name.to_string(), "SDAT file without its SPAR header (same name, .SPAR)".into()));
            }
        }
    }

    // DICOM: one series per directory
    let mut dicom_dirs: Vec<(String, Vec<usize>)> = Vec::new();
    for i in 0..files.len() {
        if used[i] || sniff(files[i].name, files[i].bytes) != Some(Format::SiemensDicom) {
            continue;
        }
        used[i] = true;
        let (d, _) = split_path(files[i].name);
        match dicom_dirs.iter_mut().find(|(x, _)| x == d) {
            Some((_, v)) => v.push(i),
            None => dicom_dirs.push((d.to_string(), vec![i])),
        }
    }
    for (d, v) in dicom_dirs {
        let name = if d.is_empty() { stem_of(split_path(files[v[0]].name).1) } else { split_path(&d).1.to_string() };
        datasets.push(Dataset { format: Format::SiemensDicom, files: v, is_water: water_base(&name).is_some(), name });
    }

    // single-file formats
    for i in 0..files.len() {
        if used[i] {
            continue;
        }
        let (d, file) = split_path(files[i].name);
        let ext = ext_lower(file);
        match sniff(files[i].name, files[i].bytes) {
            Some(fmt) => {
                used[i] = true;
                let stem = stem_of(file);
                let dir_water = water_base(split_path(d).1).is_some();
                let is_water = match fmt {
                    Format::LcModelRaw => ext == "h2o" || water_base(&stem).is_some(),
                    Format::GePfile => false,
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
    let key = |ds: &Dataset| -> (Format, String) { (ds.format, ds.name.to_ascii_lowercase()) };
    let (water, metab): (Vec<Dataset>, Vec<Dataset>) = datasets.into_iter().partition(|d| d.is_water);
    let mut water: Vec<Option<Dataset>> = water.into_iter().map(Some).collect();
    for m in metab {
        let (fmt, mname) = key(&m);
        let mpath = split_path(files[m.files[0]].name).0;
        let mdir = split_path(mpath).1.to_ascii_lowercase();
        let mut best: Option<(usize, usize)> = None;
        for (wi, w) in water.iter().enumerate() {
            let Some(w) = w else { continue };
            if w.format != fmt {
                continue;
            }
            let wname = w.name.to_ascii_lowercase();
            let wdir = split_path(split_path(files[w.files[0]].name).0).1.to_ascii_lowercase();
            let hit = match fmt {
                Format::LcModelRaw => wname == mname || water_base(&wname).as_deref() == Some(&mname),
                Format::PhilipsSdat => {
                    let wb = wname.strip_suffix("_w").or_else(|| wname.strip_suffix("_ref")).or_else(|| wname.strip_suffix("_water"));
                    let mb = mname.strip_suffix("_ws").or_else(|| mname.strip_suffix("_act")).unwrap_or(&mname);
                    wb == Some(mb)
                }
                _ => {
                    water_base(&wname).as_deref() == Some(&mname)
                        || (!mdir.is_empty() && water_base(&wdir).as_deref() == Some(&mdir))
                }
            };
            if hit {
                let shared = shared_dirs(mpath, split_path(files[w.files[0]].name).0);
                if best.is_none_or(|(_, s)| shared > s) {
                    best = Some((wi, shared));
                }
            }
        }
        let w = best.and_then(|(k, _)| water[k].take());
        det.pairs.push(Pairing { metabolite: m, water: w });
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
}

/// Read one dataset with its reader.
pub fn load_dataset(ds: &Dataset, files: &[NamedFile], opts: &LoadOptions) -> Res<Loaded> {
    let f = |k: usize| -> Res<&NamedFile> { ds.files.get(k).and_then(|&i| files.get(i)).ok_or_else(|| "internal error: dataset file index".to_string()) };
    let one = |s: Spectra, voxel: Option<Voxel>| Loaded { out: s, embedded_water: None, voxel };
    match ds.format {
        Format::Twix => {
            let r = super::twix::load(f(0)?.bytes)?;
            let voxel = geometry::twix(&r.header);
            Ok(Loaded { out: r.out, embedded_water: r.out_w, voxel })
        }
        Format::GePfile => {
            let r = super::ge::load(f(0)?.bytes, opts.subspecs)?;
            Ok(Loaded { out: r.out, embedded_water: Some(r.out_w), voxel: None })
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
            Ok(Loaded { out: s, embedded_water: None, voxel })
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
    Ok(Loaded { out: r.out, embedded_water: r.ref_scan, voxel: None })
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
}
