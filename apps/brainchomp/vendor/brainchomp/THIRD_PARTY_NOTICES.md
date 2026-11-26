# Third-party notices

## MeshNet inference engine

The C inference engine under `src/` (the CPU convolution, the accelerator
weight packing, the CUDA, OpenCL, Metal, WebGPU and WebGL2 backends and their
kernel generators, the thread pool and the payload embedding) is adapted from
an MIT-licensed MeshNet engine:

    MIT License

    Copyright (c) 2024-2026 spikedoanz, Sergey Plis

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## NIfTI I/O

`src/nifti_io.c` and `src/nifti_io.h` are the public-domain NIfTI I/O
consolidation based on work by Robert W. Cox, Mark Jenkinson, Rick Reynolds,
and Chris Rorden.

## Niivue

`src/conform.c` reproduces, so that the browser app and this library hand the
network the same volume, Niivue's robust intensity range (`getScale`) and
uint8 rescale (`scalecropUint8`). Niivue is BSD-2-Clause,
<https://github.com/niivue/niivue>; its `getScale` in turn follows FastSurfer's
`conform.py` (Apache-2.0). No code was copied; the algorithm is reimplemented.

## WGSL convolution structure (TensorFlow.js)

`src/webgpu_kernels.h` contains WGSL compute kernels written for this project.
The convolution follows the structure of TensorFlow.js's WebGPU Conv3D
(`tfjs-backend-webgpu/src/conv3d_naive_webgpu.ts`): its workgroup size of 64,
its bounds-checked handling of padding and dilation, and its accumulation of
the input-channel reduction as `vec4` dot products. No TypeScript was copied.

    Copyright 2023 Google LLC.
    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

## Test images

`test/rat.nii.gz` and `test/mouse.nii.gz` are the two example volumes the
Brainchomp browser app ships (a rat MRI, `MA_F_15M_20_image`, and a CAMRI
mouse T2-weighted MRI, `camriMouse_sub-012_ses-1_t2w_image`), min/max-quantized
256^3 uint8 at 0.1 mm. `test/rat_0.2mm.nii.gz` is derived from the rat by
`test/make_offgrid.py`.
