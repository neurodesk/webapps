"""PyHySCO with its command-line defaults, on a chosen device.

Usage: run_pyhysco.py <ap_mean> <pa_mean> <pe-dim 1-3> <cpu|cuda:0> <out-dir>

The defaults are those of PyHySCO 0.0.4's pyhysco command: Gauss-Newton with
Jacobi-preconditioned CG, alpha 300, beta 1e-4, 50 iterations, single
precision, Jacobian correction. Its command picks CUDA whenever it exists, so
this script sets the device itself for the CPU timing.
"""

import sys

import torch

# PyHySCO's own command imports these names with *.
from EPI_MRI.EPIMRIDistortionCorrection import *
from optimization.GaussNewton import *

ap, pa, dim, device, out = sys.argv[1:]
torch.set_num_threads(8)
data = DataObject(ap, pa, int(dim), device=device, dtype=torch.float32)
loss = EPIMRIDistortionCorrection(
    data,
    alpha=300,
    beta=1e-4,
    averaging_operator=myAvg1D,
    derivative_operator=myDiff1D,
    regularizer=myLaplacian3D,
    rho=0.0,
    PC=JacobiCG,
)
b0 = loss.initialize(blur_result=True)
opt = GaussNewton(loss, max_iter=50, verbose=True, path=f"{out}/pyhysco")
opt.run_correction(b0)
opt.apply_correction(method="jac")
if device.startswith("cuda"):
    torch.cuda.synchronize()
