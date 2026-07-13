#!/usr/bin/env python3
"""Run upstream SynthStroke torch model at 192^3 + TTA on the saved prealigned
MNI160 T1, to see if it removes the cerebellum FP while keeping the parietal
lesion. Compares against the saved full-head ONNX baseline (mni_A_fullhead)."""
import json, os, math
import numpy as np, nibabel as nib
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, ".tmp_weights", "cerebellum_fp")
THR, MINCC = 0.4, 30
TTA = [(), (0,), (1,), (2,), (0,1), (0,2), (1,2), (0,1,2)]

def zscore(d):
    d = d.astype(np.float32); s = d.std() or 1.0
    return (d - d.mean()) / s

def pad192(d):
    t = [max(192, math.ceil(s/192)*192) if s > 192 else 192 for s in d.shape]
    o = np.zeros(t, np.float32); o[:d.shape[0], :d.shape[1], :d.shape[2]] = d
    return o, d.shape

def positions(shape, p, ov):
    step = [max(1, round(x*(1-ov))) for x in p]
    cnt = [1 if shape[i] <= p[i] else max(1, math.ceil((shape[i]-p[i])/step[i])+1) for i in range(3)]
    out, seen = [], set()
    for iz in range(cnt[2]):
        z = min(iz*step[2], shape[2]-p[2]) if shape[2] > p[2] else 0
        for iy in range(cnt[1]):
            y = min(iy*step[1], shape[1]-p[1]) if shape[1] > p[1] else 0
            for ix in range(cnt[0]):
                x = min(ix*step[0], shape[0]-p[0]) if shape[0] > p[0] else 0
                if (x,y,z) not in seen: seen.add((x,y,z)); out.append((x,y,z))
    return out

def gauss(p, sigma=None):
    sigma = sigma or min(p)/8
    ax = [np.arange(d)-(d-1)/2 for d in p]
    xx,yy,zz = np.meshgrid(*ax, indexing="ij")
    return np.exp(-(xx*xx+yy*yy+zz*zz)/(2*sigma*sigma)).astype(np.float32)

def softmax_stroke(logits):
    m = logits.max(0, keepdims=True); e = np.exp(logits-m)
    return (e[1]/np.maximum(e.sum(0), 1e-12)).astype(np.float32)

def main():
    import torch
    from huggingface_hub import hf_hub_download
    from monai.networks.nets import UNet
    from safetensors.torch import load_file
    dev = torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")
    cfg = json.load(open(hf_hub_download("liamchalcroft/synthstroke-baseline", "config.json")))
    w = load_file(hf_hub_download("liamchalcroft/synthstroke-baseline", "model.safetensors"))
    model = UNet(spatial_dims=cfg["spatial_dims"], in_channels=cfg["in_channels"], out_channels=cfg["out_channels"],
                 channels=tuple(cfg["channels"]), strides=tuple(cfg["strides"]), kernel_size=cfg["kernel_size"],
                 up_kernel_size=cfg["up_kernel_size"], num_res_units=cfg["num_res_units"], act=cfg["act"],
                 norm=cfg["norm"], dropout=cfg["dropout"], bias=cfg["bias"], adn_ordering=cfg["adn_ordering"])
    model.load_state_dict(w, strict=False); model.to(dev).eval()

    t1 = np.asanyarray(nib.load(f"{D}/mni_t1pre.nii").dataobj).astype(np.float32)
    bm = np.asanyarray(nib.load(f"{D}/mni_brainmask.nii").dataobj) > 0
    A = np.asanyarray(nib.load(f"{D}/mni_A_fullhead.nii").dataobj) > 0
    P = (192,192,192)
    norm = zscore(t1); padded, orig = pad192(norm)
    W = gauss(P); pa = np.zeros(padded.shape, np.float32); wa = np.zeros(padded.shape, np.float32)
    for (x,y,z) in positions(padded.shape, P, 0.5):
        patch = padded[x:x+192, y:y+192, z:z+192]
        psum = np.zeros(P, np.float32)
        for ax in TTA:
            pin = np.flip(patch, ax).copy() if ax else patch
            with torch.no_grad():
                lo = model(torch.from_numpy(pin[None,None]).to(dev)).cpu().numpy()[0]
            pr = softmax_stroke(lo)
            psum += np.flip(pr, ax).copy() if ax else pr
        pr = psum/len(TTA)
        pa[x:x+192, y:y+192, z:z+192] += pr*W; wa[x:x+192, y:y+192, z:z+192] += W
    wa[wa==0]=1; prob = (pa/wa)[:orig[0], :orig[1], :orig[2]]
    binm = prob >= THR
    lab,n = ndimage.label(binm, structure=np.ones((3,3,3))); sz = np.bincount(lab.ravel())
    keep = sz >= MINCC; keep[0]=False; binm = keep[lab]

    # reference lesion = largest CC of A
    la,na = ndimage.label(A, structure=np.ones((3,3,3))); sa = np.bincount(la.ravel())
    big = sa[1:].argmax()+1; lesionRef = la==big; lesionRefN = int(lesionRef.sum())
    bz = np.argwhere(bm); zc=(bz[:,2].min()+bz[:,2].max())/2; yc=(bz[:,1].min()+bz[:,1].max())/2
    XYZ = np.argwhere(binm)
    cb = int(((XYZ[:,2]<zc)&(XYZ[:,1]<yc)&bm[XYZ[:,0],XYZ[:,1],XYZ[:,2]]).sum()) if len(XYZ) else 0
    kept = int((binm & lesionRef).sum())
    print(f"\ntorch192 ov0.5 TTA      total={int(binm.sum()):6d}  cerebellumFP={cb:5d}  lesion-recall={100*kept/lesionRefN:.0f}%")
    nib.save(nib.Nifti1Image(binm.astype(np.uint8), nib.load(f'{D}/mni_t1pre.nii').affine), f"{D}/mni_torch192_tta.nii")
    print(f"saved mni_torch192_tta.nii  (reference lesion={lesionRefN} vox)")

if __name__ == "__main__":
    main()
