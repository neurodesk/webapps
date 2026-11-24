//! Subspectra: op_combinesubspecs, op_takesubspec, op_fourStepCombine.

use num_complex::Complex64 as C;

use super::util::{dims_without, select_axis, squeeze, squeeze_axis, strides, sum_axis, with_axis};
use crate::spectra::Spectra;

/// How op_combinesubspecs combines. FID-A's names are swapped relative to
/// what they do: `'diff'` adds the subspectra (for ISIS/SPECIAL, whose
/// phase cycling already inverts one) and `'summ'` subtracts them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CombineMode {
    /// FID-A `'diff'`: `sum(fids, subSpecs) / n`.
    Diff,
    /// FID-A `'summ'`: `diff(fids, 1, subSpecs) / n`.
    Summ,
}

/// op_combinesubspecs.
pub fn op_combinesubspecs(input: &Spectra, mode: CombineMode) -> Result<Spectra, String> {
    if input.flags.subtracted {
        return Err("The subspectra have already been combined.".into());
    }
    if input.flags.is_four_steps {
        return Err("Data with four steps must first be converted with op_fourStepCombine.".into());
    }
    let s = input.dims.sub_specs;
    if s == 0 {
        return Err("There are no subspectra in this dataset.".into());
    }
    let ns = input.size(s);
    let (fids, sz) = match mode {
        CombineMode::Diff => (sum_axis(&input.fids, &input.sz, s - 1), with_axis(&input.sz, s - 1, 1)),
        CombineMode::Summ => {
            let (inner, len, outer) = strides(&input.sz, s - 1);
            let mut out = Vec::with_capacity(inner * (len - 1) * outer);
            for o in 0..outer {
                for k in 0..len - 1 {
                    for i in 0..inner {
                        out.push(input.fids[i + inner * (k + 1 + len * o)] - input.fids[i + inner * (k + len * o)]);
                    }
                }
            }
            (out, with_axis(&input.sz, s - 1, len - 1))
        }
    };
    let fids: Vec<C> = fids.into_iter().map(|v| v / ns as f64).collect();
    let mut out = input.clone();
    out.fids = fids;
    if matches!(mode, CombineMode::Diff) || ns <= 2 {
        let (out_sz, dims) = squeeze_axis(&input.sz, input.dims, s);
        out.sz = out_sz;
        out.dims = dims;
    } else {
        out.sz = squeeze(&sz);
        out.dims = dims_without(input.dims, s);
    }
    out.subspecs = 1;
    if input.dims.averages > 0 && out.dims.averages == 0 {
        out.averages = 1;
        out.flags.averaged = true;
    } else {
        out.averages = input.averages / 2;
    }
    out.flags.writtentostruct = true;
    out.flags.subtracted = true;
    Ok(out)
}

/// op_takesubspec: keep the subspectra `index` (0-based). FID-A indexes
/// `fids(:,...,index)` without squeezing, so this assumes (as FID-A's data
/// always has) that subspectra are the last dimension; like FID-A it drops
/// the subspectra dimension from `dims` whatever the number kept.
pub fn op_takesubspec(input: &Spectra, index: &[usize]) -> Result<Spectra, String> {
    if input.flags.subtracted {
        return Err("The subspectra have already been combined.".into());
    }
    let s = input.dims.sub_specs;
    if s == 0 {
        return Err("There are no subspectra in this dataset.".into());
    }
    if s == 1 {
        return Err("dims.subSpecs == 1; this should never happen.".into());
    }
    if index.iter().any(|&i| i >= input.size(s)) {
        return Err("Subspectrum index out of range.".into());
    }
    let mut out = input.clone();
    out.fids = select_axis(&input.fids, &input.sz, s - 1, index);
    out.sz = with_axis(&input.sz, s - 1, index.len());
    out.dims = dims_without(input.dims, s);
    out.subspecs = 1;
    out.averages = if out.dims.averages > 0 { out.size(out.dims.averages) } else { 1 };
    out.raw_averages = out.averages;
    out.flags.writtentostruct = true;
    Ok(out)
}

/// op_fourStepCombine: combine four subspectra into two. Mode 0 adds 1+2 and
/// 3+4, 1 subtracts them (2-1, 4-3), 2 adds 1+3 and 2+4, 3 subtracts those;
/// the result is halved.
pub fn op_four_step_combine(input: &Spectra, mode: u8) -> Result<Spectra, String> {
    if !input.flags.is_four_steps {
        return Err("op_fourStepCombine requires a dataset with 4 subspectra.".into());
    }
    if *input.sz.last().unwrap() != 4 {
        return Err("The final matrix dimension must have length 4.".into());
    }
    let rows = input.fids.len() / 4;
    let col = |j: usize| &input.fids[j * rows..(j + 1) * rows];
    let (a, b, op): (usize, usize, fn(C, C) -> C) = match mode {
        0 => (0, 1, |x, y| x + y),
        1 => (0, 1, |x, y| y - x),
        2 => (0, 2, |x, y| x + y),
        3 => (0, 2, |x, y| y - x),
        _ => return Err("Mode not recognised; it must be 0, 1, 2 or 3.".into()),
    };
    // Second output pair: (3,4) for modes 0/1, (2,4) for modes 2/3.
    let (c, d) = if mode < 2 { (2, 3) } else { (1, 3) };
    let mut fids = Vec::with_capacity(rows * 2);
    fids.extend(col(a).iter().zip(col(b)).map(|(&x, &y)| op(x, y) / 2.0));
    fids.extend(col(c).iter().zip(col(d)).map(|(&x, &y)| op(x, y) / 2.0));
    let mut out = input.clone();
    out.fids = fids;
    let last = out.sz.len() - 1;
    out.sz[last] = 2;
    out.subspecs = if out.dims.sub_specs > 0 { out.size(out.dims.sub_specs) } else { 1 };
    out.flags.writtentostruct = true;
    out.flags.is_four_steps = false;
    Ok(out)
}
