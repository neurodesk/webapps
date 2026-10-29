"""Stage the source run of the 1.2 mm SyN-only replay from the fetched sdc data.

    python3 stage_replay.py SDC_REFERENCE SDC_GRID DEST

The pinned replay_syn.py (sdc/reference/scripts/) reads a run folder: node-outputs.json, the
kept preprocessing outputs at their work/ paths, and work/driver-record.json for the EPI mask.
DEST gets that folder for the 1.2 mm double seed-1234 run of grid-q68 (fetch_reference.py
--folder grid ... replay-1.2mm), as symbolic links. Two inputs come from elsewhere:

- the EPI reference (node epi_reference_wf/post_merge), which grid-q68 did not keep. It depends
  only on the mean b0: the 12 full-brain runs of sdc/reference/ (0.8 mm and 2 mm grids) wrote the
  same bytes. It is the 2 mm double seed-1234 run's file (subset registration-gate);
- the EPI mask, which driver-record.json names by its path on the reference host: it is the
  pinned mask/ file. Only that argument is rewritten.
Standard library only.
"""

import json
import os
import sys

RUN = "runs/full-1.2mm-s1234-double-affine"
REF_RUN = "runs/full-2mm-s1234-double-affine"
EPI_REF = "work/sdc_ref/syn_preprocessing_wf/epi_reference_wf/clip_bg_noise/mapflow/_clip_bg_noise0/clipped.nii.gz"
EPI_MASK = "mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz"
KEPT = (
    "work/sdc_ref/syn_preprocessing_wf/anat2epi/clipped_noise_corrected_trans.nii.gz",
    "work/sdc_ref/syn_preprocessing_wf/mask2epi/sub-01_run-001_desc-mindgrab_mask_trans_uint8.nii.gz",
    "work/sdc_ref/syn_preprocessing_wf/prior_msk/fmap_atlas_trans_mask.nii.gz",
)


def link(target, path):
    if not os.path.isfile(target):
        sys.exit(f"{target} is missing: fetch the subsets first")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.lexists(path):
        os.remove(path)
    os.symlink(target, path)


def main(reference, grid, dest):
    reference, grid, dest = (os.path.abspath(p) for p in (reference, grid, dest))
    src = os.path.join(grid, RUN)
    nodes = json.load(open(os.path.join(src, "node-outputs.json")))
    post_merge = nodes["work/sdc_ref/syn_preprocessing_wf/epi_reference_wf/post_merge"][
        "out"
    ]
    if post_merge != EPI_REF:
        sys.exit(f"post_merge is {post_merge}, not {EPI_REF}")
    os.makedirs(os.path.join(dest, "work"), exist_ok=True)
    link(
        os.path.join(src, "node-outputs.json"), os.path.join(dest, "node-outputs.json")
    )
    for rel in KEPT:
        link(os.path.join(src, rel), os.path.join(dest, rel))
    link(os.path.join(reference, REF_RUN, EPI_REF), os.path.join(dest, EPI_REF))
    record = json.load(open(os.path.join(src, "work/driver-record.json")))
    argv = record["argv"]
    argv[argv.index("--epi-mask") + 1] = os.path.join(reference, EPI_MASK)
    record["staged_by"] = (
        "packages/hmc-registration/validation/sdc-gate/stage_replay.py"
    )
    with open(os.path.join(dest, "work/driver-record.json"), "w") as f:
        json.dump(record, f, indent=2)
        f.write("\n")
    print(dest)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
