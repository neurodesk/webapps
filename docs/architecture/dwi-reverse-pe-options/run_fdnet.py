"""FD-Net with its published 42-subject DWI weights, slice by slice.

Usage: run_fdnet.py <FD-Net checkout> <ap_mean> <pa_mean> <pe-dim 1-3> <out-dir> [ap-first|pa-first]

FD-Net is a 2D network with a fixed 144 x 168 input; the K-unit displaces along
the first image axis. Each slice is transposed so the PE axis comes first,
zero-padded to 144 x 168 and divided by the pair's maximum, as the training
DataGenerator does. The field output is a displacement in voxels; the script
saves it on the input grid as fdnet_field_vox.nii.gz. Which image goes to the
network's LR input is a convention that phase 1 settles.
"""

import os
import sys

import nibabel as nb
import numpy as np

checkout, ap, pa, dim, out = sys.argv[1:6]
order = sys.argv[6] if len(sys.argv) > 6 else "ap-first"
sys.path.insert(0, os.path.join(checkout, "network"))
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import tensorflow as tf
from fdnet_utils import model_compile

tf.config.threading.set_intra_op_parallelism_threads(8)
tf.config.threading.set_inter_op_parallelism_threads(1)

SHAPE = (144, 168)
pe_axis = int(dim) - 1
slice_axis = 2
if pe_axis == slice_axis:
    raise SystemExit("FD-Net needs an in-plane PE axis")
other_axis = 3 - pe_axis - slice_axis

ap_img = nb.load(ap)
ap_data = np.asarray(ap_img.dataobj, dtype=np.float32)
pa_data = np.asarray(nb.load(pa).dataobj, dtype=np.float32)
# (slice, PE, other) so that each slice has the PE axis first.
first = np.transpose(ap_data, (slice_axis, pe_axis, other_axis))
second = np.transpose(pa_data, (slice_axis, pe_axis, other_axis))
if order == "pa-first":
    first, second = second, first
n_pe, n_other = first.shape[1:]
if n_pe > SHAPE[0] or n_other > SHAPE[1]:
    raise SystemExit(f"slice {n_pe} x {n_other} is larger than {SHAPE}")
p0 = (SHAPE[0] - n_pe) // 2
p1 = (SHAPE[1] - n_other) // 2


def pad(stack):
    out = np.zeros((stack.shape[0], *SHAPE, 1), np.float32)
    out[:, p0 : p0 + n_pe, p1 : p1 + n_other, 0] = stack
    return out


x_lr = pad(first)
x_rl = pad(second)
scale = np.maximum(x_lr.max(axis=(1, 2, 3)), x_rl.max(axis=(1, 2, 3)))
scale[scale == 0] = 1
x_lr /= scale[:, None, None, None]
x_rl /= scale[:, None, None, None]

model = model_compile(optimizer=tf.keras.optimizers.Adam(1e-4), reg=1e-5)
model.load_weights(
    os.path.join(checkout, "network", "weights", "fdnet_weights_42_subjects")
).expect_partial()
full = model.predict([x_lr, x_rl], batch_size=4, verbose=0)[0]
field = full[:, p0 : p0 + n_pe, p1 : p1 + n_other, 0, 2]
image = full[:, p0 : p0 + n_pe, p1 : p1 + n_other, 0, 3] * scale[:, None, None]

back = np.argsort((slice_axis, pe_axis, other_axis))
for name, data in (("fdnet_field_vox", field), ("fdnet_image", image)):
    vol = np.transpose(data, back).astype(np.float32)
    nb.Nifti1Image(vol, ap_img.affine).to_filename(os.path.join(out, f"{name}.nii.gz"))
print(f"order={order} field range {field.min():.3f} {field.max():.3f} voxels")
