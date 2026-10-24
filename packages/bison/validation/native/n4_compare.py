"""Score bias-corrected T1 images against nu_correct (N3) on the same denoised input.

Usage: python -I n4_compare.py <dir from n4_schedule.sh> <native labels .nii.gz> <name> [<name> ...]

Each <name> is <dir>/<name>.nii.gz. Prints the median CSF, deep GM and cortical GM intensity over
the WM median, the WM coefficient of variation, and Pearson's r of the field (corrected / input,
scaled to the WM median) with N3's inside the linear mask.
"""

import sys

import nibabel as nib
import numpy as np


def main():
    directory, labels = sys.argv[1], sys.argv[2]
    nlm = nib.load(f"{directory}/T1_NLM.nii.gz").get_fdata()
    mask = nib.load(f"{directory}/T1_Mask.nii.gz").get_fdata() > 0.5
    label = nib.load(labels).get_fdata().astype(int)
    wm = (label == 8) & mask
    inside = mask & (nlm > 0)

    def field(image):
        f = image / np.maximum(nlm, 1e-6)
        return f / np.median(f[wm])

    reference = field(nib.load(f"{directory}/T1_N3.nii.gz").get_fdata())
    for name in ["T1_N3", *sys.argv[3:]]:
        image = nib.load(f"{directory}/{name}.nii.gz").get_fdata()
        median = np.median(image[wm])
        ratios = {
            k: round(float(np.median(image[(label == v) & mask]) / median), 3)
            for k, v in [("csf", 2), ("deep-gm", 6), ("cortical-gm", 7)]
        }
        cov = float(np.std(image[wm]) / np.mean(image[wm]))
        r = float(np.corrcoef(field(image)[inside], reference[inside])[0, 1])
        print(f"{name:16s} tissue/WM {ratios} WM CoV {cov:.4f} field r {r:.3f}")


if __name__ == "__main__":
    main()
