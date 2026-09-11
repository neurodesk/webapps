const DATA_BASE = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/67c378c8f8ac5313e5dbeee4c8d95ebe2a2f79c9/reg";

const example = (folder, filename, label = filename.replace(/\.nii(\.gz)?$/i, "")) =>
  Object.freeze({ label, filename, url: `${DATA_BASE}/${folder}/${filename}` });

export const APP = Object.freeze({ id: "edgereg" });

export const MOVING_EXAMPLES = Object.freeze([
  example("moving", "t1_crop.nii.gz", "T1 crop"),
  ...[
    "CT_Philips.nii.gz",
    "fmri_pitch.nii.gz",
    "pcasl.nii.gz",
    "chris_t2.nii.gz",
    "chris_PD.nii.gz",
    "T1_head.nii.gz",
    "fmri.nii.gz",
    "T1_head_ext.nii.gz",
    "T2w.nii.gz",
    "FLAIR_2D.nii.gz",
    "T1_ds000031.nii.gz",
    "dwi.nii.gz",
  ].map((filename) => example("moving", filename)),
]);

export const STATIONARY_EXAMPLES = Object.freeze([
  example("templates", "MNI152_T1_1mm.nii.gz", "MNI152 T1 1 mm"),
  example("templates", "avg152T1.nii.gz", "SPM avg152 T1 2 mm"),
  example("templates", "MNI152_T1_ext.nii.gz", "MNI152 T1 extended"),
]);
