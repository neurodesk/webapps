//! Siemens .rda (syngo spectroscopy export): FID-A `io_loadspec_rda`.
//!
//! Quirks kept from FID-A: the data are conjugated (`fids = fids'`), the ppm
//! axis is centred on 4.6082 (not 4.65), `seq` and `date` are the raw header
//! text after the colon (leading blank and line ending included), `averages`
//! is 1 and `rawAverages` the header's NumberOfAverages. FID-A stores the
//! text 'na' in rawSubspecs and 'N/A' in pointsToLeftshift; here they are 1
//! and 0. Only single-voxel files can be read (FID-A reads
//! CSIMatrixSize[0]^3 voxels and cannot transpose more than one).

use super::common::{fresh_flags, octave_range, str2num, time_axis, Bytes, Res};
use crate::spectra::{Dims, Spectra};
use num_complex::Complex64;

const BEGIN: &str = ">>> Begin of header <<<";
const END: &str = ">>> End of header <<<";

/// The header fields FID-A keeps.
#[derive(Clone, Debug, Default)]
pub struct RdaHeader {
    pub study_date: Option<String>,
    pub sequence_description: Option<String>,
    pub te: Option<f64>,
    pub tm: Option<f64>,
    pub tr: Option<f64>,
    pub dwell_time: Option<f64>,
    pub number_of_averages: Option<f64>,
    pub mr_frequency: Option<f64>,
    pub magnetic_field_strength: Option<f64>,
    pub vector_size: Option<f64>,
    pub csi_matrix: [Option<f64>; 3],
}

fn first_num(v: &str) -> Option<f64> {
    str2num(v).and_then(|x| x.first().copied())
}

/// FID-A `io_loadspec_rda(rda_filename)` on the bytes of an .rda file.
pub fn load(data: &[u8]) -> Res<Spectra> {
    // the header is text; find its end line
    let mut pos = 0usize;
    let next_line = |pos: &mut usize| -> Option<(String, usize)> {
        if *pos >= data.len() {
            return None;
        }
        let rest = &data[*pos..];
        let len = rest.iter().position(|&c| c == b'\n').map(|k| k + 1).unwrap_or(rest.len());
        let line: String = rest[..len].iter().map(|&c| c as char).collect();
        let start = *pos;
        *pos += len;
        Some((line, start))
    };
    let (first, _) = next_line(&mut pos).ok_or("This .rda file is empty.")?;
    if !first.contains(BEGIN) && !first.contains(END) {
        // FID-A does not check the first line; a file without the markers
        // runs to the end of the file in FID-A without finding the header end.
        if !data.windows(END.len()).any(|w| w == END.as_bytes()) {
            return Err("This is not a Siemens .rda file (no '>>> End of header <<<' line).".into());
        }
    }
    let mut h = RdaHeader::default();
    let mut line = first;
    while !line.contains(END) {
        let (l, _) = next_line(&mut pos).ok_or("This .rda file has no '>>> End of header <<<' line.")?;
        line = l;
        if !line.contains(BEGIN) && !line.contains(END) {
            let Some(colon) = line.find(':') else { continue };
            let variable = &line[..colon];
            let value = &line[colon + 1..];
            match variable {
                "StudyDate" => h.study_date = Some(value.to_string()),
                "SequenceDescription" => h.sequence_description = Some(value.to_string()),
                "TE" => h.te = first_num(value),
                "TM" => h.tm = first_num(value),
                "TR" => h.tr = first_num(value),
                "DwellTime" => h.dwell_time = first_num(value),
                "NumberOfAverages" => h.number_of_averages = first_num(value),
                "MRFrequency" => h.mr_frequency = first_num(value),
                "MagneticFieldStrength" => h.magnetic_field_strength = first_num(value),
                "VectorSize" => h.vector_size = first_num(value),
                "CSIMatrixSize[0]" => h.csi_matrix[0] = first_num(value),
                "CSIMatrixSize[1]" => h.csi_matrix[1] = first_num(value),
                "CSIMatrixSize[2]" => h.csi_matrix[2] = first_num(value),
                _ => {}
            }
        }
    }
    let need = |v: Option<f64>, k: &str| v.ok_or_else(|| format!("The .rda header has no numeric {k}."));
    let vs = need(h.vector_size, "VectorSize")?;
    let c0 = need(h.csi_matrix[0], "CSIMatrixSize[0]")?;
    let c1 = need(h.csi_matrix[1], "CSIMatrixSize[1]")?;
    let c2 = need(h.csi_matrix[2], "CSIMatrixSize[2]")?;
    if !(vs >= 1.0 && vs.fract() == 0.0 && vs < 1e8) {
        return Err(format!("The .rda header gives VectorSize {vs}."));
    }
    if c0 != 1.0 || c1 != 1.0 || c2 != 1.0 {
        return Err(format!(
            "This .rda file holds a {c0}x{c1}x{c2} CSI grid; FID-A's io_loadspec_rda reads single-voxel files only."
        ));
    }
    let n = vs as usize;
    let b = Bytes::new(&data[pos..], ".rda");
    let raw = b.slice(0, 16 * n).map_err(|_| {
        format!("This .rda file is truncated: the header announces {n} complex points but fewer follow the header.")
    })?;
    let rd = |k: usize| f64::from_le_bytes(raw[8 * k..8 * k + 8].try_into().unwrap());
    let fids: Vec<Complex64> = (0..n).map(|k| Complex64::new(rd(2 * k), rd(2 * k + 1)).conj()).collect();

    let dwelltime = need(h.dwell_time, "DwellTime")? / 1000000.0;
    let spectralwidth = 1.0 / dwelltime;
    let txfrq = need(h.mr_frequency, "MRFrequency")? * 1000000.0;
    let bo = need(h.magnetic_field_strength, "MagneticFieldStrength")?;
    let raw_averages = need(h.number_of_averages, "NumberOfAverages")?;
    let nf = n as f64;
    let f = octave_range(
        (-spectralwidth / 2.0) + (spectralwidth / (2.0 * nf)),
        spectralwidth / nf,
        (spectralwidth / 2.0) - (spectralwidth / (2.0 * nf)),
    );
    let ppm: Vec<f64> = f.iter().map(|&x| -x / (bo * 42.577) + 4.6082).collect();
    let mut flags = fresh_flags();
    flags.averaged = true;
    flags.addedrcvrs = true;
    Ok(Spectra {
        fids,
        sz: vec![n, 1],
        dims: Dims { t: 1, ..Dims::default() },
        ppm,
        t: time_axis(dwelltime, n),
        spectralwidth,
        dwelltime,
        txfrq,
        te: need(h.te, "TE")?,
        tm: h.tm.filter(|&v| v.is_finite() && v > 0.0),
        tr: need(h.tr, "TR")?,
        bo,
        seq: h.sequence_description.clone().ok_or("The .rda header has no SequenceDescription.")?,
        date: h.study_date.clone().ok_or("The .rda header has no StudyDate.")?,
        averages: 1,
        raw_averages: if raw_averages >= 0.0 { raw_averages as usize } else { 0 },
        subspecs: 1,
        raw_subspecs: 1,
        points_to_leftshift: 0.0,
        flags,
        nucleus: "1H".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_garbage() {
        assert!(load(b"").is_err());
        assert!(load(b"hello\nworld\n").is_err());
        assert!(load(b">>> Begin of header <<<\r\nVectorSize: 4\r\n>>> End of header <<<\r\n").is_err());
    }

    fn minimal_rda(tm: Option<f64>) -> Vec<u8> {
        let mut hdr = String::from(
            ">>> Begin of header <<<\r\n\
             StudyDate: 20240101\r\n\
             SequenceDescription: svs_st\r\n\
             TE: 8.0\r\n\
             TR: 5000.0\r\n\
             DwellTime: 250.0\r\n\
             NumberOfAverages: 64\r\n\
             MRFrequency: 297.22\r\n\
             MagneticFieldStrength: 7.0\r\n\
             VectorSize: 4\r\n\
             CSIMatrixSize[0]: 1\r\n\
             CSIMatrixSize[1]: 1\r\n\
             CSIMatrixSize[2]: 1\r\n",
        );
        if let Some(tm) = tm {
            hdr.push_str(&format!("TM: {tm}\r\n"));
        }
        hdr.push_str(">>> End of header <<<\r\n");
        let mut bytes = hdr.into_bytes();
        for k in 0..4 {
            bytes.extend_from_slice(&(1.0f64 / (k as f64 + 1.0)).to_le_bytes());
            bytes.extend_from_slice(&0.0f64.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn reads_mixing_time_when_positive() {
        let s = load(&minimal_rda(Some(32.0))).unwrap();
        assert_eq!(s.te, 8.0);
        assert_eq!(s.tm, Some(32.0));

        assert_eq!(load(&minimal_rda(Some(0.0))).unwrap().tm, None);
        assert_eq!(load(&minimal_rda(None)).unwrap().tm, None);
    }
}
