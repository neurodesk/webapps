//! Final output: tables, .COORD, .CSV, and the diagnostics table (FINOUT, EXITPS, ERRTBL).
//!
//! Translated from LCModel.f 6.3-1N; see PORTING.md.
#![allow(unused_variables, unused_mut, unused_assignments, unused_imports, unreachable_code, unused_labels, clippy::all)]

use crate::control::ilen;
use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::*;
use crate::io::{self, Units, STDOUT};
use crate::numerics::{cfft_r, cfftin, plprin};
use crate::state::*;
use crate::tworeg::nextre;
use crate::{fv, ErrQueue, Lcm};

/// Excel allows up to 256 columns, so MCSV <= 254/3.
const MCSV: i32 = 84;
const LEN_CSV_LINE: usize = (MCSV * 56 + 10) as usize;

/// SAVEd and static locals of this module's subprograms. FINOUT keeps
/// DAPOSI, INCLUD, ERRCON, csv_line and dwork in blank COMMON, so they
/// persist between calls.
#[derive(Clone, Debug)]
pub struct Saves {
    /// FINOUT `first_row` (DATA .TRUE.).
    pub first_row: bool,
    pub daposi: FArr2<f64>,
    pub includ: FArr1<bool>,
    pub errcon: FArr1<f32>,
    pub csv_line: FArr1<FStr>,
    pub dwork: FArr1<f64>,
}

impl Default for Saves {
    fn default() -> Self {
        Saves {
            first_row: true,
            daposi: FArr2::new(MPAR as usize, MPAR as usize),
            includ: FArr1::new(MPAR as usize),
            errcon: FArr1::new(MCONC as usize),
            csv_line: fstr_arr1(2, LEN_CSV_LINE),
            dwork: FArr1::new(MDWORK_FINOUT as usize),
        }
    }
}

// FORMATs written to the .COORD and .TABLE files.
const F5581: &str = "(1X,I2,' lines in following concentration table = NCONC+1')";
const F6581: &str = "(/'$$CONC',I3, ' lines in following concentration table = NCONC+1')";
const F5582: &str = "(3X, 'Conc.', 2X, '%SD', ' /', A6, 2X, 'Metab.')";
const F5583: &str = "(3X, 'Conc.', 2X, '%SD', '   /', A4, 2X, 'Metab.')";
const F5584: &str = "(3X, 'Conc.', 2X, '%SD', ' /', A6, 2X, 'Metabolite')";
const F5585: &str = "(3X, 'Conc.', 2X, '%SD', '   /', A4, 2X, 'Metabolite')";
const F5590: &str = "(1X,A)";
const F5591: &str = "(' FWHM =', F6.3, ' ppm', 4X, 'S/N =', I4)";
const F5593: &str = "(' Data shift =', F6.3, ' ppm')";
const F5594: &str = "(' alphaB,S =',1PE8.1, ',', E10.1)";
const F5595: &str = "(' Ph:', I4, ' deg', f10.1, ' deg/ppm')";
const F5596: &str = "(1X,I3, ' spline knots.', 3X, 'Ns =', I2, '(', I1, ')')";
const F5597: &str = "(1X, I2, ' inflections.',  I6, ' extrema')";
const F5598: &str = "(' (', I2, ')', I2, ' infls.', 2X, ' (', I2, ')', I2, ' extrs.')";
const F5602: &str = "(1X,I3, ' lines in following misc. output table')";
const F5610: &str = "(1X,I4,' points on ppm-axis = NY'/(1X,10F13.6))";
const F5620: &str = "(' NY phased data points follow'/(1X,1P10E13.5))";
const F5630: &str = "(' NY points of the fit to the data follow'/ (1X,1P10E13.5))";
const F5640: &str = "(' NY background values follow'/(1X,1P10E13.3))";
const F5660: &str = "(1X, A6, '   Conc. =', 1PE9.2/ (1X,10E13.5))";
const F5662: &str = "(/'$$MISC',I3, ' lines in following misc. output table')";
const F5120: &str = "(1X,I3, ' lines in following diagnostic table:'/(A))";
const F5130: &str = "(1X, I3, ' lines in following table of input changes:'/ (A))";
const F5122: &str = "(/'$$DIAG',I3, ' lines in following diagnostic table:'/(A))";
const F5132: &str = "(/'$$INPU', I3, ' lines in following table of input changes:'/ (A))";

/// EFORM(TERM): E format for a table entry.
fn eform(term: f32) -> bool {
    (term.abs() > 999.999 || term.abs() < 0.0995) && term != 0.0
}

/// A REAL as gfortran writes it in NAMELIST (and list-directed) output:
/// a separator blank, then G15.9 (four trailing blanks), or 1PE15.8E2 when
/// |x| is outside [0.1, 1E9).
fn nml_real(x: f32) -> String {
    let m = x.abs();
    let r = 0.5f32;
    let exp_d = 1.0e9f32;
    let rexp_d = 1.0 / exp_d;
    let field = if m != 0.0 && (m < 0.1 - 0.1 * r * rexp_d || m >= exp_d - r) {
        format::fmt_e(x as f64, 15, 8, Some(2), 1, false, 'E', true)
    } else {
        format::fmt_g(x as f64, 15, 9, Some(2), 0, false, true)
    };
    format!(" {field}")
}

fn nml_log(b: bool) -> &'static str {
    if b {
        "T"
    } else {
        "F"
    }
}

/// REVERS (X, N): reverse the order of X(1..N).
pub fn revers(x: &mut [f32], n: i32) {
    let mut k = n;
    for j in 1..=n / 2 {
        let term = x[(k - 1) as usize];
        x[(k - 1) as usize] = x[(j - 1) as usize];
        x[(j - 1) as usize] = term;
        k = k - 1;
    }
}

impl Lcm {
    /// FINOUT: final summary (concentration table, ratios, .TABLE, .COORD,
    /// .PRINT and .CSV outputs).
    pub fn finout(&mut self) -> R<()> {
        const CHSUBP: &str = "FINOUT";
        let mut phiold = [0.0f64; 2];
        let mut ierror = 0i32;
        let mut lerror = false;
        let mut fwhmls: f32 = 0.0;
        let mut nchar_metab = [0i32; 2];
        let v = |j: i32| (j - 1) as usize;
        // Rephase data and repeat analysis for plotting.
        let istage = if self.c.dofull { 3 } else { 1 };
        let lstage = istage.min(2);
        'l140: {
            for jrepha in 1..=self.c.mrepha[2] {
                if !self.ldegmx(2)? {
                    break 'l140;
                }
                if self.c.lprint > 0 {
                    let lprint = self.c.lprint;
                    self.io.write(lprint, "(////20X, 'Rephase data for plotting and repeat analysis', 5X, 'Iteration', I2)", &fv![jrepha]);
                }
                self.c.alphab = self.c.alpbbs[2];
                self.c.alphas = self.c.alpsbs[2];
                let lphast = self.c.lphast;
                phiold[0] = self.c.parbes[(lphast, 2)];
                phiold[1] = self.c.parbes[(lphast + 1, 2)];
                self.rephas()?;
                self.plinls(istage, &mut ierror)?;
                if self.c.object >= self.c.drange {
                    self.errmes(1, 3, CHSUBP)?;
                    self.c.parbes[(lphast, 2)] = -phiold[0];
                    self.c.parbes[(lphast + 1, 2)] = -phiold[1];
                    self.rephas()?;
                    self.c.parbes[(lphast, 2)] = phiold[0];
                    self.c.parbes[(lphast + 1, 2)] = phiold[1];
                    break 'l140;
                } else {
                    self.savbes(1)?;
                    self.savbes(2)?;
                }
            }
            if self.ldegmx(2)? && self.c.mrepha[2] > 0 {
                self.errmes(2, 3, CHSUBP)?;
            }
        }
        // 140: reproduce the best solution and the matrix for the covariance
        // from SAVBES. The covariance corresponds to the first stage of the
        // next iteration with DONONL=T, so NONNEG is reset to remove the
        // non-binding constraints. EXDEGP & EXDEGZ are preserved throughout.
        for jpar in 1..=self.c.nlin {
            self.c.solutn[jpar] = self.c.solbes[(jpar, 2)];
            self.c.nonneg[jpar] = self.c.solutn[jpar] == 0.0;
        }
        for jnonl in 1..=self.c.nnonl {
            self.c.parnln[jnonl] = self.c.parbes[(jnonl, 2)];
        }
        for j in 1..=self.c.ny {
            self.c.cy[j] = self.c.cy_sav[(j, 2)];
        }
        self.c.phitot[1] = self.c.phitot_sav[(2, 1)];
        self.c.phitot[2] = self.c.phitot_sav[(2, 2)];
        self.c.alphab = self.c.alpbbs[2];
        self.c.alphas = self.c.alpsbs[2];
        // Save the solution with SAVBES(3) (overwrites the max ALPHAB solution).
        let pmq = self.c.pmqbes[2];
        self.solve(lstage, true, pmq, false, &mut lerror)?;
        if lerror {
            self.errmes(3, 4, CHSUBP)?;
        }
        // SOLVE again for plotting: YREAL (data), YFITRE(JY,0) (fit),
        // YFITRE(JY,JMETAB) (metabolite + background), BACKRE (background).
        for jpar in 1..=self.c.nlin {
            self.c.solutn[jpar] = self.c.solbes[(jpar, 2)];
        }
        self.solve(lstage, false, 0.0, true, &mut lerror)?;
        if lerror {
            self.errmes(4, 4, CHSUBP)?;
        }
        self.c.istago = 3;
        if self.c.nsides > 0 {
            // Lineshape smoothed with DGAUSS, used to estimate FWHMLS. The
            // ordering of the lineshape is reversed for the plot.
            let nside2 = self.c.nside2;
            let _j = nextre(&self.c.parnln.data, nside2, &mut self.s_finout.dwork.data, &self.c.dgauss.data, self.c.thrlin, self.c.imethd);
            let mut jnonl = nside2 + 2;
            for j in 1..=nside2 + 1 {
                self.c.cpy[j] = self.c.incsid as f32 * (self.c.nsides + 1 - j) as f32;
                jnonl = jnonl - 1;
                self.c.cpy[nside2 + 1 + j] = self.s_finout.dwork[nside2 + 4 + jnonl] as f32;
            }
            let mut halfmx = -self.c.rrange;
            for j in 1..=nside2 + 1 {
                halfmx = self.c.cpy[nside2 + 1 + j].max(halfmx);
            }
            halfmx = 0.5 * halfmx;
            let mut jleft = nside2 + 2;
            for j in 1..=nside2 + 1 {
                if self.c.cpy[nside2 + 1 + j] >= halfmx {
                    jleft = j;
                    break;
                }
            }
            let mut jright = 0;
            for j in fdo(nside2 + 1, 1, -1) {
                if self.c.cpy[nside2 + 1 + j] >= halfmx {
                    jright = j;
                    break;
                }
            }
            fwhmls = (self.c.incsid * (jright - jleft + 1)) as f32 * self.c.ppminc;
            if self.c.lprint > 0 {
                let lprint = self.c.lprint;
                self.io.write(lprint, "(////' Lineshape coefficients', 10X, '(Approx. FWHM =', F6.3, ' ppm)')", &fv![fwhmls]);
                let cpy = &self.c.cpy.data;
                plprin(cpy, &cpy[(nside2 + 1) as usize..], cpy, nside2 + 1, true, lprint, self.c.rrange, 0, 0, 0, &[], false, &mut self.io);
            }
        }
        // Error estimates and correlation coefficients. Invert the NDF**2
        // upper triangular factor in DAMAT from PNNLS onto itself and square
        // it (Lawson & Hanson pp. 68-69) to form the covariance matrix.
        // INDCOL(JDF) = column of the JDFth parameter in the positive set.
        // DAPOSI(JDF,KDF) = covariance of SOLUTN(INDCOL(JDF)), SOLUTN(INDCOL(KDF)).
        let ndf = self.c.ndf;
        for i in 1..=ndf {
            let ii = self.c.indcol[i];
            self.c.damat[(i, ii)] = 1.0 / self.c.damat[(i, ii)];
        }
        for i in 1..=ndf - 1 {
            for j in i + 1..=ndf {
                let ij = self.c.indcol[j];
                let mut dsum = 0.0f64;
                for l in i..=j - 1 {
                    let il = self.c.indcol[l];
                    dsum = dsum + self.c.damat[(i, il)] * self.c.damat[(l, ij)];
                }
                self.c.damat[(i, ij)] = -self.c.damat[(j, ij)] * dsum;
            }
        }
        for i in 1..=ndf {
            for j in i..=ndf {
                let mut dsum = 0.0f64;
                for l in j..=ndf {
                    let il = self.c.indcol[l];
                    dsum = dsum + self.c.damat[(i, il)] * self.c.damat[(j, il)];
                }
                self.s_finout.daposi[(i, j)] = dsum;
                self.s_finout.daposi[(j, i)] = dsum;
            }
        }
        // CONCEN = BMAT * SOLUTN, BMAT(JCONC,JDF) = 1 or 0 from LCOMPO.
        // DAMAT(JDF,KDF) = Cov_SOLUTN * BMAT**T.
        let nconc = self.c.nconc;
        for icol in 1..=nconc {
            for jdf in 1..=ndf {
                for jcompo in 1..=self.c.ncompo[icol] {
                    self.s_finout.includ[jdf] = self.c.indcol[jdf] == self.c.lcompo[(jcompo, icol)];
                    if self.s_finout.includ[jdf] {
                        break;
                    }
                }
            }
            for irow in 1..=ndf {
                let mut dsum = 0.0f64;
                for jdf in 1..=ndf {
                    if self.s_finout.includ[jdf] {
                        dsum = dsum + self.s_finout.daposi[(irow, jdf)];
                    }
                }
                self.c.damat[(irow, icol)] = dsum;
            }
        }
        // DAPOSI(JCONC,KCONC) = covariance of CONCEN(JCONC), CONCEN(KCONC) = BMAT * DAMAT.
        for irow in 1..=nconc {
            for jdf in 1..=ndf {
                for jcompo in 1..=self.c.ncompo[irow] {
                    self.s_finout.includ[jdf] = self.c.indcol[jdf] == self.c.lcompo[(jcompo, irow)];
                    if self.s_finout.includ[jdf] {
                        break;
                    }
                }
            }
            for icol in irow..=nconc {
                let mut dsum = 0.0f64;
                for jdf in 1..=ndf {
                    if self.s_finout.includ[jdf] {
                        dsum = dsum + self.c.damat[(jdf, icol)];
                    }
                }
                self.s_finout.daposi[(irow, icol)] = dsum;
            }
        }
        // ERRCON(JCONC) = standard error of CONCEN(JCONC) (not yet scaled by SDBEST(2)).
        for jconc in 1..=nconc {
            self.c.concen[jconc] = 0.0;
            for jcompo in 1..=self.c.ncompo[jconc] {
                let l = self.c.lcompo[(jcompo, jconc)];
                self.c.concen[jconc] = (self.c.concen[jconc] as f64 + self.c.solbes[(l, 2)]) as f32;
            }
            let term = self.s_finout.daposi[(jconc, jconc)] as f32;
            if term < 0.0 {
                self.errmes(5, 4, CHSUBP)?;
            }
            self.s_finout.errcon[jconc] = term.sqrt();
        }
        // DAPOSI(IROW,ICOL) = correlation coefficient, IROW<ICOL (lower triangle output).
        let lprint = self.c.lprint;
        if lprint > 0 {
            self.io.write(lprint, "(//////20X,'Correlation coefficients')", &[]);
            let vals: Vec<FVal> = (1..=nconc - 1).map(|irow| FVal::from(&self.c.nacomb[irow])).collect();
            self.io.write(lprint, "(/(13X,17(1X,A6)))", &vals);
        }
        for icol in 1..=nconc {
            for irow in 1..=icol - 1 {
                let term = self.s_finout.errcon[irow] * self.s_finout.errcon[icol];
                if term <= 0.0 {
                    self.s_finout.daposi[(irow, icol)] = 0.0;
                } else {
                    self.s_finout.daposi[(irow, icol)] = self.s_finout.daposi[(irow, icol)] / term as f64;
                }
            }
            if icol > 1 && lprint > 0 {
                let mut vals = fv![&self.c.nacomb[icol]];
                for irow in 1..=icol - 1 {
                    vals.push(FVal::D(self.s_finout.daposi[(irow, icol)]));
                }
                self.io.write(lprint, "(1X,A11,17F7.3/(12X,17F7.3))", &vals);
            }
        }
        if lprint > 0 {
            let vals: Vec<FVal> = (1..=nconc - 1).map(|irow| FVal::from(&self.c.nacomb[irow])).collect();
            self.io.write(lprint, "((13X,17(1X,A6)))", &vals);
        }
        // Number of SDs that the CONC ratios deviate from their prior
        // expectations. Priors: c_num / c_sum = exrati +- sdrati, i.e.
        // [1 / (sdrati * csum)] [c_num - c_sum_true * exrati] = 0 +- 1, with
        // the approximate CSUM from the preliminary analysis. FSD_CORR =
        // sd_true / SD_USED = CSUM / CSUM_TRUE (< 1: weighting too strong).
        if self.c.nratio_used.min(lprint).min(self.c.ipdump - 2) > 0 {
            self.io.write(lprint, "(///5x, 'SDs', 3x, 'Corr Factor', 3x, 'Concentration Ratio')", &[]);
            for jratio in 1..=self.c.nratio_used {
                let lmp = self.c.lmetab_prior[jratio];
                let mut csum = self.c.cprior[(jratio, lmp)] * self.c.sdrati[jratio];
                // Neither term can be zero.
                if csum <= 0.0 {
                    self.errmes(12, 5, CHSUBP)?;
                }
                csum = 1.0 / csum;
                let mut prior_sum = self.c.sqrtwt_ratio_used[jratio] * self.c.concen[lmp];
                let mut sd_used: f32 = 0.0;
                for jmetab in 1..=self.c.nmetab {
                    let term = self.c.cprior[(jratio, jmetab)] * self.c.concen[jmetab];
                    sd_used = sd_used + term;
                    prior_sum = prior_sum - term;
                }
                let fsd_corr: f32 = if prior_sum <= 0.0 {
                    999.0
                } else {
                    // csum_true = prior_sum * sdrati * csum / exrati; fsd_corr = csum / csum_true.
                    self.c.exrati[jratio] / (prior_sum * self.c.sdrati[jratio])
                };
                let len_chrato = ilen(&self.c.chrato[jratio]);
                let s = self.c.chrato[jratio].sub(1, len_chrato);
                self.io.write(lprint, "(f8.1, g14.2, 3x, a)", &fv![sd_used, fsd_corr, &s]);
            }
        }
        // Table of CONCEN and errors; load TABLE for plotting.
        // PCERR = standard percent error of CONCEN(JCONC).
        let ntable = nconc + 1;
        let lcoord = self.c.lcoord;
        let ltable = self.c.ltable;
        if lcoord > 0 {
            self.io.write(lcoord, F5581, &fv![ntable]);
        }
        if ltable > 0 {
            self.io.write(ltable, F6581, &fv![ntable]);
        }
        self.c.lintbl = 1;
        self.c.ipcerr[1] = 999;
        self.c.ratio_outlier[1] = false;
        let mut facrel: f32 = 0.0;
        'l579: {
            'l575: {
                for jconc in 1..=nconc {
                    if (self.c.namrel.eq_f(&self.c.nacomb[jconc]) || self.c.namrel.eq_f(&self.c.nacom2[jconc])) && self.c.concen[jconc] > 0.0 {
                        facrel = self.c.conrel / self.c.concen[jconc];
                        break 'l575;
                    }
                }
                // NAMREL not in NACOMB. Check for synonyms.
                for jconc in 1..=nconc {
                    for jsyn in 1..=MPMET {
                        if self.c.synus1[(1, jsyn)].is_blank() || self.c.synus1[(2, jsyn)].is_blank() {
                            break;
                        }
                        let s1 = &self.c.synus1[(1, jsyn)];
                        let s2 = &self.c.synus1[(2, jsyn)];
                        if ((s1.eq_f(&self.c.namrel) && s2.eq_f(&self.c.nacomb[jconc])) || (s2.eq_f(&self.c.nacomb[jconc]) && s1.eq_f(&self.c.namrel))) && self.c.concen[jconc] > 0.0 {
                            let nc = self.c.nacomb[jconc].clone();
                            self.c.namrel.set_f(&nc);
                            facrel = self.c.conrel / self.c.concen[jconc];
                            break 'l575;
                        }
                    }
                }
            }
            // 575: use NAMREL='Cr+PCr' or 'Cre+PCr' instead of Cr or Cre if PCr
            // is also present (blocked by CHCOMB(9)='PCr+Cr').
            if self.c.namrel.eq_str("Cr") || self.c.namrel.eq_str("Cre") {
                for jconc in 1..=nconc {
                    if (self.c.nacomb[jconc].eq_str("Cr+PCr") || self.c.nacomb[jconc].eq_str("Cre+PCr")) && self.c.concen[jconc] > 0.0 {
                        let nc = self.c.nacomb[jconc].clone();
                        self.c.namrel.set_f(&nc);
                        facrel = self.c.conrel / self.c.concen[jconc];
                        break 'l579;
                    }
                }
            }
            // Use NAMREL='GPC+PCh+Cho' or as many as present, if fewer are in
            // NAMREL (the name pairs are ordered as in CHCOMB).
            if self.c.namrel.eq_str("PCh+GPC") {
                self.c.namrel.set("GPC+PCh");
            }
            if self.c.namrel.eq_str("Cho+GPC") {
                self.c.namrel.set("GPC+Cho");
            }
            if self.c.namrel.eq_str("Cho+PCh") {
                self.c.namrel.set("PCh+Cho");
            }
            if self.c.namrel.eq_str("GPC+PCh") || self.c.namrel.eq_str("GPC+Cho") || self.c.namrel.eq_str("PCh+Cho") {
                for jconc in 1..=nconc {
                    if self.c.nacomb[jconc].eq_str("Cho+GPC+PCh") && self.c.concen[jconc] > 0.0 {
                        let nc = self.c.nacomb[jconc].clone();
                        self.c.namrel.set_f(&nc);
                        facrel = self.c.conrel / self.c.concen[jconc];
                        break 'l579;
                    }
                }
            }
            if self.c.namrel.eq_str("GPC") || self.c.namrel.eq_str("PCh") || self.c.namrel.eq_str("Cho") {
                for jconc in 1..=nconc {
                    let n = &self.c.nacomb[jconc];
                    if (n.eq_str("GPC+PCh") || n.eq_str("GPC+Cho") || n.eq_str("PCh+Cho") || n.eq_str("Cho+GPC+PCh")) && self.c.concen[jconc] > 0.0 {
                        let nc = n.clone();
                        self.c.namrel.set_f(&nc);
                        facrel = self.c.conrel / self.c.concen[jconc];
                        break 'l579;
                    }
                }
            }
        }
        // 579
        for jpage in 1..=2 {
            nchar_metab[v(jpage)] = self.c.nchlin[jpage] - 22;
            let wide_name = !self.c.namrel.sub(5, 6).eq_str("  ");
            let fmt = if nchar_metab[v(jpage)] < 12 {
                if wide_name {
                    F5582
                } else {
                    F5583
                }
            } else if wide_name {
                F5584
            } else {
                F5585
            };
            let line = format::write_line(fmt, &fv![&self.c.namrel]);
            self.c.table[(1, jpage)].set(&line);
        }
        let mut len_namrel = 0;
        if self.c.lcsv > 0 {
            if self.s_finout.first_row && self.c.ioffset_current_in <= 0 {
                self.s_finout.csv_line[1].set("Row, Col");
            }
            len_namrel = ilen(&self.c.namrel);
            let line = format::write_line("(i3, ', ', i3)", &fv![self.c.idrow, self.c.idcol]);
            self.s_finout.csv_line[2].set(&line);
        }
        if lprint > 0 {
            if !self.c.fxdegp && self.c.ndegppm3_used > 0 {
                let mut vals = Vec::new();
                for j in 0..=self.c.ndegppm3_used {
                    vals.push(FVal::R(self.c.degp_degp[j]));
                    vals.push(FVal::R(self.c.ssq_degp[j]));
                    vals.push(FVal::R(self.c.alpb_degp[j]));
                    vals.push(FVal::R(self.c.dist_degp[j]));
                }
                self.io.write(lprint, "(///'  DEGPPM', 8x, 'SSQ', 5x, 'ALPHAB   Spline Distance'/(0pf8.2, 1p2e11.2, e18.2))", &vals);
            }
            self.io.write(lprint, "(///14x, '1000Shift', 3x, 'SDs', 2x, 'delta(1/T2)', 3x, 'SDs', 8x, 'CONC', 2x, '%SD')", &[]);
        }
        let mut ncsv = 0;
        for jline in 1..=nconc {
            let lconc = self.c.iconc_line_table[jline];
            let skip_line = self.c.onlyco && lconc <= self.c.nmetab;
            let mut relcon: f32 = 0.0;
            let mut fmtc = FStr::blank(8);
            let mut fmtr = FStr::blank(6);
            'l581: {
                if skip_line {
                    let lintbl = self.c.lintbl;
                    self.c.ipcerr[lintbl] = -99;
                    break 'l581;
                }
                // Concentration table.
                ncsv = ncsv + 1;
                self.c.lintbl = self.c.lintbl + 1;
                let lintbl = self.c.lintbl;
                self.s_finout.errcon[lconc] = (self.s_finout.errcon[lconc] as f64 * self.c.sdbest[2]) as f32;
                relcon = facrel * self.c.concen[lconc];
                let pcerr: f32;
                if self.c.concen[lconc] <= 0.0 {
                    self.c.concen[lconc] = 0.0;
                    pcerr = 9999.0;
                } else {
                    pcerr = 100.0 * self.s_finout.errcon[lconc] / self.c.concen[lconc];
                }
                self.c.ipcerr[lintbl] = nint(pcerr.min(999.0));
                if eform(self.c.concen[lconc]) {
                    if self.c.conc3f {
                        fmtc.set("SS1PE8.2");
                    } else {
                        fmtc.set("SS1PE8.1");
                    }
                } else {
                    fmtc.set("0PF8.3");
                }
                if eform(relcon) {
                    fmtr.set("1PE8.1");
                } else {
                    fmtr.set("0PF8.3");
                }
                let mut fmtpm = FStr::new(10, ", ' ', a)");
                'l586: {
                    let mut jratio = 0;
                    let mut found = false;
                    for jr in 1..=self.c.nratio_used {
                        if self.c.lmetab_prior[jr] == lconc {
                            jratio = jr;
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        break 'l586;
                    }
                    // 583
                    let mut sum: f32 = 0.0;
                    for jmetab in 1..=self.c.nmetab {
                        sum = sum + self.c.cprior[(jratio, jmetab)] * self.c.concen[jmetab];
                    }
                    self.c.ratipm = self.c.ratipm.abs();
                    self.c.ratio_outlier[lintbl] = sum.abs() > self.c.ratipm;
                    if sum > self.c.ratipm {
                        fmtpm.set(", '+', a)");
                    } else if sum < -self.c.ratipm {
                        fmtpm.set(", '-', a)");
                    }
                }
                // 586: NACOMB(J) is changed here only for J > NMETAB (redefined with the next CSI voxel).
                if !self.c.nacom2[lconc].is_blank() {
                    let n2 = self.c.nacom2[lconc].clone();
                    self.c.nacomb[lconc].set_f(&n2);
                }
                for jpage in 1..=2 {
                    let fmt = format!("({},I4,'%',{}{}", fmtc.as_str(), fmtr.as_str(), fmtpm.as_str());
                    let name = self.c.nacomb[lconc].sub(1, nchar_metab[v(jpage)]);
                    let line = format::write_line(&fmt, &fv![self.c.concen[lconc], self.c.ipcerr[lintbl], relcon, &name]);
                    self.c.table[(lintbl, jpage)].set(&line);
                }
            }
            // 581: final table of shifts & broadenings for all lines, even
            // those skipped in the concentration table (IPCERR = -99 above).
            if lprint > 0 && lconc <= self.c.nmetab && self.c.dofull {
                let c = &self.c;
                let lintbl = c.lintbl;
                let shift = c.parbes[(c.lshist + lconc - 1, 2)];
                let hzfac = (2.0f32 * c.pi * c.hzpppm) as f64;
                let name = c.nacomb[lconc].sub(1, 6);
                if c.imethd == 3 {
                    let lp = c.lpowen[lconc - 1];
                    let vals = fv![
                        lconc,
                        &name,
                        shift / hzfac,
                        shift / c.sdshif[lconc] as f64,
                        c.parbes[(lp + 1, 2)],
                        c.parbes[(lp + 1, 2)] / c.coeff_power_sd[(1, lconc)],
                        c.concen[lconc],
                        c.ipcerr[lintbl]
                    ];
                    let mut rest = Vec::new();
                    for jpower in 2..=c.npower[lconc] {
                        rest.push(fv![c.parbes[(lp + jpower, 2)], c.parbes[(lp + jpower, 2)] / c.coeff_power_sd[(jpower, lconc)]]);
                    }
                    self.io.write(lprint, "(i3, 1x, 'met= ', a6, 3pf8.1, 0pf6.1, f13.2, f6.1, 1pe12.2, i5)", &vals);
                    for r in rest {
                        self.io.write(lprint, "(29x, f13.2, f6.1)", &r);
                    }
                } else {
                    let rt2 = c.parbes[(c.lrt2st + lconc - 1, 2)];
                    let vals = fv![
                        lconc,
                        &name,
                        shift / hzfac,
                        shift / c.sdshif[lconc] as f64,
                        rt2,
                        (rt2 - c.exrt2[lconc] as f64) / c.sdrt2[lconc] as f64,
                        c.concen[lconc],
                        c.ipcerr[lintbl]
                    ];
                    self.io.write(lprint, "(i3, 1x, 'met= ', a6, 3pf8.1, 0pf6.1, f13.2, f6.1, 1pe12.2, i5)", &vals);
                }
            }
            // Output to the CSV file.
            if skip_line {
                continue;
            }
            if self.c.lcsv > 0 && ncsv <= MCSV {
                let lintbl = self.c.lintbl;
                let len_nacomb = 13.min(ilen(&self.c.nacomb[lconc]));
                if self.s_finout.first_row && self.c.ioffset_current_in <= 0 {
                    let len_line = ilen(&self.s_finout.csv_line[1]);
                    let nm = self.c.nacomb[lconc].sub(1, len_nacomb);
                    let line = self.s_finout.csv_line[1]
                        .sub(1, len_line)
                        .cat_str(", ")
                        .cat(&nm)
                        .cat_str(", ")
                        .cat(&nm)
                        .cat_str(" %SD, ")
                        .cat(&nm)
                        .cat_str("/")
                        .cat(&self.c.namrel.sub(1, len_namrel));
                    self.s_finout.csv_line[1].set_f(&line);
                }
                let mut len_line = ilen(&self.s_finout.csv_line[2]);
                let fmt = format!("({}', ',i4, ', ',{})", fmtc.as_str(), fmtr.as_str());
                let mut csv_element = FStr::blank(56);
                csv_element.set(&format::write_line(&fmt, &fv![self.c.concen[lconc], self.c.ipcerr[lintbl], relcon]));
                len_line = ilen(&self.s_finout.csv_line[2]);
                let line = self.s_finout.csv_line[2].sub(1, len_line).cat_str(", ").cat(&csv_element);
                self.s_finout.csv_line[2].set_f(&line);
            }
        }
        let lintbl = self.c.lintbl;
        let table2: Vec<FVal> = (1..=lintbl).map(|j| FVal::from(&self.c.table[(j, 2)])).collect();
        if lprint > 0 {
            self.io.write(lprint, "(//1X)", &[]);
            let mut vals = fv![&self.c.versio];
            for j in 1..=self.c.nlines_title {
                vals.push(FVal::from(&self.c.title_line[j]));
            }
            self.io.write(lprint, "(1X, A)", &vals);
            self.io.write(lprint, "(1X)", &[]);
            self.io.write(lprint, F5590, &table2);
        }
        if lcoord > 0 {
            self.io.write(lcoord, F5590, &table2);
        }
        if ltable > 0 {
            self.io.write(ltable, F5590, &table2);
        }
        if self.c.lcsv > 0 {
            let lcsv = self.c.lcsv;
            if self.s_finout.first_row && self.c.ioffset_current_in <= 0 {
                self.s_finout.first_row = false;
                let len_line = ilen(&self.s_finout.csv_line[1]);
                let s = self.s_finout.csv_line[1].sub(1, len_line);
                self.io.write(lcsv, "(a)", &fv![&s]);
            }
            let len_line = ilen(&self.s_finout.csv_line[2]);
            let s = self.s_finout.csv_line[2].sub(1, len_line);
            self.io.write(lcsv, "(a)", &fv![&s]);
        }
        // Load ETCOUT with further output; LINETC = number of lines in ETCOUT.
        let sigton: f32;
        if self.c.sdbest[2] > 0.0 {
            let mut sigmax: f32 = 0.0;
            for jy in 1..=self.c.nyuse {
                if self.c.subbas {
                    sigmax = sigmax.max(self.c.yfitre[(jy, 0)].abs());
                } else {
                    sigmax = sigmax.max((self.c.yfitre[(jy, 0)] - self.c.backre[jy]).abs());
                }
            }
            sigton = ((0.5f32 * sigmax) as f64 / self.c.sdbest[2]) as f32;
        } else {
            self.errmes(6, 2, CHSUBP)?;
            sigton = -1.0;
        }
        if self.c.nsides > 0 {
            let line = format::write_line(F5591, &fv![fwhmls, nint(sigton)]);
            self.c.etcout[1].set(&line);
        } else {
            let fw = (self.c.fwhmst_full * self.c.fwhmst_full + self.c.fwhmba * self.c.fwhmba).sqrt();
            let line = format::write_line(F5591, &fv![fw, nint(sigton)]);
            self.c.etcout[1].set(&line);
        }
        let shifd = self.c.ppminc * self.c.ishifd as f32;
        let line = format::write_line(F5593, &fv![shifd]);
        self.c.etcout[2].set(&line);
        let line = format::write_line(F5594, &fv![self.c.alpbbs[2], self.c.alpsbs[2]]);
        self.c.etcout[4].set(&line);
        if self.c.alpbbs[2] <= self.c.alpbpn as f64 && self.c.alpbbs[2] > 0.0 && self.c.nbackg >= 10 {
            self.errmes(7, 1, CHSUBP)?;
        }
        // Put PHITOT(1) in range +-180.
        let lphast = self.c.lphast;
        self.c.phitot[1] = (((self.c.phitot[1] as f64 + self.c.parbes[(lphast, 2)]) / self.c.radian as f64) % 360.0) as f32;
        if (self.c.phitot[1] as f64) < -180.0 {
            self.c.phitot[1] = self.c.phitot[1] + 360.0;
        }
        if self.c.phitot[1] as f64 > 180.0 {
            self.c.phitot[1] = self.c.phitot[1] - 360.0;
        }
        self.c.phitot[2] = ((self.c.phitot[2] as f64 + self.c.parbes[(lphast + 1, 2)]) / self.c.radian as f64) as f32;
        if self.c.phitot[2] < self.c.dgppmn - self.c.sddegp || self.c.phitot[2] > self.c.dgppmx + self.c.sddegp {
            self.errmes(8, 2, CHSUBP)?;
        }
        let line = format::write_line(F5595, &fv![nint(self.c.phitot[1]), self.c.phitot[2]]);
        self.c.etcout[3].set(&line);
        let line = format::write_line(F5596, &fv![self.c.nbackg, self.c.nsides, self.c.incsid]);
        self.c.etcout[5].set(&line);
        let mut linetc = 5;
        if self.c.nside2 > 0 {
            if self.c.ninfl[2] < 0 {
                if self.c.nextr[1] > 1 {
                    self.errmes(9, 1, CHSUBP)?;
                }
                let line = format::write_line(F5597, &fv![self.c.ninfl[1], self.c.nextr[1]]);
                self.c.etcout[6].set(&line);
            } else {
                if self.c.nextr[2] > 1 {
                    self.errmes(9, 1, CHSUBP)?;
                }
                let line = format::write_line(F5598, &fv![self.c.ninfl[1], self.c.ninfl[2], self.c.nextr[1], self.c.nextr[2]]);
                self.c.etcout[6].set(&line);
            }
            linetc = 6;
        }
        if !(self.c.fxdegz || self.c.sddegz >= 45.0) {
            // EXDEGZ (input as DEGZER) is in 0--360; bring PHITOT(1) to that range.
            if self.c.phitot[1] < 0.0 {
                self.c.phitot[1] = self.c.phitot[1] + 360.0;
            }
            let test = amod((self.c.phitot[1] - self.c.exdegz).abs(), 360.0);
            if test.min(360.0 - test) > 4.0 * self.c.sddegz {
                self.errmes(10, 2, CHSUBP)?;
            }
        }
        if !self.c.fxdegp {
            if (self.c.phitot[2] - self.c.exdegp).abs() > 6.0 * self.c.sddegp {
                self.errmes(11, 2, CHSUBP)?;
            }
        }
        let etc: Vec<FVal> = (1..=linetc).map(|j| FVal::from(&self.c.etcout[j])).collect();
        if lprint > 0 {
            self.io.write(lprint, "(//1X)", &[]);
            self.io.write(lprint, F5590, &etc);
        }
        let nyuse = self.c.nyuse;
        if lcoord > 0 {
            self.io.write(lcoord, F5602, &fv![linetc]);
            self.io.write(lcoord, F5590, &etc);
            // Finish output onto unit LCOORD.
            let mut vals = fv![nyuse];
            vals.extend((1..=nyuse).map(|jy| FVal::R(self.c.ppm[jy])));
            self.io.write(lcoord, F5610, &vals);
            let vals: Vec<FVal> = (1..=nyuse).map(|jy| FVal::R(self.c.yreal[jy])).collect();
            self.io.write(lcoord, F5620, &vals);
            let vals: Vec<FVal> = (1..=nyuse).map(|jy| FVal::R(self.c.yfitre[(jy, 0)])).collect();
            self.io.write(lcoord, F5630, &vals);
            if self.c.nbackg > 0 {
                // Background.
                let vals: Vec<FVal> = (1..=nyuse).map(|jy| FVal::R(self.c.backre[jy])).collect();
                self.io.write(lcoord, F5640, &vals);
            }
            if self.c.neach >= 1 {
                'l660: for jmetab in 1..=self.c.nmetab {
                    if self.c.concen[jmetab] <= 0.0 {
                        continue;
                    }
                    for jeach in 1..=MMETAB.min(self.c.neach) {
                        if self.c.nameac[jeach].eq_f(&self.c.nacomb[jmetab].sub(1, 6)) || self.c.neach > self.c.nmetab {
                            let mut vals = fv![&self.c.nacomb[jmetab], self.c.concen[jmetab]];
                            vals.extend((1..=nyuse).map(|jy| FVal::R(self.c.yfitre[(jy, jmetab)])));
                            self.io.write(lcoord, F5660, &vals);
                            continue 'l660;
                        }
                    }
                }
            }
        }
        if ltable > 0 {
            self.io.write(ltable, F5662, &fv![linetc]);
            self.io.write(ltable, F5590, &etc);
        }
        if self.c.lcoraw > 0 {
            // Corrected RAW file onto FILCOR (already open). DATAT is already
            // scaled by FCALIB*TRAMP/VOLUME, ECC'd and corrected for
            // BRUKER=T & SEQACQ=T; only phase & shift corrections are needed
            // (method of CHANGE-RAW.f).
            let c = &mut self.c;
            c.cterm[1] = cmplx(0.0, c.radian * (c.phitot[1] + c.parbes[(lphast, 2)] as f32)).exp();
            let cfactor = cmplx(0.0, -2.0 * c.pi * c.hzpppm * c.deltat * shifd).exp();
            for junfil in 1..=c.nunfil {
                c.datat[junfil] = c.datat[junfil] * c.cterm[1];
                c.cterm[1] = c.cterm[1] * cfactor;
            }
            for jdata in c.nunfil + 1..=c.ndata {
                c.datat[jdata] = cmplx(0.0, 0.0);
            }
            cfft_r(&c.datat.data, &mut c.dataf.data, c.ndata, &mut c.lwfft, &mut c.wfftc.data);
            let mut delta_ppm = c.nunfil as f32 * c.ppminc;
            for jdata in 1..=c.ndata {
                c.dataf[jdata] = c.dataf[jdata] * cmplx(0.0, c.radian * delta_ppm * (c.phitot[2] + c.parbes[(lphast + 1, 2)] as f32)).exp();
                delta_ppm = delta_ppm - c.ppminc;
            }
            let nunfil = c.nunfil;
            for junfil in 1..=nunfil {
                c.cterm[1] = c.dataf[nunfil + junfil];
                c.dataf[nunfil + junfil] = c.dataf[junfil];
                c.dataf[junfil] = c.cterm[1];
            }
            cfftin(&c.dataf.data, &mut c.datat.data, c.ndata, &mut c.lwfft, &mut c.wfftc.data);
            let lcoraw = c.lcoraw;
            let hz = c.hzpppm;
            self.io.write_records(lcoraw, vec!["&SEQPAR".to_string(), format!(" HZPPPM={},", nml_real(hz)), " /".to_string()]);
            let bruker = false;
            let fmtdat = FStr::new(MCHFMT as usize, "(2e15.6)");
            let id = FStr::new(MCHID as usize, "FILCOR");
            let seqacq = false;
            let tramp: f32 = 1.0;
            let volume: f32 = 1.0;
            self.io.write_records(
                lcoraw,
                vec![
                    "&NMID".to_string(),
                    format!(" BRUKER={},", nml_log(bruker)),
                    format!(" FMTDAT=\"{}\",", fmtdat.as_str()),
                    format!(" ID=\"{}\",", id.as_str()),
                    format!(" SEQACQ={},", nml_log(seqacq)),
                    format!(" TRAMP={},", nml_real(tramp)),
                    format!(" VOLUME={},", nml_real(volume)),
                    " /".to_string(),
                ],
            );
            let vals: Vec<FVal> = (1..=nunfil).map(|j| FVal::C(self.c.datat[j])).collect();
            self.io.write(lcoraw, &fmtdat.trim(), &vals);
        }
        self.exitps(false)
    }

    /// EXITPS (LSTOP): load the error message table into ERRORS and write it,
    /// with the table of input changes, onto LPRINT, LCOORD and LTABLE, and
    /// close them. The PostScript file is not produced (the `LPS <= 0`
    /// branch is always taken). LSTOP = T ends the run.
    pub fn exitps(&mut self, lstop: bool) -> R<()> {
        let _chsubp = "EXITPS";
        self.errtbl();
        let (lprint, lcoord, ltable) = (self.c.lprint, self.c.lcoord, self.c.ltable);
        if lprint.max(lcoord).max(ltable) > 0 {
            self.errtbl();
        }
        let linerr = self.c.linerr;
        let errors: Vec<FVal> = (1..=linerr).map(|j| FVal::from(&self.c.errors[j])).collect();
        let linchg = self.c.linchg[2];
        let mut changes = fv![linchg];
        changes.extend((1..=linchg).map(|j| FVal::from(&self.c.change[(j, 2)])));
        if lprint > 0 {
            self.io.write(lprint, "(////' Summary of diagnostics'/(A))", &errors);
            self.io.write(lprint, "(/' ')", &[]);
            self.io.close(lprint);
        }
        if lcoord > 0 {
            let mut vals = fv![linerr];
            vals.extend(errors.iter().cloned());
            self.io.write(lcoord, F5120, &vals);
            self.io.write(lcoord, F5130, &changes);
            self.io.close(lcoord);
        }
        if ltable > 0 {
            let mut vals = fv![linerr];
            vals.extend(errors.iter().cloned());
            self.io.write(ltable, F5122, &vals);
            self.io.write(ltable, F5132, &changes);
            self.io.close(ltable);
        }
        if self.c.lcoraw > 0 {
            let lcoraw = self.c.lcoraw;
            self.io.close(lcoraw);
        }
        if lstop {
            return stop("STOP");
        }
        Ok(())
    }

    /// ERRTBL: load the error message table into ERRORS.
    fn errtbl(&mut self) {
        const CHSUBP: &str = "ERRTBL";
        const CHTYPE: [[&str; 5]; 2] = [["info", "warning", "ERROR", "FATAL", "ILLOGICAL"], ["info's", "warnings", "ERRORS", "FATAL", "ILLOGICAL"]];
        let linerr = self.c.linerr;
        let mut j = 1;
        while j <= linerr {
            let illog = self.c.leverr[j] < 1 || self.c.leverr[j] > 5;
            if illog {
                self.c.nerror[j] = 1;
                self.c.leverr[j] = 5;
                self.c.cherr[j].set(CHSUBP);
                self.c.ierrno[j] = 1;
            }
            // CHTYPE(LEVERR(J), MIN0(2,NERROR(J))); NERROR counts occurrences (>= 1).
            let kind = 2.min(self.c.nerror[j]).max(1);
            let chtype = CHTYPE[(kind - 1) as usize][(self.c.leverr[j] - 1) as usize];
            let line = format::write_line("(i4, 1X, A9, 1X, A6, I3)", &fv![self.c.nerror[j], chtype, &self.c.cherr[j], self.c.ierrno[j]]);
            self.c.errors[j].set(&line);
            if illog {
                break;
            }
            j += 1;
        }
        // 120
        self.c.linerr = j.min(linerr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(s: &str) -> Vec<&str> {
        s.lines().collect()
    }

    #[test]
    fn revers_reverses() {
        let mut x = [1.0f32, 2.0, 3.0, 4.0, 5.0];
        revers(&mut x, 5);
        assert_eq!(x, [5.0, 4.0, 3.0, 2.0, 1.0]);
        revers(&mut x, 4);
        assert_eq!(x, [2.0, 3.0, 4.0, 5.0, 1.0]);
    }

    #[test]
    fn namelist_reals_match_gfortran() {
        assert_eq!(nml_real(127.786142), "  127.786140    ");
        assert_eq!(nml_real(1.0), "  1.00000000    ");
        assert_eq!(nml_real(63.9), "  63.9000015    ");
        assert_eq!(nml_real(1.5e-7), "  1.50000005E-07");
        assert_eq!(nml_real(123456789.0), "  123456792.    ");
        assert_eq!(nml_real(0.0), "  0.00000000    ");
        assert_eq!(nml_real(-2.5), " -2.50000000    ");
        assert_eq!(nml_real(0.1), " 0.100000001    ");
        assert_eq!(nml_real(1.0e20), "  1.00000002E+20");
    }

    /// The table, misc. and diagnostic sections of the native build's
    /// out.coord / out.table (lcm-test), rewritten through the same FORMATs.
    #[test]
    fn coord_and_table_formats_reproduce_native_output() {
        let mut lcm = Lcm::new();
        lcm.c.lcoord = 9;
        lcm.c.ltable = 7;
        lcm.io.open_new(9, "out.coord");
        lcm.io.open_new(7, "out.table");
        // Concentration lines as FINOUT writes them.
        let rows: [(f32, i32, f32, &str, bool); 4] =
            [(7.20e-8, 166, 3.9e-2, "Ala", true), (5.64e-7, 36, 0.309, "Asp", true), (0.0, 999, 0.0, "PCh", true), (2.85e-6, 17, 1.563, "MM14+Lip13a+Lip13b+MM12", true)];
        let mut table = vec![FStr::new(74, &format::write_line(F5584, &fv!["Cr+PCr"])).as_str()];
        for (conc, ipc, rel, name, _) in rows.iter() {
            let fmtc = if eform(*conc) { "SS1PE8.2" } else { "0PF8.3  " };
            let fmtr = if eform(*rel) { "1PE8.1" } else { "0PF8.3" };
            let fmt = format!("({},I4,'%',{}, ' ', a) ", fmtc, fmtr);
            let mut t = FStr::blank(74);
            t.set(&format::write_line(&fmt, &fv![*conc, *ipc, *rel, *name]));
            table.push(t.as_str());
        }
        lcm.io.write(7, F6581, &fv![36]);
        let vals: Vec<FVal> = table.iter().map(|s| FVal::from(s.as_str())).collect();
        lcm.io.write(7, F5590, &vals);
        lcm.io.write(9, F5581, &fv![36]);
        let mut etc = vec![];
        for (fmt, v) in [
            (F5591, fv![0.084f32, 21]),
            (F5593, fv![0.008f32]),
            (F5595, fv![9, 2.2f32]),
            (F5594, fv![0.17f64, 0.37f64]),
            (F5596, fv![28, 5, 1]),
            (F5597, fv![2, 1]),
        ] {
            let mut t = FStr::blank(74);
            t.set(&format::write_line(fmt, &v));
            etc.push(FVal::from(&t));
        }
        lcm.io.write(7, F5662, &fv![6]);
        lcm.io.write(7, F5590, &etc);
        lcm.io.write(9, F5602, &fv![6]);
        lcm.c.linerr = 0;
        lcm.c.linchg[2] = 2;
        lcm.c.change[(1, 2)].set(" filtab='out.table'");
        lcm.c.change[(2, 2)].set(" ltable=7");
        lcm.exitps(false).unwrap();
        let t = lcm.io.outputs["out.table"].clone();
        let got = lines_of(&t);
        let want = [
            "",
            "$$CONC 36 lines in following concentration table = NCONC+1",
            "    Conc.  %SD /Cr+PCr  Metabolite                                         ",
            " 7.20E-08 166% 3.9E-02 Ala                                                 ",
            " 5.64E-07  36%   0.309 Asp                                                 ",
            "    0.000 999%   0.000 PCh                                                 ",
            " 2.85E-06  17%   1.563 MM14+Lip13a+Lip13b+MM12                             ",
            "",
            "$$MISC  6 lines in following misc. output table",
            "  FWHM = 0.084 ppm    S/N =  21                                            ",
            "  Data shift = 0.008 ppm                                                   ",
            "  Ph:   9 deg       2.2 deg/ppm                                            ",
            "  alphaB,S = 1.7E-01,   3.7E-01                                            ",
            "   28 spline knots.   Ns = 5(1)                                            ",
            "   2 inflections.     1 extrema                                            ",
            "",
            "$$DIAG  0 lines in following diagnostic table:",
            "",
            "",
            "$$INPU  2 lines in following table of input changes:",
            " filtab='out.table'                                                       ",
            " ltable=7                                                                 ",
        ];
        assert_eq!(got, want);
        let c = lcm.io.outputs["out.coord"].clone();
        let got = lines_of(&c);
        assert_eq!(got[0], " 36 lines in following concentration table = NCONC+1");
        assert_eq!(got[1], "   6 lines in following misc. output table");
        assert_eq!(got[2], "   0 lines in following diagnostic table:");
        assert_eq!(got[3], "");
        assert_eq!(got[4], "   2 lines in following table of input changes:");
    }

    /// The numeric blocks of the gfortran build's .COORD on LCModel's test case, parsed and rewritten.
    #[test]
    fn coord_number_blocks_roundtrip() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/test_lcm/native.coord")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.iter().position(|l| l.contains("points on ppm-axis")).unwrap();
        let ny: usize = lines[start].split_whitespace().next().unwrap().parse().unwrap();
        let nrows = (ny + 9) / 10;
        let mut at = start;
        for (fmt, header) in [(F5610, true), (F5620, false), (F5630, false), (F5640, false)] {
            let block = &lines[at..at + 1 + nrows];
            let nums: Vec<FVal> = block[1..].iter().flat_map(|l| l.split_whitespace()).map(|s| FVal::R(s.parse::<f32>().unwrap())).collect();
            let mut vals = if header { fv![ny as i32] } else { vec![] };
            vals.extend(nums);
            let got = format::write_fmt(fmt, &vals);
            assert_eq!(got, block.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{fmt}");
            at += 1 + nrows;
        }
    }
}
