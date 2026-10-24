# DWI workflow verification

The shipped [DWI preprocessing template](../../apps/pipeline-builder/src/workflows/dwi-preprocessing.workflow.json) runs denoising, Gibbs removal and DWI Correct, then extracts a brain mask from DWI Correct's corrected mean b0. NODDI and tractography receive the corrected series, its gradients and that mask. The acquisition JSON passes through both preprocessing steps into DWI Correct; the reverse b0 and its JSON enter DWI Correct directly.

The template requires at least two nonzero diffusion shells because its public ICVF output must be produced. Single-shell DTI workflows can use the individual operations instead.

The template's hosted copy is pinned to dataset commit `5fefd28435b9dde73b63629ee4de1381a962de8a`, SHA-256 `c47a4024d6fb542ae719cdda6de08474b34a683d00c269dfbbc79a66fc161c88`, 4986 bytes. The example selector verifies these bytes before import. Both offline inventories register the same artifact.

## Validation and runtime versions

[The template tests](../../apps/pipeline-builder/test/dwi-workflow.test.js) validate against generated tools from the current catalog and the unmodified NeuroFlow WASM core. Its [provenance](../../apps/pipeline-builder/vendor/neuroflow/provenance.json) pins upstream commit `cb7a94625543c727e869afaff5b22a7137be6c2b`. The template validates without errors or unresolved binding warnings. A second test substitutes an FA image for the tractography mask and requires a type error.

The [exported workflow CI](../../.github/workflows/neuroflow.yml) pins NeuroFlow v0.2.0, commit `fc6ec6075108306a588d48e2c1b66ffb924284a6`. That release has no gradient inspectors. Generated gradient inputs therefore retain their encoding constraints only in `neurodesk/data`; gradient outputs retain `bval` and `bvec` qualifiers. Pipeline Builder also checks the original contract formats when offering bindings. Restore input format qualifiers after adopting a release that resolves [the upstream inspector issue](https://github.com/cdrake/neuroflow/issues/26).

## Scientific inputs and checks

The existing DWI Correct example `ds006676-s3p1` supplies the scientific inputs. [Its manifest](../../apps/dwicorrect/examples.json) pins each file, checksum and byte count. The primary image, bval, bvec and sidecar fill the four primary workflow inputs. The PA image and its sidecar fill `reverse` and `reverseSidecar`. The example is a 112 × 112 × 72 series with 141 volumes, including 13 b0 volumes and two diffusion shells. It is a full public series, not a cropped fixture.

The [DWI Correct browser test](../../apps/dwicorrect/e2e/smoke.spec.js) sends these files through the split automation roles and checks correction, rotated gradients, acquisition metadata, motion/outlier reports and the corrected mean-b0 download. The mean includes corrected volumes whose b-value is at most 50 s/mm². `DwicorrectSettings.MeanB0Threshold` records that threshold. The browser test also checks that missing acquisition metadata fails before correction starts.

The denoising, Gibbs removal, N4 and SDC browser automation tests supply JSON through its own role under an unrelated filename and check the resulting workflow or downloaded sidecar. Unit tests exercise independent gradient names, converted DICOM sidecars, explicit acquisition overrides and SDC's image1 reference ordering.

Template validation and individual app browser tests do not prove execution of the complete exported chain. The exported workflow runner must complete on a hardware WebGPU adapter with subgroup support and retain its reports and output hashes before reporting that result. NODDI and tractography cannot be validated by a CPU-only browser run.
