# Carotid Flow (web)

Find both carotid arteries in one retrospectively gated phase-contrast slice through the neck
and extract their flow curves. Everything runs in the browser; `src/carotid.js` is pure
JavaScript and Node-tested.

## Input

One NIfTI (or DICOM series, converted locally by dcm2niix) holding a single slice: the
amplitude frames followed by the same number of phase frames. Separate amplitude and phase
series also work when the phase file name carries `_ph`; beside a Philips angiographic
magnitude (`_mag`), the modulus is the one named `_mod`.

## Two methods, chosen by the phase data

The phase series decides (`isSignedPhase`): a real negative lobe means signed velocity.

### Signed velocity: `detectFromVelocity`

Phase already scaled to cm/s (Philips and GE through dcm2niix) is used as is. Raw 12-bit phase
(±4096, Siemens) needs the VENC, which maps ±4096 to ±VENC; the app asks for it rather than
guessing.

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
3. Candidates are kept inside a band from 0.15 head-heights behind to 0.10 in front of the head
   centre, within 0.30 head-widths laterally, outside a 0.08 head-width midline strip.
4. Among the 8-connected blobs, the carotids are the pair maximising lateral separation over
   one plus the squared anterior–posterior offset, with side-by-side and at least 5 pixels apart.
5. Each curve is the mean phase over its blob, sign-flipped if its trough outweighs its peak.

Differences from the script, both deliberate:

- The band and the blob geometry use the stored voxel grid with the anterior and left
  directions read from the affine. The script transposed the image and assumed the nose points
  down; it also sampled the head mask from a left–right mirrored copy of the amplitude.
- Left and right are the patient's, from the world x of each blob. The script labelled the
  image-left vessel as left, which on the scanner's radiological grid is the patient's right.

The script's `shape_score` and `score_blob` were computed but never used to select vessels, so
they are not ported.

On the open example the port fails (at most one candidate in its band): the velocity SD there
is dominated by CSF pulsation and phase noise in low-signal tissue, which the lab's speed images
suppress. That is why signed data takes the velocity path.

## Tests

- `pnpm --filter carotid-flow test`: MATLAB `prctile` values, synthetic neck phantoms for both
  methods in both orientations and flow directions, raw-phase scaling, error paths and the
  chart. `CAROTID_FLOW_OPEN_EXAMPLE=<directory holding the two example files>` adds the check
  against PCMCalculator; `CAROTID_FLOW_EXAMPLE=<the lab's unsigned export>` adds the check that
  the port selects the script's vessels (12 and 4 pixels). That export is not public.
- `pnpm --filter carotid-flow test:e2e`: the hosted example through detection and both
  downloads, settings validation, failed-download retry and cancellation.
