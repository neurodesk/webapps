# RFC draft: Encoding, spatial reference, and label-system constraints

Status: Superseded by the consolidated upstream RFC,
[neuroflow-spec RFC 0010, type qualifiers](https://github.com/cdrake/neuroflow-spec/blob/40ed9ce02184183237613318db48286b9f4c504f/rfcs/0010-type-qualifiers.md)
([cdrake/neuroflow-spec#1](https://github.com/cdrake/neuroflow-spec/pull/1)),
which folds this draft into one document. What the consolidated RFC takes from
here: the three binding outcomes, the resolve-or-fail executor, the
conformance cases, a required version bump for qualified documents, and the
revision on `space` and `labelSystem`. What it writes differently: the
qualifiers are strings (the serialization of this draft's pairs), the
revision is optional on the producer and a consumer that declares one has
the artifact verified at runtime, `resolution` and `density` are kept, and
the version bump is the `0.1.1` envelope value in the 0.1 schemas rather
than a 0.2 schema path. The generator in this repository
implements the accepted RFC. This file
records the original proposal and is not maintained.

Date: 2026-09-30 (superseded the same day)

Implementation evidence: Neurodesk Webapps schema-2 automation contracts and
the [contract generator](../../packages/desktop/neuroflow/README.md).

## Summary

A semantic type answers what data represents. It does not identify its file
encoding, spatial reference, or label vocabulary. A `neuro:volume` can be an
MGZ or a NIfTI, and two NIfTI volumes can belong to different subjects. Two
`neuro:label-map` values can use different integers for the hippocampus.

Add optional `formats`, `space`, and `labelSystem` constraints to type
declarations. Keep these constraints independent from `type`. Apply them to
tool inputs, tool outputs, workflow inputs, context fields, and typed workflow
outputs wherever the current specification uses a type declaration.

This proposal defines compatibility outcomes, not image conversion or image
registration. A validator must not silently insert either operation.

## Existing contract and compatibility boundary

The proposal is based on
[NeuroFlow 0.1 at d8a8737](https://github.com/cdrake/neuroflow-spec/blob/d8a87377660495f8f17f8c4f76a00295d8d91f1a/spec/neuroflow-0.1.md)
and its
[shared type declaration](https://github.com/cdrake/neuroflow-spec/blob/d8a87377660495f8f17f8c4f76a00295d8d91f1a/schemas/0.1/common.schema.json)
and [tool output definition](https://github.com/cdrake/neuroflow-spec/blob/d8a87377660495f8f17f8c4f76a00295d8d91f1a/schemas/0.1/tool.schema.json).
Both definitions currently reject additional properties. The `core:`,
`neuro:`, `bids:`, and `prov:` type vocabularies are closed.

Adding these properties changes which documents are valid and introduces
validation obligations. Publish them in a new specification version, proposed
as 0.2, with a matching `neuroflow` envelope and schema IDs. Do not emit the
new fields at the top level of a 0.1 declaration or change a published schema
in place. Existing unconstrained declarations retain their 0.1 meaning.

Until adoption, the Neurodesk generator emits valid 0.1 documents and preserves
source declarations in `extensions["neurodesk/data"]`. Unknown extensions
remain ignorable under the existing core rules. A core-only validator cannot
claim it has enforced their format, space, or label constraints. The generator
does not pretend that metadata preservation is semantic validation.

## Proposed declaration fields

```json
{
  "type": "neuro:label-map",
  "description": "Segmentation on the input image's spatial reference",
  "formats": ["nifti"],
  "space": { "kind": "relative", "input": "image" },
  "labelSystem": { "id": "example.org/labels/brain", "version": "2.0.0" }
}
```

The example is a proposed 0.2 declaration. It is intentionally not valid
against the current 0.1 schema.

### Formats

`formats` is a nonempty array of distinct encoding identifiers. An input
accepts any listed encoding. An output promises that its encoding belongs to
the listed set. For array types, the constraint applies to each element.
An absent field makes no encoding claim.

Use a registry of identifiers with written definitions. Seed it from actual
implementations, including `nifti`, `mgh`, `mgz`, `dicom`, `gii`, `mz3`, `obj`,
`ply`, `stl`, `json`, `csv`, `tsv`, `bval`, `bvec`, `onnx`, and `ome-zarr`.
Allow namespaced extension identifiers so an implementation need not wait for
a core release to describe another encoding.

Identifiers describe bytes or a directory layout, not filename suffixes.
For example, `nifti` denotes the NIfTI family, allowing gzip transport, whereas
`mgz` denotes gzip-compressed MGH. A future consumer that requires NIfTI-1 or
uncompressed bytes needs a narrower registered identifier or a separate
transport constraint. Such a restriction must not be inferred from `.nii`.

The format registry must define recognized refinements. The initial validator
uses exact identifiers except for explicit registry relationships. It must not
infer that arbitrary similarly named formats are compatible. `surface` is a
semantic category, not an encoding; a Neurodesk source annotation using it
must be expanded to an explicit list by its owner before migration.

### Space

`space` describes the coordinate reference, independently of orientation,
voxel dimensions, shape, and sampling grid. It is one of:

```json
{ "kind": "named", "id": "example.org/templates/reference", "version": "1.0.0" }
```

```json
{ "kind": "relative", "input": "image" }
```

The named form requires an immutable, versioned reference identifier. A
template identifier must distinguish variants whose coordinate frames differ.
An unqualified `MNI152` string is insufficient to identify a particular
template. Do not equate voxel sizes with template identity.

The relative form refers to a declared input in the current tool or workflow.
It means the same spatial reference as the bound input, not the same grid.
The validator must resolve the input reference and check that it is spatial.
An optional or absent referenced input makes the constraint unresolved.
For a collection, all referenced elements must have one established frame;
otherwise per-item correspondence needs a future extension.

At execution time, reference identity must include the subject or specimen
when the reference is subject-specific. Two tools using the local name
`image` do not thereby refer to the same subject. A validator must follow the
workflow bindings and their provenance.

The existing Neurodesk strings `native`, `input`, `fixed`, `moving`,
`subject-1mm`, and `atlas` are not globally unique space identifiers.
`RAS-mm` describes axes and units, not subject identity. The generator keeps
these strings as source metadata; it must not invent a named template or an
input relationship. App owners must make those relationships explicit before
the annotations can be promoted to portable constraints.

Same-space images can have different grids. A tool that needs voxelwise
correspondence must separately verify its required geometry. This RFC does
not add a general grid-constraint language and does not make a shared frame
sufficient proof for voxelwise operations.

### Label system

`labelSystem` is an object with required nonempty `id` and `version` strings.
The pair identifies an immutable mapping from encoded label values to their
meanings. Arrays apply the constraint to every element. Omission means no
label-system claim.

```json
{ "id": "example.org/labels/brain", "version": "2.0.0" }
```

Publish the mapping or a checksummed registry entry. A mutable URL by itself
is insufficient. A tool version, model version, or output filename is not
automatically a label-system version. An annotation such as `FreeSurfer` does
not establish a particular mapping revision or label subset.

The first implementation requires exact identity of the label-system pair.
Subset relationships and semantic equivalence require separately registered
evidence; they must not be guessed from common label names. A shared label
system implies neither a shared spatial reference nor matching voxel grids.

## Compatibility algorithm

First apply existing semantic-type compatibility. These fields cannot make
incompatible semantic types compatible. Then assess each constrained axis:

1. An unconstrained consumer imposes no additional requirement on that axis.
2. For formats, a producer's known possible set must be a subset of the
   consumer's accepted set for unconditional compatibility. Disjoint known
   sets are incompatible. Overlapping sets without containment require a
   runtime check of the actual encoding.
3. Named spaces are compatible only for the same immutable identity and
   version. Relative spaces are compatible when binding resolution proves
   the same reference identity. Known different identities are incompatible.
4. Label systems require equal identifiers and versions. Known unequal pairs
   are incompatible.
5. Missing producer metadata or unresolved references require a runtime
   check whenever the consumer constrains that axis. Unknown is not a pass.

The combined outcome is `incompatible` if any axis is incompatible,
`requires-runtime-check` if any remaining axis is unresolved, and `compatible`
otherwise. Diagnostics should identify the edge, field, expected value,
observed or declared value, and a repair such as an explicit conversion or
registration step. Do not claim a repair is scientifically suitable solely
because its output satisfies a file-format constraint.

A strict executor must resolve all required checks before launching the
consumer. If it cannot establish a required fact, it must fail with an
unresolved-constraint diagnostic. An editor may display that workflow, but
must distinguish a conditionally valid plan from a runnable one. Inspection
should use headers, format readers, and trusted provenance. A matching affine
alone does not establish subject identity or anatomical alignment.

## Conformance cases

| Producer evidence | Consumer requirement | Outcome |
| --- | --- | --- |
| `neuro:volume`, formats `["mgz"]` | `neuro:volume`, formats `["nifti"]` | Incompatible encoding |
| Formats `["nifti"]` | Formats `["nifti", "mgz"]` | Compatible encoding |
| Formats `["nifti", "mgz"]` | Formats `["nifti"]` | Requires runtime encoding check |
| Encoding unknown | Formats `["nifti"]` | Requires runtime encoding check |
| Any encoding | No encoding constraint | No additional encoding restriction |
| Relative frame resolved to subject A | Relative frame resolved to subject B | Incompatible space |
| Two unresolved `native` source annotations | Same-subject consumer | Requires runtime identity check |
| Same named template and version, different grid | Same spatial reference | Space compatible; grid requirements still need checking |
| Same template ID, different version | Exact template version | Incompatible space |
| Label vocabulary v1 | Label vocabulary v2 | Incompatible labels |
| `FreeSurfer` without an immutable mapping revision | Exact label-system pair | Requires runtime label check |
| `neuro:surface`, formats `["nifti"]` | `neuro:volume`, formats `["nifti"]` | Semantic type remains incompatible |

Schema tests must also reject empty/duplicate format lists, unknown object
properties, missing label-system versions, malformed space variants, and
relative references to nonexistent or nonspatial inputs. The last two checks
are semantic validation, not merely JSON Schema validation.

## Migration and implementation work

1. Agree on identifiers, comparison rules, and the next specification version.
2. Extend both the shared `typeDeclaration` and the separate `toolOutputDef`.
   Audit workflow/context schemas that inline declarations so inputs and
   outputs receive the same rules. Update the normative type section.
3. Add schema fixtures and semantic-validator cases from the table above.
4. Add a three-outcome comparison API in NeuroFlow's Rust core and its frontend
   binding. Propagate unresolved constraints into planning diagnostics.
5. Extend artifact descriptors and durable provenance with the observed format,
   reference identity, label-system identity, and evidence used to verify them.
6. Update the runtime to check actual artifacts before launching a constrained
   consumer. Declare inspector capabilities; do not downgrade a missing
   inspector to successful validation.
7. Migrate reviewed Neurodesk annotations to the new fields. Keep unresolved
   source annotations in their extension. Remove duplicated extension values
   when the portable declarations become authoritative.

No existing 0.1 document needs to be rewritten merely to remain usable.
Generating a constrained 0.2 document must be an explicit target-version
choice. Old runtimes must reject the unsupported version rather than silently
ignoring new execution requirements.

## Alternatives and scope

Encoding every combination in the semantic type would multiply names such as
volume/NIfTI/native and volume/MGZ/MNI. It would also obscure whether a tool
converts an encoding, registers an image, or changes a label vocabulary.
Independent constraints keep those transformations visible.

Keeping all constraints permanently in vendor extensions avoids a core change
but prevents portable validation across implementations. The extension is a
migration mechanism, not the final interoperability contract.

Cardinality, unions, numeric `multipleOf`, per-item subject correspondence,
general geometry predicates, GPU resource budgets, and adding new closed
semantic types remain separate proposals. The Neurodesk adapter retains
these declarations and uses desktop validation where available. A larger
WebGPU allocation does not prove scientific correctness; this RFC does not
change the existing SynthSeg 2 GiB cap.

Open decisions for upstream review: ownership of the format/reference
registries, whether immutable versions are strings or digests, how declared
evidence is authenticated across remote runtimes, and the first inspector
capabilities required for strict execution.
