#!/usr/bin/env python3
"""Compare greedy-rs outputs with greedy references: .mat, warps, resliced images."""
import sys, numpy as np, nibabel as nib
def mat(p): return np.loadtxt(p)
def img(p): return np.asarray(nib.load(p).dataobj, dtype=np.float64).squeeze()
def cmp_mat(a, b):
    d = mat(a) - mat(b)
    print(f"  max|dA| {np.abs(d[:3,:3]).max():.4g}  |db| {np.linalg.norm(d[:3,3]):.4g} mm")
def cmp_warp(a, b):
    A, B = img(a), img(b)
    n = np.linalg.norm(A - B, axis=-1)
    print(f"  warp rms {np.sqrt((n**2).mean()):.4g} mm  max {n.max():.4g} mm  identical voxels {(n==0).mean()*100:.1f}%  mean|v| {np.linalg.norm(A,axis=-1).mean():.4g}")
def cmp_img(a, b):
    A, B = img(a), img(b)
    ncc = np.corrcoef(A.ravel(), B.ravel())[0, 1]
    print(f"  ncc {ncc:.6f}  max abs {np.abs(A-B).max():.4g}  mean abs {np.abs(A-B).mean():.4g}  identical {(A==B).mean()*100:.1f}%")
kind, a, b = sys.argv[1:4]
print(f"{kind}: {a.split('/')[-1]} vs {b.split('/')[-1]}")
{"mat": cmp_mat, "warp": cmp_warp, "img": cmp_img}[kind](a, b)
