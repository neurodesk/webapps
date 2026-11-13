# Focused probes: predictions

Written before `record_focused_probes.m` was first run on MATLAB. Each section of
the recorder answers one question. The competing predictions below are fixed
here, so the recording can confirm or reject them; it cannot change them.

## hooke-jeeves

Question: what does `samsrf_fit2dprf` do with `Hooke_Jeeves_Steps` on single
reverse-correlation profiles, and does the port's Hooke-Jeeves path reproduce it?

- **Control.** With `FitParam = NaN` (Nelder-Mead), every fitted parameter and
  R² equals the pinned saved maps (`revcor-reference.json`) for that host's
  profiles, before the loop's sign and keep rules. If not, the recorder's
  inputs are not the loop's, and the section is void.
- **H1 (single parameters).** `samsrf_fit2dprf` passes `[SeedParams 1 0]`
  without `double(...)` to `samsrf_hookejeeves`. `SeedParams` come from single
  `Raw_Data`, so the returned parameters and the errors are single (`classes`
  reads `single,single,single`), and every logged evaluation's error is single.
- **H2 (the port today).** The port's Hooke-Jeeves path searches in double. It
  differs from MATLAB on most fitted vertices.
- **H3 (a single model).** Searching in single, with `prf_gaussian_rf` and the
  objective in single arithmetic (single `exp`, single differences and
  `sum_single`), reproduces every recorded parameter and R², and the logged
  evaluation sequence.

H1 and H3 together would justify a port change; H1 alone would not.

## conv-512

Question: how does MATLAB sum a sparse complex `conv` output within 15 below to
14 above a multiple of 512? Kernel all ones, 33 taps; the probed pair holds
±2^60 and every other nonzero sample of the pinned pattern is 1, so each output
counts the ones outside the smallest subtree that holds the pair.

- **H-seq (the port's sparse path).** Every output adds the nonzero samples of
  its window in index order: the count is the number of nonzero samples after
  the later of the pair.
- **H-split.** The sum restarts at an input index s (two partial sums added at
  the end). A pair straddling s gives 0.
- **H-tile.** Outputs are produced in tiles of 512, with the tile's own order:
  outputs near the boundary differ from H-seq; the control centre (256) does not.

The control region, centred on 256 and away from every boundary, follows H-seq
under every hypothesis; a difference there voids the section.

## trig-position

Question: does MATLAB's single `sin` or `cos` depend on where an element sits in
the array (a vector kernel for the body and a scalar one for the tail)?

- **H0 (position-invariant).** Scalar calls, every offset of a 33-element array,
  and the whole input array all give the recorded MATLAB value: the exception
  table's value for exception inputs, and the port's for controls.
- **H-position.** Scalar calls, or some offsets, give the port's value at
  exception inputs (the fdlibm-float candidate), and only the vector body
  differs. The residual would then be a vector kernel's, not the candidate's.

## dot-short

Question: in what order does MATLAB's real `x'*y` add 2-24 products? The pair
counts give the tree.

- **H-mkl (the port's `ddot` for 20 or more elements).** Four two-lane registers
  over blocks of eight, then pairs, then the last element.
- **H-seq.** One accumulator in index order.
- **Other.** Neither; the tree is then read from the counts and checked on the
  held-out random products.
