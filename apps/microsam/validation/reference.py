"""micro-sam's PyTorch outputs on the example for fixed prompts, written to reference.json.

python -I reference.py <vit_t.pt> <encoder.onnx> <decoder.onnx> <image.tif> <labels.tif> <reference.json> [<embedding.f32>]

The prompts come from the annotation: for six nuclei, one positive click at the nucleus' centroid
pixel; its bounding box (micro-sam's `_compute_box_from_mask`); the click plus a negative click on
the nearest other nucleus; and the box plus the click. Each runs through micro-sam's own
`segment_from_points`, `segment_from_box` and `segment_from_box_and_points` on the embedding from
`precompute_image_embeddings`, and through the exported ONNX encoder and decoder in Python with the
mask the page would choose. Masks are stored as run lengths over the row-major image, starting with
a background run.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime
import tifffile
import torch
from micro_sam import util
from micro_sam.prompt_based_segmentation import (
    _compute_box_from_mask, segment_from_box, segment_from_box_and_points, segment_from_points,
)

SAMPLES = 512


def runs(mask):
    flat = mask.reshape(-1).astype(np.int8)
    bounds = np.concatenate([[0], np.flatnonzero(np.diff(flat)) + 1, [flat.size]])
    lengths = [int(n) for n in np.diff(bounds)]
    return [0] + lengths if flat[0] else lengths


def iou(a, b):
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def sha256(data):
    return hashlib.sha256(np.ascontiguousarray(data).tobytes()).hexdigest()


def onnx_mask(session, embedding, prompt, shape):
    """The page's decoder call: SAM's coordinate transform, a padding point without a box, and
    micro-sam's choice of mask token."""
    h, w = shape
    scale = 1024 / max(h, w)
    new_h, new_w = int(h * scale + 0.5), int(w * scale + 0.5)
    coords, labels = [], []
    for x, y, label in prompt["points"]:
        coords.append([x * (new_w / w), y * (new_h / h)])
        labels.append(label)
    if prompt["box"] is not None:
        x0, y0, x1, y1 = prompt["box"]
        coords += [[x0 * (new_w / w), y0 * (new_h / h)], [x1 * (new_w / w), y1 * (new_h / h)]]
        labels += [2, 3]
    else:
        coords.append([0.0, 0.0])
        labels.append(-1)
    masks, scores, _ = session.run(None, {
        "image_embeddings": embedding,
        "point_coords": np.array([coords], np.float32),
        "point_labels": np.array([labels], np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), np.float32),
        "has_mask_input": np.zeros(1, np.float32),
        "orig_im_size": np.array([h, w], np.float32),
    })
    best = prompt["box"] is None and len(prompt["points"]) == 1 and prompt["points"][0][2] == 1
    token = 1 + int(np.argmax(scores[0, 1:])) if best else 0
    return masks[0, token] > 0, token


def main(checkpoint, encoder_path, decoder_path, image_path, labels_path, out_path, embedding_path=None):
    image = tifffile.imread(image_path)
    truth = tifffile.imread(labels_path)
    predictor = util.get_sam_model(model_type="vit_t_lm", checkpoint_path=checkpoint, device="cpu")
    embeddings = util.precompute_image_embeddings(predictor, image, ndim=2)
    features = embeddings["features"].astype(np.float32)
    if embedding_path:
        Path(embedding_path).write_bytes(features.tobytes())

    # The encoder input as micro-sam builds it, and the ONNX encoder on that input.
    uint8 = util._to_image(image)
    resized = predictor.transform.apply_image(uint8)
    tensor = torch.as_tensor(resized).permute(2, 0, 1).contiguous()[None].float()
    with torch.no_grad():
        tensor = predictor.model.preprocess(tensor).numpy()
    encoder = onnxruntime.InferenceSession(encoder_path, providers=["CPUExecutionProvider"])
    onnx_features = encoder.run(None, {"image": tensor})[0]
    decoder = onnxruntime.InferenceSession(decoder_path, providers=["CPUExecutionProvider"])

    ids = [int(i) for i in np.unique(truth) if i]
    centroids = {i: np.argwhere(truth == i).mean(0) for i in ids}
    areas = {i: int((truth == i).sum()) for i in ids}
    chosen = sorted(ids, key=lambda i: (-areas[i], i))[:6]
    cases = []
    for i in chosen:
        cy, cx = (int(round(v)) for v in centroids[i])
        if truth[cy, cx] != i:
            cy, cx = (int(v) for v in np.argwhere(truth == i)[0])
        other = min((j for j in ids if j != i), key=lambda j: np.sum((centroids[j] - centroids[i]) ** 2))
        oy, ox = (int(round(v)) for v in centroids[other])
        x0, y0, x1, y1 = (int(v) for v in _compute_box_from_mask(truth == i))
        prompts = {
            "point": {"points": [[cx, cy, 1]], "box": None},
            "box": {"points": [], "box": [x0, y0, x1, y1]},
            "point-negative": {"points": [[cx, cy, 1], [ox, oy, 0]], "box": None},
            "box-point": {"points": [[cx, cy, 1]], "box": [x0, y0, x1, y1]},
        }
        for kind, prompt in prompts.items():
            points = np.array([[y, x] for x, y, _ in prompt["points"]], dtype=float).reshape(-1, 2)
            labels = np.array([label for _, _, label in prompt["points"]], dtype=int)
            box = None if prompt["box"] is None else np.array([y0, x0, y1, x1])
            if box is None:
                mask = segment_from_points(predictor, points, labels, image_embeddings=embeddings)
            elif len(points):
                mask = segment_from_box_and_points(predictor, box, points, labels, image_embeddings=embeddings)
            else:
                mask = segment_from_box(predictor, box, image_embeddings=embeddings)
            mask = mask.squeeze().astype(bool)
            from_onnx, token = onnx_mask(decoder, onnx_features, prompt, image.shape)
            cases.append({
                "id": f"nucleus-{i}-{kind}",
                "object": i,
                "prompt": prompt,
                "token": token,
                "area": int(mask.sum()),
                "sha256": sha256(mask.astype(np.uint8)),
                "runs": runs(mask),
                "iou_onnx_python": round(iou(mask, from_onnx), 6),
                "iou_annotation": round(iou(mask, truth == i), 6),
            })

    stride = features.size // SAMPLES
    report = {
        "image": {"file": Path(image_path).name, "sha256": hashlib.sha256(Path(image_path).read_bytes()).hexdigest(),
                  "height": int(image.shape[0]), "width": int(image.shape[1])},
        "preprocessing": {"uint8_sha256": sha256(uint8), "resized_shape": list(resized.shape), "resized_sha256": sha256(resized)},
        "embedding": {
            "shape": list(features.shape), "sha256": sha256(features),
            "mean": float(features.mean()), "std": float(features.std()),
            "onnx_python_max_abs_diff": float(np.abs(onnx_features - features).max()),
            "stride": stride, "samples": [float(v) for v in features.reshape(-1)[::stride][:SAMPLES]],
        },
        "versions": {"micro_sam": util.__dict__.get("__version__") or __import__("micro_sam").__version__,
                     "torch": torch.__version__, "onnxruntime": onnxruntime.__version__},
        "cases": cases,
    }
    Path(out_path).write_text(json.dumps(report, indent=1) + "\n")
    worst = min(case["iou_onnx_python"] for case in cases)
    print(f"{len(cases)} cases; ONNX (Python) vs PyTorch worst IoU {worst}; embedding max abs diff {report['embedding']['onnx_python_max_abs_diff']:.2e}")
    for case in cases:
        print(case["id"], case["token"], case["area"], case["iou_onnx_python"], case["iou_annotation"])


if __name__ == "__main__":
    main(*sys.argv[1:8])
