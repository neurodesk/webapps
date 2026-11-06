# NeuroMorph

Neuron morphology from SWC reconstructions, in the browser. NeuroMorph reads one or more
`.swc` files (or a folder), checks and repairs common SWC faults, draws each neuron as tubes
coloured by neurite type, and measures it with NeuroM's definitions. It runs on the CPU and
uploads nothing. Reading and measuring run in a module worker (`src/worker.js`), one per run,
which the footer × terminates. Each reconstruction is named by its path within the chosen
folder, so files of one name in two folders stay apart; a file that cannot be read is
skipped and named.

The science is in `src/morph`, pure modules with no DOM:

| Module | Does |
| --- | --- |
| `swc.js` | Parse, check and repair SWC; write the repaired file |
| `morphometrics.js` | Build sections, morphometrics, Sholl crossings |
| `tubes.js` | The display mesh (truncated-cone tubes, soma spheres, type colours) |
| `outputs.js` | The CSV tables |

## Definitions

The definitions follow NeuroM 4 (BSD-3-Clause, Blue Brain Project). The code is a clean
implementation; NeuroM serves only as the reference.

- A **section** is an unbranched run of samples, split at every branch point. Like MorphIO, a
  child section starts with its parent's last point. A neurite's first section starts at its
  first sample, so the gap from the soma to a neurite belongs to no section.
- **Total length** sums segment lengths over the neurites. It excludes the soma and the
  soma-to-neurite gaps.
- **Surface area** and **volume** treat each segment as a truncated cone between its two
  radii: π(r₀ + r₁)√((r₀ − r₁)² + h²) and πh(r₀² + r₀r₁ + r₁²)/3. Both cover neurites only.
- **Bifurcations** are points with exactly two child sections. **Forking points** have two
  or more. **Terminal points** are sections without children.
- **Path distance** runs along the tree from the neurite's first sample to the end of each
  section. The table gives the maximum.
- **Radial distance** runs from the soma centre to each terminal point. The table gives the
  maximum.
- **Branch order** counts the sections above a section. The root section has order 0.
- **Strahler order** is 1 at a terminal section. A section takes order i + 1 when two or
  more of its children have the highest order i, and order i otherwise.
- The **local bifurcation angle** is the angle between the first segments of the two
  children; a child's zero-length first segment is skipped. The **remote angle** uses the
  ends of the two child sections. Points with more than two children get no angle.
- The **soma centre** is the first soma sample. NeuroM uses that sample for every SWC soma
  (single point, NeuroMorpho three-point and cylinders).
- **Sholl**: spheres centred on the soma centre at radii step, 2·step, … up to the farthest
  neurite point. A segment crosses radius r when r² lies between the squared distances of
  its two ends, bounds included. A branch that bends back is counted again, and a sample
  exactly on a sphere is counted by both of its segments, as in NeuroM's `sholl_crossings`.

Coordinates and radii are rounded to single precision as they are read, because MorphIO
stores them that way. Measurements then use double precision.

### Differences from NeuroM

These are deliberate, and none applies to the examples:

1. **Sholl radii.** `sholl_frequency` starts its default bins at the soma radius. NeuroMorph
   uses step, 2·step, …, which matches NeuroM's `sholl_crossings` called with the same radii
   (as `validation/neurom_reference.py` does).
2. **Type changes.** MorphIO refuses a neurite that changes type without branching. NeuroMorph
   starts a new section there, which is MorphIO's `UNIFURCATED_SECTION_CHANGE` behaviour. The
   new section raises the branch order below it by one.
3. **Faults MorphIO refuses.** NeuroMorph always repairs these and reports each repair, so the
   file can still be measured: malformed lines are skipped, a repeated id keeps its first
   sample, a missing parent makes the sample the root of a new tree, and a parent cycle is
   cut where it closes.
4. **Optional repairs** (on by default). A zero or negative radius takes the nearest positive
   radius in the same neurite, searching up the tree first and then down (fewest steps). A
   sample at its parent's position is merged into the parent. A radius left nonpositive
   (no positive radius in its neurite) is reported as unrepaired, and the surface area and
   volume of the neurites holding it are blank. Turn the option off to measure a file
   exactly as NeuroM does: zero radii are then measured as points, and only a negative
   radius blanks area and volume. NeuroM's `simple.swc` fixture has zero radii and is checked
   with the option off. The repaired SWC keeps the original `#` header lines (NeuroMorpho.Org's
   carry the CC BY attribution) and adds a repair note.
5. **No soma.** NeuroM's Sholl and radial distances need a soma. NeuroMorph measures them
   from the first sample and reports the file.

Other reported checks: neurites detached from the soma, several soma groups, soma samples
inside a neurite, types other than 1–4 (as in NeuroM, a neurite counts under the type of
its first sample, so one that starts with another type counts only under All), steps of more than 30 µm
along z (NeuroM's `has_no_jumps` default), multifurcations, and samples listed before their
parent.

## Validation

`validation/neurom_reference.py` records NeuroM 4.0.6's numbers (MorphIO 3.5.1, NumPy 2.5.4,
Python 3.13) for both hosted examples, three of NeuroM's own BSD test morphologies,
`Neuron.swc`, `strahler.swc` and `simple.swc` (committed under `test/fixtures/neurom`), and
`test/fixtures/trifurcation.swc`, a small file with a three-way branch point. The
numbers are in `validation/neurom-reference.json`. To record them again:

```sh
python -m venv venv && venv/bin/pip install -r validation/requirements.txt
venv/bin/python validation/neurom_reference.py --step 10 validation/neurom-reference.json \
  n120.CNG.swc 5-27-11cell1-nonFS-BC.CNG.swc \
  test/fixtures/neurom/Neuron.swc test/fixtures/neurom/strahler.swc test/fixtures/neurom/simple.swc \
  test/fixtures/trifurcation.swc
```

Every neurite type (all, axon, basal, apical) is compared for neurite, section, bifurcation,
forking point and terminal counts, total length, surface area, volume, maximum path and
radial distance, maximum branch and Strahler order, every local and remote bifurcation
angle, and every Sholl count.

- `test/neurom-parity.test.js` checks the fixtures in Node. Counts and orders must be equal,
  every other value within 1e-6 relative (angles also within 1e-7 rad absolute), and Sholl
  counts identical.
- `e2e/smoke.spec.js` loads each hosted example in Chromium, downloads the tables and holds
  them to the same reference.

The largest relative difference is 4.7e-7 (apical volume of n120), from NeuroM's
single-precision arithmetic. Counts, orders and Sholl intersections are identical.

## Example data

Both examples are standardized (CNG) reconstructions from NeuroMorpho.Org, used unchanged
under CC BY 4.0 (https://neuromorpho.org/useterm.jsp). They are pinned on the Hugging Face
dataset `neurodeskorg/webapps` at `neuromorph/example/`, whose README carries the attribution.

- `n120.CNG.swc`: rat CA1 pyramidal cell (NMO_00120, Turner archive). Pyapali et al. 1998,
  J Comp Neurol 391:335–352.
- `5-27-11cell1-nonFS-BC.CNG.swc`: rat dentate gyrus basket cell with a complete axon
  (NMO_10036, Santhakumar archive). Yu et al. 2013, J Neurophysiol 109:1746–1763.

Cite NeuroMorpho.Org (Ascoli et al. 2007; Tecuatl et al. 2024) together with the original
papers. The Cite dialog lists them all.

## Command line

NeuroMorph has no command line of its own. For batch work, run NeuroM (`pip install neurom`):
its features give the same numbers under the definitions above. The modules in `src/morph`
have no browser dependencies, so they could back a Node command line later.
