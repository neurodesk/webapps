const DATA_BASE = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/544f1362f367355e61a85e0694f5075aba2792b6/reg";

const example = (folder, filename, label) => Object.freeze({
  label,
  filename,
  url: `${DATA_BASE}/${folder}/${filename}`,
  brainExtracted: true,
});

export const APP = Object.freeze({ id: "greedy" });

export const MOVING_EXAMPLES = Object.freeze([
  example("moving", "t1_brain.nii.gz", "T1 brain 1 mm"),
]);

export const STATIONARY_EXAMPLES = Object.freeze([
  example("templates", "MNI152_T1_1mm_brain.nii.gz", "MNI152 T1 1 mm brain"),
]);
