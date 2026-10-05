# FireANTs

FireANTs registers a moving brain image to a stationary brain image entirely in
the browser. CPU execution and the Greedy transform preset are selected by
default; users can independently select WebGPU execution and the SyN preset.
The interface keeps the moving, stationary, and registered images visible in
separate NiiVue panels. dcm2niix converts DICOM inputs, while MindGrab can brain
extract custom images before registration. CPU registration and visualization
remain available without WebGPU; only the GPU option is disabled. Registered
images are downloaded as gzip-compressed NIfTI files.

The technical console reports FireANTs output, engine and end-to-end timing,
and a best-effort peak page-memory estimate. Browsers do not expose exact
process RSS or GPU VRAM to web applications. Where
`performance.measureUserAgentSpecificMemory()` is available, the app samples
its page-level estimate during registration and separately reports any
GPU-attributed breakdown supplied by the browser. Otherwise it explicitly
reports that the estimate is unavailable.

## Runtime assets and licensing

`@fireants/fireants` and MindGrab runtime files are copied from pinned npm
packages into ignored `public/cfireants` and `public/brainchop` directories by
the `dev` and `build` scripts. Generated WebAssembly is not committed. The
FireANTs package license and third-party notices are copied beside its runtime
and linked from the app's About dialog. The package is a modified cfireants
C/WebAssembly reimplementation and is not endorsed by the FireANTs authors.

## Command line

`fireants` from `packages/fireants` runs the same CPU registration with Node:

```bash
fireants moving.nii.gz fixed.nii.gz results --transform greedy
```

It writes `results/<moving>_registered.nii.gz`, the web app's download name.
It has no WebGPU backend, MindGrab brain extraction or DICOM import. Portable
archives for Linux x64, Windows x64 and macOS arm64 bundle their own Node
runtime. See packages/fireants/README.md.

## Example data

The app shares Greedy's brain-extracted registration examples from the
`neurodeskorg/webapps` Hugging Face dataset. The URLs pin dataset revision
`544f1362f367355e61a85e0694f5075aba2792b6`, so builds remain reproducible.

## Build and test

From the repository root:

```bash
pnpm --filter fireants dev
pnpm --filter fireants test
pnpm --filter fireants build
pnpm --filter fireants test:e2e
```

The app requires cross-origin isolation for multithreaded CPU execution. Its
Vite development, preview, and deployed builds use the repository's shared
isolation policy.

## Agent automation

The published `automation.json` describes the typed browser operation. Desktop
MCP uses the same processing function as the Run button and returns the exact
output files with input and artifact checksums. See
[desktop automation](../../packages/desktop/AUTOMATION.md) for connection details.

`register` requires `moving` and `fixed` image roles. `backend` is `cpu` or
`webgpu`; `transform` is `greedy` or `syn`. Defaults match the UI: CPU and Greedy.
The registered NIfTI report records the execution variant, thread count and
engine timing. The three image viewers expose crosshairs and layout tabs.
Both image roles accept NIfTI or DICOM. Ambiguous DICOM conversion requires an
explicit series selection; the operation never guesses roles from filenames.
