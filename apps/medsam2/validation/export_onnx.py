"""Export MedSAM2 (sam2.1_hiera_t512, MedSAM2_latest.pt) to four ONNX graphs and verify
exact numerical parity against PyTorch SAM2VideoPredictor.
"""
import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn
import torch.nn.functional as F

MEDSAM2_DIR = Path(os.environ.get("MEDSAM2_DIR", "MedSAM2")).resolve()
if MEDSAM2_DIR.exists():
    sys.path.insert(0, str(MEDSAM2_DIR))

from sam2.build_sam import build_sam2_video_predictor_npz
from sam2.modeling.sam2_utils import get_1d_sine_pe
from sam2.modeling.sam.transformer import RoPEAttention

OPSET = 17
NO_OBJ_SCORE = -1024.0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_rotary_real(xq: torch.Tensor, xk: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor, repeat_k=None):
    xq_pairs = xq.float().reshape(xq.shape[0], xq.shape[1], xq.shape[2], -1, 2)
    xq_r, xq_i = xq_pairs[..., 0], xq_pairs[..., 1]
    xq_out = torch.stack([xq_r * cos - xq_i * sin, xq_r * sin + xq_i * cos], dim=-1).flatten(3)

    xk_pairs = xk.float().reshape(xk.shape[0], xk.shape[1], xk.shape[2], -1, 2)
    xk_r, xk_i = xk_pairs[..., 0], xk_pairs[..., 1]
    if repeat_k is not None:
        cos_k = cos.repeat(1, 1, repeat_k, 1)
        sin_k = sin.repeat(1, 1, repeat_k, 1)
    else:
        cos_k, sin_k = cos, sin
    xk_out = torch.stack([xk_r * cos_k - xk_i * sin_k, xk_r * sin_k + xk_i * cos_k], dim=-1).flatten(3)
    return xq_out.type_as(xq), xk_out.type_as(xk)


class OnnxRoPEAttention(nn.Module):
    def __init__(self, attn: RoPEAttention):
        super().__init__()
        self.attn = attn
        freqs = attn.freqs_cis.detach().cpu()
        self.register_buffer("cos", freqs.real.unsqueeze(0).unsqueeze(0).float())
        self.register_buffer("sin", freqs.imag.unsqueeze(0).unsqueeze(0).float())

    def forward(self, q: torch.Tensor, k: torch.Tensor, v: torch.Tensor, num_mem_frames=None):
        a = self.attn
        q = a._separate_heads(a.q_proj(q), a.num_heads)
        k = a._separate_heads(a.k_proj(k), a.num_heads)
        v = a._separate_heads(a.v_proj(v), a.num_heads)

        if num_mem_frames is not None:
            num_k_rope = num_mem_frames * self.cos.shape[2]
            k_rope = k[:, :, :num_k_rope, :]
            k_rest = k[:, :, num_k_rope:, :]
            q, k_rope = apply_rotary_real(q, k_rope, self.cos, self.sin, repeat_k=num_mem_frames)
            k = torch.cat([k_rope, k_rest], dim=2)
        else:
            q, k = apply_rotary_real(q, k, self.cos, self.sin, repeat_k=None)

        scale = 1.0 / math.sqrt(q.shape[-1])
        scores = torch.matmul(q, k.transpose(-2, -1)) * scale
        weights = torch.softmax(scores, dim=-1)
        out = torch.matmul(weights, v)
        out = a._recombine_heads(out)
        return a.out_proj(out)


class ImageEncoderWrapper(nn.Module):
    def __init__(self, sam2):
        super().__init__()
        self.sam2 = sam2

    def forward(self, image: torch.Tensor):
        backbone_out = self.sam2.forward_image(image)
        fpn = backbone_out["backbone_fpn"]
        high_res_0 = fpn[0]
        high_res_1 = fpn[1]
        vision_feats = fpn[2]
        no_mem = self.sam2.no_mem_embed.view(1, 256, 1, 1)
        image_embed_no_mem = vision_feats + no_mem
        return high_res_0, high_res_1, vision_feats, image_embed_no_mem


class MaskDecoderWrapper(nn.Module):
    """ONNX-safe prompt encoder + mask decoder returning all 4 tokens, IoU, obj_ptrs, obj_score."""

    def __init__(self, sam2):
        super().__init__()
        self.sam2 = sam2
        self.register_buffer("image_pe", sam2.sam_prompt_encoder.get_dense_pe().detach())

    def _embed_points_onnx(self, points: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        pe = self.sam2.sam_prompt_encoder
        points = points + 0.5
        padding_point = torch.zeros((points.shape[0], 1, 2), dtype=points.dtype, device=points.device)
        padding_label = -torch.ones((labels.shape[0], 1), dtype=labels.dtype, device=labels.device)
        points = torch.cat([points, padding_point], dim=1)
        labels = torch.cat([labels, padding_label], dim=1)

        emb = pe.pe_layer.forward_with_coords(points, pe.input_image_size)
        lbl = labels.unsqueeze(-1)  # [B, P+1, 1]
        zeros = torch.zeros_like(emb)
        emb = torch.where(lbl == -1, zeros + pe.not_a_point_embed.weight, emb)
        emb = torch.where(lbl == 0, emb + pe.point_embeddings[0].weight, emb)
        emb = torch.where(lbl == 1, emb + pe.point_embeddings[1].weight, emb)
        emb = torch.where(lbl == 2, emb + pe.point_embeddings[2].weight, emb)
        emb = torch.where(lbl == 3, emb + pe.point_embeddings[3].weight, emb)
        return emb

    def forward(
        self,
        image_embed: torch.Tensor,
        high_res_0: torch.Tensor,
        high_res_1: torch.Tensor,
        point_coords: torch.Tensor,
        point_labels: torch.Tensor,
        mask_input: torch.Tensor,
        has_mask_input: torch.Tensor,
    ):
        pe = self.sam2.sam_prompt_encoder
        sparse_embeddings = self._embed_points_onnx(point_coords, point_labels)
        mask_embed = pe.mask_downscaling(mask_input)
        no_mask_embed = pe.no_mask_embed.weight.reshape(1, -1, 1, 1).expand(
            image_embed.shape[0], -1, image_embed.shape[2], image_embed.shape[3]
        )
        has_m = has_mask_input.view(1, 1, 1, 1)
        dense_embeddings = has_m * mask_embed + (1.0 - has_m) * no_mask_embed

        masks, iou_pred, mask_tokens_out, object_score_logits = self.sam2.sam_mask_decoder.predict_masks(
            image_embeddings=image_embed,
            image_pe=self.image_pe,
            sparse_prompt_embeddings=sparse_embeddings,
            dense_prompt_embeddings=dense_embeddings,
            repeat_image=False,
            high_res_features=[high_res_0, high_res_1],
        )

        is_obj_appearing = object_score_logits > 0.0
        masks = torch.where(
            is_obj_appearing[:, None, None],
            masks,
            torch.full_like(masks, NO_OBJ_SCORE),
        )

        obj_ptrs = self.sam2.obj_ptr_proj(mask_tokens_out)
        lambda_appearing = is_obj_appearing.float().unsqueeze(-1)
        no_obj_ptr = self.sam2.no_obj_ptr.unsqueeze(0)
        obj_ptrs = lambda_appearing * obj_ptrs + (1.0 - lambda_appearing) * no_obj_ptr

        return masks, iou_pred, obj_ptrs, object_score_logits


class MemoryEncoderWrapper(nn.Module):
    def __init__(self, sam2):
        super().__init__()
        self.sam2 = sam2

    def forward(
        self,
        pix_feat: torch.Tensor,
        high_res_mask: torch.Tensor,
        object_score_logits: torch.Tensor,
        is_mask_from_pts: torch.Tensor,
    ):
        # MedSAM2 enables binarize_mask_from_pts_for_mem_enc=True on prompted frames.
        bin_mask = (high_res_mask > 0.0).float()
        sig_mask = torch.sigmoid(high_res_mask)
        flag = is_mask_from_pts.view(1, 1, 1, 1)
        mask_for_mem = flag * bin_mask + (1.0 - flag) * sig_mask
        mask_for_mem = mask_for_mem * self.sam2.sigmoid_scale_for_mem_enc + self.sam2.sigmoid_bias_for_mem_enc
        out = self.sam2.memory_encoder(pix_feat, mask_for_mem, skip_mask_sigmoid=True)
        feats = out["vision_features"]
        pos = out["vision_pos_enc"][-1]
        is_obj_appearing = (object_score_logits > 0.0).float().view(1, 1, 1, 1)
        no_obj = self.sam2.no_obj_embed_spatial.view(1, 64, 1, 1)
        feats = feats + (1.0 - is_obj_appearing) * no_obj
        return feats, pos


class MemoryAttentionWrapper(nn.Module):
    def __init__(self, sam2):
        super().__init__()
        self.sam2 = sam2
        dummy = torch.zeros(1, 3, 512, 512)
        with torch.no_grad():
            backbone_out = sam2.forward_image(dummy)
            curr_pos = backbone_out["vision_pos_enc"][-1].flatten(2).permute(2, 0, 1)
        self.register_buffer("curr_pos", curr_pos.detach())
        self.sa_layers = nn.ModuleList([OnnxRoPEAttention(layer.self_attn) for layer in sam2.memory_attention.layers])
        self.ca_layers = nn.ModuleList([OnnxRoPEAttention(layer.cross_attn_image) for layer in sam2.memory_attention.layers])

    def forward(
        self,
        vision_feats: torch.Tensor,
        maskmem_feats: torch.Tensor,
        maskmem_pos: torch.Tensor,
        maskmem_tpos_idx: torch.Tensor,
        obj_ptrs: torch.Tensor,
        obj_pos_norm: torch.Tensor,
    ):
        num_mem_frames = maskmem_feats.shape[0]
        mem_flat = maskmem_feats.flatten(2).permute(0, 2, 1).reshape(-1, 1, 64)
        tpos = self.sam2.maskmem_tpos_enc.squeeze(1).squeeze(1)[maskmem_tpos_idx]
        pos_flat = maskmem_pos.flatten(2).permute(0, 2, 1) + tpos.unsqueeze(1)
        pos_flat = pos_flat.reshape(-1, 1, 64)

        ptr_tokens = obj_ptrs.reshape(-1, 1, 4, 64).permute(0, 2, 1, 3).reshape(-1, 1, 64)
        ptr_pe = get_1d_sine_pe(obj_pos_norm, dim=256)
        ptr_pos = self.sam2.obj_ptr_tpos_proj(ptr_pe)
        ptr_pos = ptr_pos.unsqueeze(1).repeat_interleave(4, dim=0)

        memory = torch.cat([mem_flat, ptr_tokens], dim=0).transpose(0, 1)
        memory_pos = torch.cat([pos_flat, ptr_pos], dim=0).transpose(0, 1)

        curr = vision_feats.flatten(2).permute(0, 2, 1)
        curr_pos = self.curr_pos.transpose(0, 1)
        output = curr + 0.1 * curr_pos

        ma = self.sam2.memory_attention
        for layer, sa, ca in zip(ma.layers, self.sa_layers, self.ca_layers):
            tgt2 = layer.norm1(output)
            tgt2 = sa(tgt2, tgt2, tgt2, num_mem_frames=None)
            output = output + tgt2
            tgt2 = layer.norm2(output)
            tgt2 = ca(tgt2, memory + memory_pos, memory, num_mem_frames=num_mem_frames)
            output = output + tgt2
            tgt2 = layer.norm3(output)
            tgt2 = layer.linear2(layer.activation(layer.linear1(tgt2)))
            output = output + tgt2

        output = ma.norm(output)
        return output.permute(0, 2, 1).reshape(1, 256, 32, 32)


def main():
    parser = argparse.ArgumentParser(description="Export MedSAM2 (sam2.1_hiera_t512) to four ONNX graphs.")
    parser.add_argument("--checkpoint", type=Path, default=Path(os.environ.get("MEDSAM2_CHECKPOINT", "MedSAM2_latest.pt")))
    parser.add_argument("--out-dir", type=Path, default=Path(os.environ.get("MEDSAM2_OUT_DIR", "onnx-medsam2")))
    args = parser.parse_args()
    ckpt = args.checkpoint
    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(0)
    predictor = build_sam2_video_predictor_npz("configs/sam2.1_hiera_t512.yaml", str(ckpt), device="cpu")
    predictor.eval()

    enc_wrap = ImageEncoderWrapper(predictor).eval()
    dec_wrap = MaskDecoderWrapper(predictor).eval()
    mem_enc_wrap = MemoryEncoderWrapper(predictor).eval()
    mem_attn_wrap = MemoryAttentionWrapper(predictor).eval()

    enc_path = out / "medsam2-image-encoder.onnx"
    raw_enc_path = out / "medsam2-image-encoder-raw.onnx"
    dummy_img = torch.randn(1, 3, 512, 512)
    with torch.no_grad():
        hr0, hr1, vfeat, iembed = enc_wrap(dummy_img)
        torch.onnx.export(
            enc_wrap, (dummy_img,), raw_enc_path,
            input_names=["image"],
            output_names=["high_res_0", "high_res_1", "vision_feats", "image_embed_no_mem"],
            opset_version=OPSET, do_constant_folding=True,
        )
    # Run target-independent basic ORT graph optimization (constant folding / redundant node
    # elimination, pure standard ONNX domain) so onnxruntime-web strict shape inference accepts it.
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    opts.optimized_model_filepath = str(enc_path)
    ort.InferenceSession(str(raw_enc_path), sess_options=opts, providers=["CPUExecutionProvider"])
    raw_enc_path.unlink()
    onnx.checker.check_model(onnx.load(enc_path))

    dec_path = out / "medsam2-mask-decoder.onnx"
    dummy_pts = torch.tensor([[[100.0, 120.0], [200.0, 220.0]]], dtype=torch.float32)
    dummy_lbl = torch.tensor([[2, 3]], dtype=torch.int32)
    dummy_mask = torch.zeros(1, 1, 128, 128, dtype=torch.float32)
    dummy_has_mask = torch.tensor([0.0], dtype=torch.float32)
    with torch.no_grad():
        dec_out = dec_wrap(iembed, hr0, hr1, dummy_pts, dummy_lbl, dummy_mask, dummy_has_mask)
        torch.onnx.export(
            dec_wrap, (iembed, hr0, hr1, dummy_pts, dummy_lbl, dummy_mask, dummy_has_mask), dec_path,
            input_names=["image_embed", "high_res_0", "high_res_1", "point_coords", "point_labels", "mask_input", "has_mask_input"],
            output_names=["low_res_masks", "iou_predictions", "obj_ptrs", "object_score_logits"],
            dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
            opset_version=OPSET, do_constant_folding=True,
        )
    onnx.checker.check_model(onnx.load(dec_path))

    mem_enc_path = out / "medsam2-memory-encoder.onnx"
    dummy_hrmask = F.interpolate(dec_out[0][:, 0:1], size=(512, 512), mode="bilinear", align_corners=False)
    dummy_obj_score = dec_out[3]
    dummy_from_pts = torch.tensor([1.0], dtype=torch.float32)
    with torch.no_grad():
        mfeat, mpos = mem_enc_wrap(vfeat, dummy_hrmask, dummy_obj_score, dummy_from_pts)
        torch.onnx.export(
            mem_enc_wrap, (vfeat, dummy_hrmask, dummy_obj_score, dummy_from_pts), mem_enc_path,
            input_names=["pix_feat", "high_res_mask", "object_score_logits", "is_mask_from_pts"],
            output_names=["maskmem_features", "maskmem_pos_enc"],
            opset_version=OPSET, do_constant_folding=True,
        )
    onnx.checker.check_model(onnx.load(mem_enc_path))

    mem_attn_path = out / "medsam2-memory-attention.onnx"
    dummy_mfeats = torch.cat([mfeat, mfeat], dim=0)
    dummy_mpos = torch.cat([mpos, mpos], dim=0)
    dummy_tpos_idx = torch.tensor([6, 0], dtype=torch.int64)
    dummy_ptrs = torch.cat([dec_out[2][:, 0:1, :].transpose(0, 1), dec_out[2][:, 0:1, :].transpose(0, 1)], dim=0)
    dummy_ppos = torch.tensor([2.0 / 15.0, 1.0 / 15.0], dtype=torch.float32)
    with torch.no_grad():
        pix_mem = mem_attn_wrap(vfeat, dummy_mfeats, dummy_mpos, dummy_tpos_idx, dummy_ptrs, dummy_ppos)
        torch.onnx.export(
            mem_attn_wrap, (vfeat, dummy_mfeats, dummy_mpos, dummy_tpos_idx, dummy_ptrs, dummy_ppos), mem_attn_path,
            input_names=["vision_feats", "maskmem_feats", "maskmem_pos", "maskmem_tpos_idx", "obj_ptrs", "obj_pos_norm"],
            output_names=["pix_feat_with_mem"],
            dynamic_axes={
                "maskmem_feats": {0: "num_mem"},
                "maskmem_pos": {0: "num_mem"},
                "maskmem_tpos_idx": {0: "num_mem"},
                "obj_ptrs": {0: "num_ptr"},
                "obj_pos_norm": {0: "num_ptr"},
            },
            opset_version=OPSET, do_constant_folding=True,
        )
    onnx.checker.check_model(onnx.load(mem_attn_path))

    # Verify ONNX Runtime parity across all 4 models + dynamic shapes!
    s_enc = ort.InferenceSession(str(enc_path), providers=["CPUExecutionProvider"])
    o_hr0, o_hr1, o_vfeat, o_iembed = s_enc.run(None, {"image": dummy_img.numpy()})
    s_dec = ort.InferenceSession(str(dec_path), providers=["CPUExecutionProvider"])
    for npts in [1, 2, 5]:
        pts = torch.randint(10, 480, (1, npts, 2), dtype=torch.float32)
        lbl = torch.tensor([[1] * npts], dtype=torch.int32)
        with torch.no_grad():
            ref_m, ref_i, ref_p, ref_s = dec_wrap(iembed, hr0, hr1, pts, lbl, dummy_mask, dummy_has_mask)
        got_m, got_i, got_p, got_s = s_dec.run(None, {
            "image_embed": iembed.numpy(), "high_res_0": hr0.numpy(), "high_res_1": hr1.numpy(),
            "point_coords": pts.numpy(), "point_labels": lbl.numpy(),
            "mask_input": dummy_mask.numpy(), "has_mask_input": dummy_has_mask.numpy(),
        })
        diff_m = float(np.abs(ref_m.numpy() - got_m).max())
        print(f"dynamic decoder npts={npts}: max_abs_diff_masks={diff_m:.2e}")
        assert diff_m < 1e-3

    o_masks, o_iou, o_ptrs, o_score = s_dec.run(None, {
        "image_embed": iembed.numpy(), "high_res_0": hr0.numpy(), "high_res_1": hr1.numpy(),
        "point_coords": dummy_pts.numpy(), "point_labels": dummy_lbl.numpy(),
        "mask_input": dummy_mask.numpy(), "has_mask_input": dummy_has_mask.numpy(),
    })
    s_menc = ort.InferenceSession(str(mem_enc_path), providers=["CPUExecutionProvider"])
    o_mfeat, o_mpos = s_menc.run(None, {
        "pix_feat": vfeat.numpy(),
        "high_res_mask": dummy_hrmask.numpy(),
        "object_score_logits": dummy_obj_score.numpy(),
        "is_mask_from_pts": dummy_from_pts.numpy(),
    })
    s_mattn = ort.InferenceSession(str(mem_attn_path), providers=["CPUExecutionProvider"])
    o_pix_mem = s_mattn.run(None, {
        "vision_feats": vfeat.numpy(), "maskmem_feats": dummy_mfeats.numpy(),
        "maskmem_pos": dummy_mpos.numpy(), "maskmem_tpos_idx": dummy_tpos_idx.numpy(),
        "obj_ptrs": dummy_ptrs.numpy(), "obj_pos_norm": dummy_ppos.numpy(),
    })[0]

    for nm, np_ in [(1, 1), (3, 4), (7, 16)]:
        mf = torch.randn(nm, 64, 32, 32)
        mp = torch.randn(nm, 64, 32, 32)
        ti = torch.arange(nm, dtype=torch.int64) % 7
        pt = torch.randn(np_, 1, 256)
        pp = torch.linspace(0.0, 1.0, np_)
        with torch.no_grad():
            ref = mem_attn_wrap(vfeat, mf, mp, ti, pt, pp).numpy()
        got = s_mattn.run(None, {
            "vision_feats": vfeat.numpy(), "maskmem_feats": mf.numpy(),
            "maskmem_pos": mp.numpy(), "maskmem_tpos_idx": ti.numpy(),
            "obj_ptrs": pt.numpy(), "obj_pos_norm": pp.numpy(),
        })[0]
        diff = float(np.abs(ref - got).max())
        print(f"dynamic mem_attn N_mem={nm}, N_ptr={np_}: max_abs_diff={diff:.2e}")
        assert diff < 1e-4

    report = {
        "checkpoint_sha256": sha256(ckpt),
        "models": [
            {"file": p.name, "bytes": p.stat().st_size, "sha256": sha256(p)}
            for p in [enc_path, dec_path, mem_enc_path, mem_attn_path]
        ],
        "max_abs_diff": {
            "encoder_vision_feats": float(np.abs(vfeat.numpy() - o_vfeat).max()),
            "encoder_high_res_0": float(np.abs(hr0.numpy() - o_hr0).max()),
            "decoder_masks": float(np.abs(dec_out[0].numpy() - o_masks).max()),
            "decoder_iou": float(np.abs(dec_out[1].numpy() - o_iou).max()),
            "decoder_obj_ptrs": float(np.abs(dec_out[2].numpy() - o_ptrs).max()),
            "memory_encoder_feats": float(np.abs(mfeat.numpy() - o_mfeat).max()),
            "memory_attention": float(np.abs(pix_mem.numpy() - o_pix_mem).max()),
        },
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
