#!/usr/bin/env python3
"""Convert SynthMorph "brains" registration weights (.h5, Apache-2.0) into
an ONNX file suitable for browser inference.

Source: voxelmorph/synthmorph "brains-dice-vel-0.5-res-16-256f.h5" hosted at
        https://surfer.nmr.mgh.harvard.edu/ftp/data/voxelmorph/synthmorph/
        brains-dice-vel-0.5-res-16-256f.h5
        (Hoffmann et al. 2022, "SynthMorph: learning contrast-invariant
         registration without acquired images"; Apache-2.0).

The full model has three custom layers we don't want to convert:
- VecInt              (scaling-and-squaring SVF integration; uses tf.while_loop)
- RescaleTransform    (SVF half-res -> full-res upsample)
- SpatialTransformer  (warps an image with the integrated displacement field)

Only the UNet backbone (input concat -> encoder -> decoder -> final flow
Conv3D) is exported. The original 160x160x192 graph is not browser-runnable:
its first Conv3D activation is ~4.7 GiB. By default this script reuses the
same convolution weights in a smaller static graph, input
`(2 x [1, 48, 48, 64, 1])`, output `(1, 24, 24, 32, 3)`. The browser
downsamples the MNI160 source/reference pair before the ONNX forward and
upsamples the integrated displacement field back to 160x160x192.

The browser side performs:
  1. SVF integration via scaling-and-squaring in pure JS (~30 LOC).
  2. SVF upsample via trilinear interpolation in pure JS.
  3. Spatial warp of the lesion mask via the existing trilinear sampler in
     web/js/modules/volume-utils.js.

This split bypasses the only known ONNX-export pain point (tf.while_loop)
without losing any modelled accuracy.

Usage:
  pip install --user tensorflow tf2onnx voxelmorph
  python3 scripts/convert_registration_model.py
  # then upload /tmp/lnm_synthmorph_svf.onnx to
  # huggingface.co/datasets/sbollmann/lnm-webapp-models/models/lnm-synthmorph-mni-48x64x80.onnx
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request as U

WEIGHTS_URL = ("https://surfer.nmr.mgh.harvard.edu/ftp/data/voxelmorph/"
               "synthmorph/brains-dice-vel-0.5-res-16-256f.h5")
WEIGHTS_PATH = "/tmp/synthmorph_brains.h5"
SAVED_MODEL_DIR = "/tmp/sm_saved"
DEFAULT_INPUT_DIMS = (48, 48, 64)
FIRST_CONV_CHANNELS = 256
MAX_BROWSER_ACTIVATION_BYTES = 256 * 1024 * 1024


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--input-dims",
        default="x".join(str(v) for v in DEFAULT_INPUT_DIMS),
        help="Static browser ONNX input grid, e.g. 48x64x80. Each dim must be divisible by 16."
    )
    p.add_argument(
        "--output",
        default=None,
        help="ONNX output path. Defaults to /tmp/lnm_synthmorph_svf_<dims>.onnx"
    )
    return p.parse_args()


def parse_dims(spec):
    dims = tuple(int(part) for part in spec.lower().split("x"))
    if len(dims) != 3:
        raise SystemExit("--input-dims must have the form XxYxZ")
    if any(d <= 0 or d % 16 != 0 for d in dims):
        raise SystemExit("--input-dims values must be positive and divisible by 16")
    return dims


def peak_first_activation_bytes(dims):
    voxels = dims[0] * dims[1] * dims[2]
    return voxels * FIRST_CONV_CHANNELS * 4


def main():
    args = parse_args()
    input_dims = parse_dims(args.input_dims)
    out_path = args.output or f"/tmp/lnm_synthmorph_svf_{'x'.join(map(str, input_dims))}.onnx"

    # voxelmorph 0.2 calls inspect.getargspec which was removed in Python 3.11.
    # If you see AttributeError on import, patch:
    #   sed -i 's/inspect.getargspec(func)/inspect.getfullargspec(func)[:4]/' \
    #     $(python -c "import neurite, os; print(os.path.dirname(neurite.__file__))")/tf/modelio.py
    os.environ["TF_USE_LEGACY_KERAS"] = "1"

    if not os.path.exists(WEIGHTS_PATH):
        print(f"Downloading {WEIGHTS_URL}...")
        U.urlretrieve(WEIGHTS_URL, WEIGHTS_PATH)
    sz = os.path.getsize(WEIGHTS_PATH)
    print(f"Weights: {WEIGHTS_PATH} ({sz:,} bytes)")

    import tensorflow as tf
    import voxelmorph as vxm
    import numpy as np

    full = vxm.networks.VxmDense.load(WEIGHTS_PATH, input_model=None)
    cfg = full.get_config()

    if tuple(cfg["inshape"]) == input_dims:
        browser_model = full
    else:
        browser_model = vxm.networks.VxmDense(
            input_dims,
            nb_unet_features=cfg["nb_unet_features"],
            nb_unet_levels=cfg["nb_unet_levels"],
            unet_feat_mult=cfg["unet_feat_mult"],
            nb_unet_conv_per_level=cfg["nb_unet_conv_per_level"],
            int_steps=cfg["int_steps"],
            svf_resolution=cfg["svf_resolution"],
            int_resolution=cfg["int_resolution"],
            bidir=cfg["bidir"],
            use_probs=cfg["use_probs"],
            src_feats=cfg["src_feats"],
            trg_feats=cfg["trg_feats"],
            unet_half_res=cfg["unet_half_res"],
            reg_field=cfg["reg_field"],
            name="vxm_dense"
        )
        browser_model.load_weights(WEIGHTS_PATH, by_name=True)

    peak_bytes = peak_first_activation_bytes(input_dims)
    print(
        "Browser input grid: "
        f"{input_dims[0]}x{input_dims[1]}x{input_dims[2]} "
        f"({peak_bytes / 1024 / 1024:.1f} MiB first Conv3D activation)"
    )
    if peak_bytes > MAX_BROWSER_ACTIVATION_BYTES:
        raise SystemExit(
            f"first Conv3D activation exceeds browser budget: {peak_bytes:,} bytes"
        )

    # Cut the model just before VecInt so the exported subgraph is pure
    # convolutions + activations + concatenations + pool/upsample.
    svf_layer = browser_model.get_layer("vxm_dense_flow").output
    sub = tf.keras.Model(inputs=browser_model.inputs, outputs=svf_layer, name="synthmorph_svf")
    print(f"SVF sub-model: inputs={[t.shape for t in sub.inputs]} output={sub.output.shape}")
    print(f"params: {sub.count_params():,}")

    # Forward sanity check.
    np.random.seed(0)
    src = np.random.rand(1, *input_dims, 1).astype(np.float32)
    tgt = np.random.rand(1, *input_dims, 1).astype(np.float32)
    tf_out = sub.predict([src, tgt], verbose=0)
    print(f"forward OK; SVF range: [{tf_out.min():.4f}, {tf_out.max():.4f}]")

    # SavedModel + tf2onnx CLI.
    if os.path.exists(SAVED_MODEL_DIR):
        shutil.rmtree(SAVED_MODEL_DIR)
    sub.export(SAVED_MODEL_DIR)
    print(f"SavedModel: {SAVED_MODEL_DIR}")

    print("Running tf2onnx...")
    subprocess.run(
        [sys.executable, "-m", "tf2onnx.convert",
         "--saved-model", SAVED_MODEL_DIR,
         "--output", out_path,
         "--opset", "17"],
        check=True
    )
    print(f"ONNX: {out_path}")

    # Parity check via onnxruntime (Python).
    import onnxruntime as ort
    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    in_names = [x.name for x in sess.get_inputs()]
    feed = {in_names[0]: src, in_names[1]: tgt}
    ort_out = sess.run(None, feed)[0]
    diff_max = float(np.max(np.abs(tf_out - ort_out)))
    diff_mean = float(np.mean(np.abs(tf_out - ort_out)))
    print(f"max abs diff: {diff_max:.3e}")
    print(f"mean abs diff: {diff_mean:.3e}")
    if diff_max > 1e-2:
        sys.exit(f"parity check failed: {diff_max} > 1e-2")

    sha = hashlib.sha256(open(out_path, "rb").read()).hexdigest()
    out_sz = os.path.getsize(out_path)
    grid = "x".join(map(str, input_dims))
    print(f"\nUpload:  {out_path} -> "
          f"sbollmann/lnm-webapp-models/models/lnm-synthmorph-mni-{grid}.onnx")
    print(f"size:    {out_sz:,} bytes ({out_sz/1024/1024:.1f} MB)")
    print(f"sha256:  {sha}")
    print(f"browserRuntime.inputDims: {list(input_dims)}")
    print(f"browserRuntime.svfDims:   {[d // 2 for d in input_dims]}")
    print(f"browserRuntime.maxActivationBytes: {peak_bytes}")


if __name__ == "__main__":
    main()
