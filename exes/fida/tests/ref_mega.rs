//! run_megapressproc_auto against FID-A (validation/ref_mega.m) on FID-A's
//! Siemens MEGA-PRESS example, and (validation/ref_mega_philips.m) on
//! Osprey's Philips MEGA-PRESS example.
mod common;
use common::*;
use fida::ops::pipeline::{run_megapressproc_auto, MegaOptions};

#[test]
fn siemens_mega_pipeline_matches_fida() {
    let Some(d) = data_dir("siemens_mega") else { return };
    pipeline_matches(&d, 1e-5, 1e-6);
}

#[test]
fn philips_mega_pipeline_matches_fida() {
    let Some(d) = data_dir("philips_mega") else { return };
    // 293 of the 294 cumulative frequency corrections agree to 2.2e-6 Hz; one
    // edit-ON transient of these single-channel data agrees to 8.9e-5 Hz. That
    // one transient's phase error, averaged over 147, is the 1.7e-6 relative
    // difference of the spectra and the 1.3e-5 deg of ph0.
    pipeline_matches(&d, 1e-4, 1e-5);
}

/// The app's Philips path (read, drop the empty water rows, split alternate
/// rows, classify) gives exactly what FID-A's io_loadspec_sdat(..., 2) gives.
#[test]
fn philips_mega_split_matches_fida_reader() {
    use fida::io::sdat;
    use fida::ops::editing::{classify_mega, drop_empty_transients, split_alternate, to_fida_layout};
    let Some(d) = data_dir("philips_mega") else { return };
    let Ok(pd) = std::env::var("PHILIPS_MEGA") else {
        skip("PHILIPS_MEGA is not set");
        return;
    };
    let read = |stem: &str| sdat::load(&std::fs::read(format!("{pd}/{stem}.sdat")).unwrap(), &std::fs::read(format!("{pd}/{stem}.spar")).unwrap(), 1).unwrap();
    let water = drop_empty_transients(&read("sub-01_megapress_ref"));
    compare("raww", &water, &load(&d.join("raww")), 1e-15);
    let pairs = split_alternate(&read("sub-01_megapress_act")).unwrap();
    let check = classify_mega(&pairs, Some(&water)).unwrap();
    assert!(check.edited() && check.off_first && check.inverted, "{check:?}");
    let want = load(&d.join("raw"));
    compare("raw", &to_fida_layout(&pairs, &check), &want, 1e-15);
    // Every other storage layout (edit-ON first, not inverted, both: what GE
    // or another protocol may write) is classified back to the same layout.
    let half = pairs.fids.len() / 2;
    for (swap, flip) in [(true, false), (false, true), (true, true)] {
        let mut v = pairs.clone();
        if flip {
            v.fids[..half].iter_mut().for_each(|z| *z = -*z);
        }
        if swap {
            let (a, b) = v.fids.split_at_mut(half);
            a.swap_with_slice(b);
        }
        let c = classify_mega(&v, Some(&water)).unwrap();
        assert_eq!((c.off_first, c.inverted), (!swap, !flip), "swap {swap} flip {flip}");
        let mut got = to_fida_layout(&v, &c);
        // An inverted pair is equivalent up to the sign of both subspectra.
        if got.fids[0].re * want.fids[0].re < 0.0 {
            got.fids.iter_mut().for_each(|z| *z = -*z);
        }
        compare("layout", &got, &want, 1e-15);
    }
}

fn pipeline_matches(d: &std::path::Path, drift_tol: f64, spectra_tol: f64) {
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));
    let t0 = std::time::Instant::now();
    let r = run_megapressproc_auto(&raw, Some(&raww), &MegaOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    eprintln!("MEGA-PRESS pipeline: {:.2} s", t0.elapsed().as_secs_f64());
    let rep = &r.report;
    let removed = rep.rm_bad_averages.as_ref().unwrap().removed.len() * 2;
    assert_eq!(removed, v.f("rm_total") as usize, "removed transients");
    let drift = rep.drift.as_ref().unwrap();
    assert_eq!(drift.iterations, v.f("aa_iterations") as usize);
    let dfs = max_abs_diff(&drift.freq, &v.vec("fscum"));
    let dph = max_abs_diff(&drift.phase, &v.vec("phscum"));
    eprintln!("cumulative drift: max |dfs| {dfs:.2e} Hz, max |dphs| {dph:.2e} deg");
    assert!(dfs < drift_tol && dph < 1e-4);
    eprintln!("ph0 {} vs {}; subspectrum alignment {} Hz {} deg vs {} {}", rep.ph0, v.f("ph0"), rep.isis_freq[0], rep.isis_phase[0], v.f("ss_fs"), v.f("ss_phs"));
    assert!((rep.ph0 - v.f("ph0")).abs() < 1e-4);
    assert!((rep.isis_freq[0] - v.f("ss_fs")).abs() < 1e-5);
    assert!((rep.isis_phase[0] - v.f("ss_phs")).abs() < 1e-4);
    assert!((rep.freq_shift - v.f("frqShift")).abs() < 1e-6);
    for (name, got) in [("diff", &r.diff), ("sum", &r.sum), ("sub1", &r.sub1), ("sub2", &r.sub2)] {
        compare(name, got, &load(&d.join(name)), spectra_tol);
    }
    compare("outw", r.outw.as_ref().unwrap(), &load(&d.join("outw")), spectra_tol);
}
