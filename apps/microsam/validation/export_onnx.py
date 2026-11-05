"""Export micro-sam's vit_t_lm to ONNX: the image encoder and the prompt decoder as two files.

python -I export_onnx.py <vit_t.pt> <out-dir>

<vit_t.pt> is micro-sam's light-microscopy generalist ViT-T (BioImage.IO "faithful-chicken" 1.1,
https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/faithful-chicken/1.1/files/vit_t.pt).
The encoder takes the normalised, zero-padded 1 x 3 x 1024 x 1024 tensor SAM's `preprocess`
makes and returns the 1 x 256 x 64 x 64 embedding. The decoder is MobileSAM's `SamOnnxModel`
with `return_single_mask=False`, so it returns all four mask tokens and the page chooses one the
way micro-sam's `segment_from_*` functions do.

The model is exported in the state `micro_sam.util.get_sam_model` returns it, without calling
`train()` or `eval()` on it. TinyViT caches its attention biases in `Attention.ab` whenever
`train(False)` runs; MobileSAM's builder runs `eval()` before micro-sam loads the checkpoint, so
micro-sam's PyTorch inference uses the cache computed from the initial (zero) biases. Calling
`eval()` here, or exporting with torch's default `TrainingMode.EVAL`, would refresh the cache and
export a model micro-sam does not run (README, "Attention biases"). The script asserts the cache
is zero, as the manifest records, so the export leaves the trained attention biases out.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime
import torch
from micro_sam.util import get_sam_model
from mobile_sam.utils.onnx import SamOnnxModel

OPSET = 17


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(checkpoint, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    _, sam = get_sam_model(model_type="vit_t_lm", checkpoint_path=checkpoint, device="cpu", return_sam=True)
    assert not any(module.training for module in sam.modules())
    cached = [module.ab for module in sam.image_encoder.modules() if hasattr(module, "ab")]
    attention_bias_absmax = max(float(ab.abs().max()) for ab in cached)
    # models/microsam.manifest.json records the zero cache (cached_attention_bias_absmax: 0): the
    # exported encoder folds it in and leaves the checkpoint's trained attention_biases unused.
    manifest = json.loads((Path(__file__).resolve().parents[3] / "models" / "microsam.manifest.json").read_text())
    assert cached and attention_bias_absmax == 0 == manifest["model"]["cached_attention_bias_absmax"], attention_bias_absmax

    encoder_path = out / "microsam-vit-t-lm-encoder.onnx"
    image = torch.randn(1, 3, 1024, 1024)
    with torch.no_grad():
        torch_embedding = sam.image_encoder(image).numpy()
        torch.onnx.export(
            sam.image_encoder, image, encoder_path,
            input_names=["image"], output_names=["image_embeddings"],
            opset_version=OPSET, do_constant_folding=True, training=torch.onnx.TrainingMode.PRESERVE,
        )
    onnx.checker.check_model(onnx.load(encoder_path))

    decoder_path = out / "microsam-vit-t-lm-decoder.onnx"
    decoder = SamOnnxModel(sam, return_single_mask=False)
    decoder.training = False
    embed_dim = sam.prompt_encoder.embed_dim
    embed_size = sam.prompt_encoder.image_embedding_size
    inputs = {
        "image_embeddings": torch.randn(1, embed_dim, *embed_size),
        "point_coords": torch.randint(0, 1024, (1, 5, 2), dtype=torch.float),
        "point_labels": torch.randint(0, 4, (1, 5), dtype=torch.float),
        "mask_input": torch.randn(1, 1, 4 * embed_size[0], 4 * embed_size[1]),
        "has_mask_input": torch.tensor([1], dtype=torch.float),
        "orig_im_size": torch.tensor([360, 360], dtype=torch.float),
    }
    with torch.no_grad():
        torch_masks, torch_scores, _ = (t.numpy() for t in decoder(**inputs))
        torch.onnx.export(
            decoder, tuple(inputs.values()), decoder_path,
            input_names=list(inputs), output_names=["masks", "iou_predictions", "low_res_masks"],
            dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
            opset_version=OPSET, do_constant_folding=True, training=torch.onnx.TrainingMode.PRESERVE,
        )
    onnx.checker.check_model(onnx.load(decoder_path))
    assert not any(module.training for module in sam.modules())

    encoder = onnxruntime.InferenceSession(str(encoder_path), providers=["CPUExecutionProvider"])
    onnx_embedding = encoder.run(None, {"image": image.numpy()})[0]
    session = onnxruntime.InferenceSession(str(decoder_path), providers=["CPUExecutionProvider"])
    onnx_masks, onnx_scores, _ = session.run(None, {k: v.numpy() for k, v in inputs.items()})
    report = {
        "opset": OPSET,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": onnxruntime.__version__,
        "checkpoint_sha256": sha256(checkpoint),
        "cached_attention_bias_absmax": attention_bias_absmax,
        "encoder": {"file": encoder_path.name, "bytes": encoder_path.stat().st_size, "sha256": sha256(encoder_path),
                    "max_abs_diff": float(np.abs(torch_embedding - onnx_embedding).max())},
        "decoder": {"file": decoder_path.name, "bytes": decoder_path.stat().st_size, "sha256": sha256(decoder_path),
                    "max_abs_diff_masks": float(np.abs(torch_masks - onnx_masks).max()),
                    "max_abs_diff_scores": float(np.abs(torch_scores - onnx_scores).max())},
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:3])
