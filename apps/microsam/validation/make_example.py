"""Write the example image and its annotation from BBBC038v1 (CC0).

python -I make_example.py <stage1_train-dir> <out-dir>

<stage1_train-dir> is https://data.broadinstitute.org/bbbc/BBBC038/stage1_train.zip unpacked. The
image is a greyscale RGBA PNG; its first channel is saved as an 8-bit TIFF. The per-nucleus mask
PNGs are merged into one 16-bit label TIFF, ids in sorted mask-file order.
"""
import sys
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import tifffile

SAMPLE = "1023509cf8d4c155467800f89508690be9513431992f470594281cd37dbd020d"


def main(root, out_dir):
    sample = Path(root) / SAMPLE
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rgba = iio.imread(sample / "images" / f"{SAMPLE}.png")
    assert (rgba[..., 0] == rgba[..., 1]).all() and (rgba[..., 1] == rgba[..., 2]).all()
    image = np.ascontiguousarray(rgba[..., 0])
    labels = np.zeros(image.shape, np.uint16)
    for index, path in enumerate(sorted((sample / "masks").glob("*.png")), start=1):
        mask = iio.imread(path) > 0
        assert not (labels[mask] != 0).any()
        labels[mask] = index
    tifffile.imwrite(out / "bbbc038-nuclei.tif", image, photometric="minisblack")
    tifffile.imwrite(out / "bbbc038-nuclei-labels.tif", labels, photometric="minisblack")
    print(image.shape, image.dtype, int(labels.max()), "nuclei")


if __name__ == "__main__":
    main(*sys.argv[1:3])
