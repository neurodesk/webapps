# DWI workflow verification

The shipped [DWI preprocessing template](../../apps/pipeline-builder/src/workflows/dwi-preprocessing.workflow.json) runs denoising, Gibbs removal and DWI Correct, then extracts a brain mask from DWI Correct's corrected mean b0. NODDI and tractography receive the corrected series, its gradients and that mask. The acquisition JSON passes through both preprocessing steps into DWI Correct; the reverse b0 and its JSON enter DWI Correct directly.

The template requires at least two nonzero diffusion shells because its public ICVF output must be produced. Single-shell DTI workflows can use the individual operations instead.

The template's hosted copy is pinned to dataset commit `5fefd28435b9dde73b63629ee4de1381a962de8a`, SHA-256 `c47a4024d6fb542ae719cdda6de08474b34a683d00c269dfbbc79a66fc161c88`, 4986 bytes. The example selector verifies these bytes before import. Both offline inventories register the same artifact.

## Validation and runtime versions

[The template tests](../../apps/pipeline-builder/test/dwi-workflow.test.js) validate against generated tools from the current catalog and the unmodified NeuroFlow WASM core. Its [provenance](../../apps/pipeline-builder/vendor/neuroflow/provenance.json) pins upstream commit `fe6550c85d1e1f3548417d6bd0af69de37d2d256` (v0.7.0). The template validates without errors. Its `bval` and `bvec` workflow inputs declare no formats, so the core warns that the denoising step's gradient inputs need a runtime check; `neuroflow-mcp` 0.2.1 and later perform that check when the workflow runs. A second test substitutes an FA image for the tractography mask and requires a type error.

The [exported workflow CI](../../.github/workflows/neuroflow.yml) pins NeuroFlow v0.7.0, commit `fe6550c85d1e1f3548417d6bd0af69de37d2d256`. Since v0.2.1, NeuroFlow inspects FSL gradient tables ([upstream issue 26](https://github.com/cdrake/neuroflow/issues/26)), so generated gradient inputs and outputs both carry `bval` and `bvec` qualifiers, and a swapped pair fails before launch. The `bval-bvec` pair token has no inspector and stays only in `neurodesk/data`. Pipeline Builder also checks the original contract formats when offering bindings.

## Scientific inputs and checks

The existing DWI Correct example `ds006676-s3p1` supplies the scientific inputs. [Its manifest](../../apps/dwicorrect/examples.json) pins each file, checksum and byte count. The primary image, bval, bvec and sidecar fill the four primary workflow inputs. The PA image and its sidecar fill `reverse` and `reverseSidecar`. The example is a 112 × 112 × 72 series with 141 volumes, including 13 b0 volumes and two diffusion shells. It is a full public series, not a cropped fixture.

The [DWI Correct browser test](../../apps/dwicorrect/e2e/smoke.spec.js) sends these files through the split automation roles and checks correction, rotated gradients, acquisition metadata, motion/outlier reports and the corrected mean-b0 download. The mean includes corrected volumes whose b-value is at most 50 s/mm². `DwicorrectSettings.MeanB0Threshold` records that threshold. The browser test also checks that missing acquisition metadata fails before correction starts.

The denoising, Gibbs removal, N4 and SDC browser automation tests supply JSON through its own role under an unrelated filename and check the resulting workflow or downloaded sidecar. Unit tests exercise independent gradient names, converted DICOM sidecars, explicit acquisition overrides and SDC's image1 reference ordering.

Template validation and individual app browser tests do not prove execution of the complete exported chain. The exported workflow runner must complete on a hardware WebGPU adapter with subgroup support and retain its reports and output hashes before reporting that result. NODDI and tractography cannot be validated by a CPU-only browser run.

## Diagnose a models-stage failure

Dispatch `neuroflow` with `diagnostic_models: true` to run the same pinned DWI
inputs and settings through denoising, Gibbs removal, correction, masking and
model fitting, followed by the exact independent models comparison. This manual
mode omits tractography and the other independent comparisons. Its evidence sets
`diagnosticModels: true` and `fullWorkflowAcceptance: false`; it cannot satisfy
the complete exported-workflow gate. The default dispatch, push, pull-request and
nightly routes retain both complete templates and all DWI comparisons.

The equivalent local command, with the runtime and hardware environment above,
is `node scripts/desktop/neuroflow-smoke.mjs --dwi --diagnostic-models`.
Comparison logs retain changed run snapshots, the desktop's last 64 KiB of stderr,
its parent PID and joined exit status, and any forced termination signals.
NODDI reports input loading, fitting progress and output stages through automation.
A renderer exit rejects pending browser calls with its actual reason and exit
code. These diagnostics distinguish failures without increasing the timeout or
accepting incomplete or unequal scientific outputs. They do not establish the
cause of a previous timeout or prove that no orphaned child process remains.
