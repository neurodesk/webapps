/**
 * Manual quality rating, as in MRIQC's report widget: the same fields, the same JSON keys
 * (so MRIQC's rating tools read it) and the same 10 s minimum before Save unlocks.
 */

// MRIQC artifact keys and labels.
const ARTIFACTS = [
  ['head-motion', 'Head motion artifacts'],
  ['eye-spillover', 'Eye spillover through PE axis'],
  ['noneye-spillover', 'Non-eye spillover through PE axis'],
  ['coil-failure', 'Coil failure'],
  ['noise-global', 'Global noise'],
  ['noise-local', 'Local noise'],
  ['em-perturbation', 'EM interference/perturbation'],
  ['wrap-around', 'Problematic FoV prescription / wrap-around'],
  ['ghost-aliasing', 'Aliasing ghosts'],
  ['ghost-other', 'Other ghosts (for example, RF spoiling)'],
  ['inu', 'Intensity non-uniformity (B1 bias)'],
  ['field-variation', 'Temporal B1 field non-uniformity variation'],
  ['processing', 'Processing such as denoising, defacing or resamplings happened'],
  ['uncategorized', 'Other uncategorized artifact(s)'],
] satisfies readonly (readonly [string, string])[]
const MIN_RATING_SECONDS = 10 // MRIQC's MINIMUM_RATING_TIME: discourages click-through ratings

function $<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`)
  if (!element) throw new Error(`Missing rating control ${id}`)
  return element
}
const slider = $<HTMLInputElement>('rating')
const confidence = $<HTMLInputElement>('rateConfidence')
const comments = $<HTMLTextAreaElement>('rateComments')
const artifacts = $('rateArtifacts')
const saveBtn = $<HTMLButtonElement>('rateSave')
let started = 0 // set by resetRating() once an image is displayed

artifacts.replaceChildren(...ARTIFACTS.map(([name, text]) => {
  const label = document.createElement('label')
  label.className = 'nd-check'
  label.append(Object.assign(document.createElement('input'), { type: 'checkbox', name }), text)
  return label
}))

const unlock = () => {
  const value = Number(slider.value)
  const band = value < 1.5 ? 'Exclude' : value < 2.5 ? 'Poor' : value <= 3.5 ? 'Acceptable' : 'Excellent'
  $('ratingValue').textContent = `${value.toFixed(1)} · ${band}`
  $('confidenceValue').textContent = `${Number(confidence.value).toFixed(1)} · ${Number(confidence.value) < 2 ? 'Doubtful' : 'Confident'}`
  if (started && (Date.now() - started) / 1000 > MIN_RATING_SECONDS) saveBtn.disabled = false
}
slider.oninput = confidence.oninput = comments.oninput = artifacts.onchange = unlock

// A new image: a blank form and a fresh clock.
export function resetRating(): void {
  $<HTMLFormElement>('rateForm').reset()
  saveBtn.disabled = true
  $('ratingValue').textContent = '3.0 · Acceptable'
  $('confidenceValue').textContent = '2.0 · Confident'
  started = Date.now()
}

export function readRating(subject: string) {
  return {
    dataset: '<unset>', // as MRIQC without a dataset name
    subject,
    rating: slider.value,
    artifacts: [...artifacts.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.name),
    time_sec: (Date.now() - started) / 1000,
    confidence: confidence.value,
    comments: comments.value,
  }
}
