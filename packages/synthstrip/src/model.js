// SYNcro's published browser SynthStrip graph (models/syncro.manifest.json): the model every app
// and command line that strips the skull with SynthStrip loads.
export const SYNTHSTRIP_MODEL = Object.freeze({
  filename: 'synthstrip-browser.onnx',
  bytes: 10296357,
  sha256: 'dc9e11999b58d7949d77ddf1b2ed2910df66f8725c078a6b46ae08b8ebcc2800',
  license: 'Apache-2.0',
  url: 'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/e0a056b3d6b2b075bab5b780281af17fc9d6421d/syncro/synthstrip-browser.onnx',
});

// FreeSurfer's no-CSF weights (synthstrip.nocsf.1.pt, freesurfer/synthstrip@sha256:ebbc1772…),
// converted and rewritten exactly as SYNTHSTRIP_MODEL, which the same steps reproduce byte for byte.
// mri_synthstrip --no-csf: the same network, trained to leave the surrounding CSF out of the brain.
// The graph is SYNTHSTRIP_MODEL's with other weights, so the browser reuses its slice plan.
export const SYNTHSTRIP_NOCSF_MODEL = Object.freeze({
  filename: 'synthstrip-nocsf-browser.onnx',
  bytes: 10296357,
  sha256: 'f60cbe2673325ba22b75cf40979cdff4236379c34892528d6185b6a592cc6da8',
  license: 'Apache-2.0',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/9b298dcfacc708cce6d79a6b6aa161a8acaefcf9/synthstrip/models/synthstrip-nocsf-browser.onnx',
});
