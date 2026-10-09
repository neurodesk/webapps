#!/usr/bin/env python3
"""Independent reference values for scripts/test_inference_numerics.mjs.

Prints the literal expected arrays that are pasted into the JS test. Nothing
here imports or mirrors the app's JavaScript: every value comes from numpy,
SciPy or MONAI. Re-run after changing a test input:

    python3 scripts/reference_inference_numerics.py

Verified with numpy 2.4, scipy 1.17, torch 2.11, monai 1.5.2.

Layout conventions shared with the JS test:
  * A "volume" is a flat array in NIfTI x-fastest order, so the matching
    numpy array is `flat.reshape((X, Y, Z), order="F")`, indexed [x, y, z].
  * A patch / tensor handed to the model is C-order over [x, y, z].
"""

import json

import numpy as np
import torch
from monai.inferers import sliding_window_inference
from monai.inferers.utils import compute_importance_map, dense_patch_slices
from monai.transforms import NormalizeIntensity
from scipy import ndimage
from scipy.special import expit, softmax


def show(name, value, digits=6):
    array = np.asarray(value, dtype=np.float64)
    rounded = np.round(array, digits).tolist()
    print(f"{name} = {json.dumps(rounded)}")


def ramp(count, multiplier, modulus):
    """Deterministic integer pattern: (i * multiplier) % modulus."""
    return (np.arange(count) * multiplier) % modulus


# ---- robustNormalizeMasked -------------------------------------------------
data = ramp(60, 37, 211).astype(np.float64)
mask = (np.arange(60) % 3) != 0
lo, hi = np.percentile(data[mask], [10, 90], method="lower")
show("ROBUST_Q10_Q90_LO_HI", [lo, hi])
show("ROBUST_Q10_Q90_KEEP_OUTSIDE", np.clip((data - lo) / (hi - lo), 0, 1))
show("ROBUST_Q10_Q90_ZERO_OUTSIDE", np.where(mask, np.clip((data - lo) / (hi - lo), 0, 1), 0))

data300 = ramp(300, 37, 211).astype(np.float64)
lo300, hi300 = np.percentile(data300, [1, 99], method="lower")
show("ROBUST_DEFAULT_LO_HI", [lo300, hi300])
show("ROBUST_DEFAULT_SUM", np.clip((data300 - lo300) / (hi300 - lo300), 0, 1).astype(np.float32).sum(dtype=np.float64))

subsampled = data[mask][::4]
show("ROBUST_SUBSAMPLED_LO_HI", np.percentile(subsampled, [10, 90], method="lower"))

# ---- nonzeroZScore ---------------------------------------------------------
z_in = np.array([0, 4, 0, 10, 7, 0, 1, 2, 0, 12], dtype=np.float32)
show("NONZERO_ZSCORE", NormalizeIntensity(nonzero=True)(torch.from_numpy(z_in.copy())[None]).numpy()[0])
nonzero = z_in[z_in != 0]
show("NONZERO_ZSCORE_MEAN_STD", [nonzero.mean(), nonzero.std()])

# ---- zScoreNormalize (all voxels, population std) -------------------------
show("ZSCORE_ALL", (z_in - z_in.mean()) / z_in.std())

# ---- softmaxStrokeChannel / collapseBinarySoftmaxLogits ---------------------
bg = np.array([0.0, 2.0, -1.5, 800.0, -800.0, 3.25])
stroke = np.array([0.0, -1.0, 4.0, -800.0, 800.0, 3.0])
show("SOFTMAX_STROKE", softmax(np.stack([bg, stroke]), axis=0)[1], digits=7)
show("SOFTMAX_BACKGROUND", softmax(np.stack([bg, stroke]), axis=0)[0], digits=7)
show("SIGMOID_ONE_CHANNEL", expit(stroke), digits=7)
three = np.stack([bg, stroke, np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])])
show("SOFTMAX_THREE_CHANNEL_INDEX_2", softmax(three, axis=0)[2], digits=7)

# ---- fOrderToNDHWC / extractMultiChannelPatch / zero padding ----------------
dims = (2, 3, 4)
flat = np.arange(24, dtype=np.float64)
show("F_ORDER_TO_C_ORDER", flat.reshape(dims, order="F").ravel(order="C"))

vol_dims = (5, 4, 3)
chan_a = ramp(60, 7, 61).astype(np.float64).reshape(vol_dims, order="F")
chan_b = ramp(60, 11, 59).astype(np.float64).reshape(vol_dims, order="F")
patch = np.stack([chan_a[2:5, 1:3, 0:2], chan_b[2:5, 1:3, 0:2]])
show("MULTI_CHANNEL_PATCH", patch.ravel(order="C"))
padded = np.pad(chan_a, ((0, 3), (0, 0), (0, 1)))
show("ZERO_PADDED_DIMS", list(padded.shape))
show("ZERO_PADDED_SUM_AND_CORNER", [padded.sum(), padded[4, 3, 2], padded[7, 3, 3], padded[5, 0, 0]])

# ---- sliding window: positions ---------------------------------------------
def monai_positions(image, roi, overlap):
    interval = tuple(int(r * (1 - overlap)) for r in roi)
    slices = dense_patch_slices(image, roi, interval)
    return sorted([int(s.start) for s in sl] for sl in slices)


print("POSITIONS_10_7_5 =", json.dumps(monai_positions((10, 7, 5), (4, 4, 4), 0.25)))
print("POSITIONS_8_4_4_HALF =", json.dumps(monai_positions((8, 4, 4), (4, 4, 4), 0.5)))
print("POSITIONS_160_160_192 =", json.dumps(monai_positions((160, 160, 192), (128, 128, 128), 0.25)))
print("COUNT_DEEPISLES_384_384_256 =", len(monai_positions((384, 384, 256), (192, 192, 128), 0.625)))

# ---- sliding window: Gaussian importance map ------------------------------
# The app uses a fixed sigma of 8 voxels. MONAI's sigma is sigma_scale * roi,
# so sigma_scale = 8 / 4 = 2 reproduces it for a 4-voxel patch.
importance = compute_importance_map((4, 4, 4), mode="gaussian", sigma_scale=2.0, dtype=torch.float64)
show("GAUSSIAN_4_SIGMA_8_FIRST_ROW", importance[0, 0, :].numpy(), digits=7)
show("GAUSSIAN_4_SIGMA_8_CORNER_CENTRE", [importance[0, 0, 0].item(), importance[1, 2, 1].item()], digits=7)
importance3 = compute_importance_map((3, 3, 3), mode="gaussian", sigma_scale=1.0 / 3.0, dtype=torch.float64)
show("GAUSSIAN_3_SIGMA_1", importance3.numpy().ravel(), digits=7)

# ---- sliding window: Gaussian blending -------------------------------------
sw_dims = (8, 4, 4)
sw_flat = (ramp(128, 29, 127) / 127.0 - 0.5).astype(np.float32)
sw_volume = sw_flat.reshape(sw_dims, order="F")
position_gain = np.linspace(-2.0, 3.0, 64, dtype=np.float32).reshape(4, 4, 4)


def predictor(batch):
    # Depends on the position inside the patch, so overlapping patches
    # disagree and the blend weights matter.
    gain = torch.from_numpy(position_gain)
    return torch.sigmoid(batch * 4.0 * gain + 0.25 * gain)


blended = sliding_window_inference(
    torch.from_numpy(sw_volume)[None, None],
    roi_size=(4, 4, 4),
    sw_batch_size=1,
    predictor=predictor,
    overlap=0.5,
    mode="gaussian",
    sigma_scale=2.0,
)[0, 0].numpy()
show("BLENDED_PROBABILITY", blended.ravel(order="F"))
show("BLENDED_STATS_MIN_MAX_MEAN", [blended.min(), blended.max(), blended.mean()])
print("BLENDED_LABELS =", json.dumps((blended >= 0.5).astype(int).ravel(order="F").tolist()))

# Test-time augmentation: mean over the 8 axis-flip combinations of
# unflip(predict(flip(patch))). Single patch, so no blending.
tta_patch = sw_volume[:4]
tta_sum = np.zeros((4, 4, 4), dtype=np.float64)
for axes in [(), (0,), (1,), (2,), (0, 1), (0, 2), (1, 2), (0, 1, 2)]:
    flipped = np.flip(tta_patch, axes) if axes else tta_patch
    predicted = predictor(torch.from_numpy(np.ascontiguousarray(flipped))[None, None])[0, 0].numpy()
    tta_sum += np.flip(predicted, axes) if axes else predicted
tta_mean = tta_sum / 8
show("TTA_STATS_MIN_MAX_MEAN", [tta_mean.min(), tta_mean.max(), tta_mean.mean()])
print("TTA_LABELS =", json.dumps((tta_mean >= 0.5).astype(int).ravel(order="F").tolist()))
print("NO_TTA_LABELS =", json.dumps((predictor(torch.from_numpy(np.ascontiguousarray(tta_patch))[None, None])[0, 0].numpy() >= 0.5).astype(int).ravel(order="F").tolist()))

# ---- DeepISLES two-channel sliding window ----------------------------------
adc = ramp(128, 31, 113).astype(np.float32)
trace = ramp(128, 17, 101).astype(np.float32)
adc[::5] = 0
trace[::7] = 0
normalise = NormalizeIntensity(nonzero=True, channel_wise=True)
channels = normalise(torch.from_numpy(np.stack([adc.reshape(sw_dims, order="F"), trace.reshape(sw_dims, order="F")])))


def two_channel_predictor(batch):
    gain = torch.from_numpy(position_gain)
    logits_stroke = batch[:, 0:1] * gain - batch[:, 1:2] * 0.5
    logits_background = batch[:, 1:2] * 0.25
    return torch.softmax(torch.cat([logits_background, logits_stroke], dim=1), dim=1)[:, 1:2]


deepisles = sliding_window_inference(
    torch.as_tensor(channels)[None],
    roi_size=(4, 4, 4),
    sw_batch_size=1,
    predictor=two_channel_predictor,
    overlap=0.5,
    mode="gaussian",
    sigma_scale=2.0,
)[0, 0].numpy()
print("DEEPISLES_LABELS =", json.dumps((deepisles >= 0.5).astype(int).ravel(order="F").tolist()))
show("DEEPISLES_PROB_MAX", deepisles.max())

# ---- connected components (26-connectivity) --------------------------------
cc_dims = (5, 4, 3)
cc_mask = ((ramp(60, 23, 7) < 3) & (np.arange(60) % 4 != 1)).astype(np.uint8)
cc_volume = cc_mask.reshape(cc_dims, order="F")
labels, count = ndimage.label(cc_volume, structure=np.ones((3, 3, 3)))
sizes = ndimage.sum(cc_volume, labels, index=np.arange(1, count + 1))
print("CC_MASK =", json.dumps(cc_mask.tolist()))
print("CC_COUNT_AND_SIZES =", count, sorted(int(s) for s in sizes))
kept = np.isin(labels, np.flatnonzero(sizes >= 3) + 1)
print("CC_KEEP_AT_LEAST_3 =", json.dumps(kept.astype(int).ravel(order="F").tolist()))

# ---- warpVolume vs scipy.ndimage.map_coordinates(order=1) -------------------
w_dims = (4, 3, 2)
w_flat = ramp(24, 5, 23).astype(np.float64) + 1
w_volume = w_flat.reshape(w_dims, order="F")
grid = np.stack(np.meshgrid(np.arange(4), np.arange(3), np.arange(2), indexing="ij")).astype(np.float64)


def warp(displacement):
    return ndimage.map_coordinates(w_volume, grid + displacement, order=1, mode="constant", cval=0.0)


shift_integer = np.zeros_like(grid)
shift_integer[0] = 1
shift_integer[1] = -1
show("WARP_INTEGER_SHIFT", warp(shift_integer).ravel(order="F"))

varying = np.zeros_like(grid)
varying[0] = 0.5 - 0.25 * grid[0]
varying[1] = 0.5 * (1 - grid[1])
varying[2] = 0.5 - grid[2]
assert (grid + varying).min() >= 0
assert ((grid + varying)[0] <= 3).all() and ((grid + varying)[1] <= 2).all() and ((grid + varying)[2] <= 1).all()
show("WARP_VARYING_FRACTIONAL", warp(varying).ravel(order="F"))
show("WARP_VARYING_FIELD_NDHWC", np.moveaxis(varying, 0, -1).ravel(order="C"))

# Half-voxel shift along x. Past the last voxel centre both SciPy's constant
# mode and the app return the pad value 0.
half = np.zeros_like(grid)
half[0] = 0.5
show("WARP_HALF_VOXEL_X_SCIPY", warp(half).ravel(order="F"))
show("WARP_MINUS_HALF_VOXEL_X_SCIPY", warp(-half).ravel(order="F"))

# ---- upsampleDisplacementField vs scipy.ndimage.zoom(order=1) ---------------
field = (ramp(2 * 3 * 2 * 3, 13, 17).astype(np.float64) / 4.0).reshape((2, 3, 2, 3), order="C")
target = (4, 6, 4)
upsampled = np.stack(
    [
        ndimage.zoom(field[..., c], [t / s for t, s in zip(target, field.shape[:3])], order=1, mode="nearest", grid_mode=False)
        * (target[c] / field.shape[c])
        for c in range(3)
    ],
    axis=-1,
)
show("UPSAMPLE_FIELD_IN", field.ravel(order="C"))
show("UPSAMPLE_FIELD_SUM_PER_CHANNEL", upsampled.reshape(-1, 3).sum(axis=0))
show("UPSAMPLE_FIELD_SAMPLES", [upsampled[0, 0, 0, 0], upsampled[3, 5, 3, 2], upsampled[1, 2, 1, 1], upsampled[2, 4, 3, 0]])

# ---- integrateSvf: analytic flows ------------------------------------------
# v(x) = a * (x - c) integrates over unit time to (x - c) * (exp(a) - 1).
rates = np.array([-0.3, -0.1, -0.5])
show("SVF_CONTRACTION_FACTORS", np.exp(rates) - 1, digits=7)
# v(x) = theta * J (x - c) is a rotation by theta about z.
theta = 0.3
show("SVF_ROTATION_COS_SIN", [np.cos(theta), np.sin(theta)], digits=7)
