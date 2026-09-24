// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "carotid-flow",
});

const PHASE_NAME = /(^|[_\-.\s])(ph|pha|phase)([_\-.\s]|$)|phase/i;
const MODULUS_NAME = /(^|[_\-.\s])(mod|modulus|m)([_\-.\s]|$)|modulus/i;

/**
 * Which imported NIfTI holds what. One file carries the amplitude frames followed by the
 * phase frames. Otherwise the phase series is named as such (dcm2niix writes a `_ph` suffix)
 * and the amplitude is the one other series, or, beside a Philips angiographic magnitude,
 * the one named as the modulus.
 */
export function assignSeries(files) {
  const images = files.filter((file) => /\.nii(\.gz)?$/i.test(file.name));
  if (images.length === 1) return { combined: images[0] };
  if (!images.length) return { error: "No NIfTI image was produced. Choose a NIfTI file or a complete DICOM series." };
  const named = (pattern) => images.filter((file) => pattern.test(stem(file.name)));
  const phase = named(PHASE_NAME);
  if (phase.length !== 1) {
    return { error: `${images.length} series were given (${images.map((file) => file.name).join(", ")}) and ${phase.length ? "several are" : "none is"} named as phase. Give the phase series a _ph suffix.` };
  }
  const others = images.filter((file) => file !== phase[0]);
  const modulus = others.length === 1 ? others : others.filter((file) => MODULUS_NAME.test(stem(file.name)));
  if (modulus.length !== 1) {
    return { error: `Choose the amplitude series to go with ${phase[0].name}: give it a _mod suffix, or choose only the two series.` };
  }
  return { amplitude: modulus[0], phase: phase[0] };
}

/** A file name without the NIfTI extension, for naming the outputs after their input. */
export function stem(name) {
  return name.replace(/\.nii(\.gz)?$/i, "").replace(/\.[^.]+$/, "");
}
