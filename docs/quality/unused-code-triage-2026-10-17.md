# Unused-code triage, 2026-10-17

`pnpm quality:unused` with Knip 6.41.0 reports 29 candidates and an empty
`diagnostics.log`. The report remains advisory. The baseline was 91 at
`1444613e`, then 84 after PR #355 merged as `45ae49a1`.

The accepted schema-export and clipboard review fixes were scanned again with
`node scripts/report-unused-code.mjs`. The result remains 29 candidates with
zero diagnostic bytes and the same classifications. The browser exporter and
clipboard changes intentionally alter the final production bundle; the 88-file
byte comparison below applies only to the earlier deletion check.

This update follows the canonical dicompare sync from upstream `7c56841` to
`d3d0879`, including upstream's completed unused-code issue #25. The sync removes
the upstream dead exports, types and dependency declarations. Three deleted
upstream files had local modifications and required explicit review before
accepting their deletion:

- `src/components/common/ValidationConstraintSelector.tsx`.
- `src/services/PyodideManager.ts`.
- `src/utils/fieldProcessing.ts`.

Repository-wide searches found no caller, HTML script, worker URL, package
export, staging script or runtime inventory that loads them. Their remaining
mentions were declarations, historical documentation and one stale comment.
The production build contains the same 88 files, each byte-identical before
and after these three deletions. Unit, production-browser and interface checks
cover the integrated app. No Knip entry, exclusion or warning suppression was
added to reduce the report.

The changes remove 61 previous candidates and expose six further upstream-owned
candidates, for a net reduction of 55. Each remaining candidate is classified
below. Counts refer to individual Knip findings, including grouped symbols.

## Runtime and staging dependencies

| File or workspace | Candidates | Count | Evidence |
| --- | --- | ---: | --- |
| `apps/dicom2vid`, `apps/easy-mp2rage` | `@neurodesk/webapp-components` | 2 | `scripts/vendor-components.mjs` and `scripts/build-static.mjs` stage the shared browser components. |
| `apps/easy-mp2rage` | `@neurodesk/easy-mp2rage` | 1 | `tools/stage_core.sh` stages its committed WASM. |
| `apps/musclemap`, `apps/vesselboost` | Their matching shared pipeline packages | 2 | Their vendor scripts stage the browser pipelines. |
| `apps/seedseg` | `@neurodesk/seedseg` | 1 | The vendor step stages the shared pipeline, as required by `upstream.json`. |
| `apps/syncro` | `@neurodesk/syncro`, `@brainchop/mindgrab` | 2 | Relative pipeline imports and `scripts/copy-runtime-assets.mjs`. |
| `packages/nesvor` | `@neurodesk/synthsr`, `@neurodesk/webapp-components` | 2 | Relative imports of volume utilities and `fetchModel`; declarations also retain CI consumer edges. |
| `apps/synthsr`, `packages/synthstrip` | `onnxruntime-node` devDependencies | 2 | Their WASM/browser reference tests load it through `createRequire`. |
| `packages/syncro` | `@neurodesk/registration`, `@neurodesk/synthsr`, `@neurodesk/synthstrip` devDependencies | 3 | Relative runtime staging, manifest reading and Node pipeline imports. |
| `apps/spinalcordtoolbox/web/js/modules/sct-processing.js` | Default export | 1 | The UMD side-effect import sets `self.SCTProcessing`; its classic-script test exercises it. |

## Kept by owner or vendoring contract

| File | Candidates | Count | Evidence |
| --- | --- | ---: | --- |
| `packages/topofit/src/affine.js` | `prepareTemplates`, `mni305ToMni152` | 2 | The explicit owner decision in issue #256 on 2026-10-14 retains these scientific helpers. |
| `packages/nesvor/src/output/index.js` | `blurSupport`, `gaussianRandom` | 2 | The same owner decision retains these re-exports. |
| `packages/runtime-support/src/niimath/types.d.ts` | `dataTypes` | 1 | The directory's vendoring contract keeps declarations byte-identical to its frozen build. |

## Upstream-owned follow-up

| File | Candidates | Count | Reason to retain locally |
| --- | --- | ---: | --- |
| `apps/qsmbly/js/modules/file-io/index.js`, `js/modules/mask/index.js` | Two barrel files | 2 | Upstream issue `astewartau/qsmbly#157` remains open. Remove through an upstream fix and sync. |
| `apps/dicompare/src/types/fieldValues.ts` | File | 1 | Newly unreachable after upstream's widget/helper removals. Upstream still ships it at `d3d0879`; a follow-up belongs upstream. |
| `apps/dicompare/src/types/index.ts` | `AcquisitionComplianceResult`, `ProcessingProgress`, `Template` | 3 | Newly unused type exports in the synced upstream source. Retain until upstream resolves them. |
| `apps/dicompare/src/types/schema.ts` | `SchemaField` | 1 | Newly unused upstream type export. |
| `apps/dicompare/src/utils/fileUploadUtils.ts` | `FileSizeInfo` | 1 | Newly unused upstream type export. |

The totals are 16 runtime/staging findings, five retained by contract or owner
decision, and eight upstream findings. Zero candidates is not the goal.
The earlier [triage](unused-code-triage-2026-10-14.md) contains the original caller
evidence and the removals preceding this sync.
