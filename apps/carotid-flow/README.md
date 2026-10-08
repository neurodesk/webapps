# Carotid Flow (web)

Find both carotid arteries in one retrospectively gated phase-contrast slice through the neck
and extract their flow curves. Everything runs in the browser. The detection lives in
`packages/carotid-flow` (`@neurodesk/carotid-flow`), pure JavaScript and Node-tested, which the
`carotid-flow` command line also runs.

## Input

One NIfTI (or DICOM series, converted locally by dcm2niix) holding a single slice: the
amplitude frames followed by the same number of phase frames. Separate amplitude and phase
series also work when the phase file name carries `_ph`; beside a Philips angiographic
magnitude (`_mag`), the modulus is the one named `_mod`. A pair must share its size, affine and
voxel spacing; the app refuses a pair that does not.

## Two methods, chosen by the phase data

The phase series decides (`phaseEncoding`), together with the VENC. A real negative lobe means
signed velocity or raw ±4096 phase, which take the velocity method. An unsigned series looks
like raw 0–4095 phase when its values stay within 0–4095, exceed 1000 and have a median between
1536 and 2560, since raw phase sits at 2048 wherever nothing moves. It takes the velocity method
only when a VENC is entered. Without a VENC every unsigned series takes the variability method,
as before, so the lab's exports are never refused or rerouted by this check; the status bar
then notes that the series looks like raw phase.

### Velocity: `detectFromVelocity`

Phase already scaled to cm/s (Philips and GE through dcm2niix) is used as is. Raw 12-bit
Siemens phase is decoded with the VENC: rescaled phase (±4096) maps ±4096 to ±VENC and needs it,
and unrescaled phase (0–4095) maps 0 and 4096 to ±VENC around 2048 once a VENC is entered. The
app asks for the VENC rather than guessing. A VENC entered for an unsigned series above 1000
that is not centred on 2048 is refused, because such a series cannot be told apart from a speed
image; leave the VENC empty to analyse it as one. Before this change an entered VENC was ignored
for raw 0–4095 phase, which went to the variability method.

1. The head mask is the port's (below).
2. Vessels are 8-connected blobs, one direction at a time, of mean velocity above a quarter of
   the 99.9th percentile of mean speed in the head; blobs under 4 pixels are dropped.
3. Arteries are the direction whose blobs pulse more (Gosling's index, weighted by flow). Neck
   veins carry as much flow as the carotids but pulse far less.
4. Each carotid is the artery carrying most flow on its side of the head centroid's world x.
5. Curves are mean velocity (cm/s) and flow, velocity × area × 0.6 (ml/min), through that
   fixed ROI.

On the example (PCMCalculator's open test data) the right carotid averages 211 ml/min against
PCMCalculator's manual, frame-by-frame ROI measurement of 225 ml/min, with a waveform
correlation above 0.99. Aliasing is not unwrapped.

### Unsigned speed image: `detectFromVariability`

Some scanners export the phase series as a magnitude-weighted speed image: unsigned, zero
background, no direction. It carries no velocity, so this path ports the lab's
`standalone_automatic_carotid_flow.m` and reports intensities:

1. The head is the largest 8-connected region of the mean amplitude above its 20th
   percentile, eroded by MATLAB's `strel('disk', 3)` octagon.
2. The temporal standard deviation of the phase frames, zeroed outside the head. Pixels above
   its 99.9th percentile (MATLAB `prctile` interpolation) are candidates.
3. Bilateral amplitude symmetry estimates head tilt over ±30 degrees in 0.5-degree steps.
   The band extends 0.15 head-heights posteriorly and 0.10 anteriorly, within 0.30 head-widths
   laterally and outside a 0.08 head-width midline strip, in the head-aligned frame.
4. Static tissue is the least-variable half of the head. Its median temporal mean supplies
   the baseline. Blobs must share the net-signal sign of the most pulsatile blob.
5. The pair maximises lateral separation divided by one plus squared anterior–posterior
   offset in the head-aligned frame, with at least 5 pixels of separation.
6. Curves subtract the static baseline and multiply by the arterial sign.
7. QC flags tilt at the search limit, circular peak lag over one frame, pair off-centre ratio
   over 0.3, or anterior–posterior offset divided by separation over 0.3. Frame counts are
   taken from the input rather than fixed at 32. Symmetry contrast is recorded in the log.

Advanced settings expose the thresholds, tilt search limit, four band fractions and minimum
separation. These geometry controls apply only to the variability method. QC thresholds and
symmetry sampling stay fixed. The output shows tilt and review flags; automation measurements
include all QC values, the baseline and arterial sign.

Differences from the updated script are deliberate:

- Amplitude, phase and output masks stay on the same stored voxel grid. The affine supplies
  anatomical axes and patient left/right, including flipped or transposed storage. No image
  is mirrored independently. The old script's amplitude flip and image-side labels are gone
  in the supplied revision too.
- Symmetry evaluation combines centring and rotation into one bilinear interpolation instead
  of MATLAB's separate `imtranslate` and `imrotate`. This avoids a second interpolation but
  can shift the optimum by a sampling step on real data; exact MATLAB numerical parity has
  not been established.
- The search band uses continuous head-aligned coordinates, as the updated script does,
  instead of the previous port's rounded axis-aligned bounds.
- The script's shape score remains diagnostic only and does not select vessels, so it is
  not calculated. Curves remain arbitrary signal units; baseline-relative polarity does not
  turn an unsigned speed image into calibrated velocity.

On the open example the port fails (at most one candidate in its band): the velocity SD there
is dominated by CSF pulsation and phase noise in low-signal tissue, which the lab's speed images
suppress. That is why signed data takes the velocity path.

## Editing the labels

Edit on the Carotid labels row opens the shared mask editor over the current background.
Apply replaces the downloaded label map and redraws both carotids from it. The curves,
metrics, CSV and automation results keep the detected vessels.

## Command line

The portable `carotid-flow` command writes this app's three downloads, byte for byte, from a
NIfTI series on a computer without a browser or network. See the "Command line" section of
`packages/carotid-flow/README.md`.

## Tests

- `pnpm --filter carotid-flow test`: MATLAB `prctile` values, synthetic neck phantoms for both
  methods in both orientations and flow directions, raw ±4096 and 0–4095 phase decoding,
  error paths and the chart. `CAROTID_FLOW_OPEN_EXAMPLE=<directory holding the two example files>` adds the check
  against PCMCalculator; `CAROTID_FLOW_EXAMPLE=<the lab's unsigned export>` adds the check that
  the port selects the script's vessels (12 and 4 pixels). That export is not public.
- `pnpm --filter carotid-flow test:e2e`: the hosted example through detection and both
  downloads, settings validation, failed-download retry and cancellation, and, on the tilted
  phantom without the network, editing the carotid labels in the viewer through to the edited
  download.
