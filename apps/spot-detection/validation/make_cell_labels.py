"""Make the example's 2D cell label image with Big-FISH's classical segmentation.

Follows the last cell of big-fish-examples' notebook "4 - Segment nuclei and
cells" on experiment_1 (DAPI and smFISH maximum projections). DIR holds the two
big-fish-examples release files it reads, unchanged:

    https://github.com/fish-quant/big-fish-examples/releases/download/data/experiment_1_dapi_fov_1.tif
    https://github.com/fish-quant/big-fish-examples/releases/download/data/experiment_1_smfish_fov_1.tif


    python -I make_cell_labels.py DIR

writes DIR/experiment_1_cell_label.tif (uint16, 650 x 500, 0 = background).
"""
import os
import sys

import numpy as np
import tifffile
import bigfish.stack as stack
import bigfish.segmentation as segmentation
import bigfish.multistack as multistack

directory = sys.argv[1]
nuc_2d = stack.maximum_projection(stack.read_image(os.path.join(directory, "experiment_1_dapi_fov_1.tif")))
rna_2d = stack.maximum_projection(stack.read_image(os.path.join(directory, "experiment_1_smfish_fov_1.tif")))
nuc_mask = segmentation.thresholding(nuc_2d, threshold=27000)
nuc_mask = segmentation.clean_segmentation(nuc_mask, small_object_size=2000, fill_holes=True)
nuc_label = segmentation.label_instances(nuc_mask)
cell_label = segmentation.cell_watershed(rna_2d, nuc_label, threshold=4800, alpha=0.9)
nuc_label = segmentation.clean_segmentation(nuc_label, delimit_instance=True)
cell_label = segmentation.clean_segmentation(cell_label, smoothness=7, delimit_instance=True)
nuc_label, cell_label = multistack.match_nuc_cell(nuc_label, cell_label, single_nuc=False, cell_alone=True)
tifffile.imwrite(os.path.join(directory, "experiment_1_cell_label.tif"), cell_label.astype(np.uint16), compression="zlib")
print("cells:", len(np.unique(cell_label)) - 1, cell_label.shape, cell_label.dtype)
