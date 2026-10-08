# Schema authoring best practices

Guidance for authoring validation schemas for the [dicompare schema library](https://dicompare.neurodesk.org). Schemas are typically built in the dicompare web interface and submitted via GitHub issue; this document describes what makes a schema accurate, portable, and maintainable. Reviewers use it as a checklist when approving submissions.

## 1. Decide what kind of schema you are writing

Most schemas are one of two kinds, and the right constraint style differs between them:

- **Reference protocol** — describes one specific, known acquisition setup (a study protocol, a scanner-specific sequence). Exact values are appropriate, including hardware fields like `Manufacturer`, `ManufacturerModelName`, and `ProtocolName` — but recording a hardware value is not the same as requiring it of the user, so set severity deliberately (§3). Examples: *UK Biobank*, *HCP Young Adult*, *Axon diameter mapping*.
- **Guideline / compatibility schema** — checks whether arbitrary data meets the requirements of an analysis method or published guideline. Use ranges, tolerances, and rules; avoid constraining hardware- or site-specific fields at all. Examples: *ASL Clinical Guidelines*, *QSM Consensus Guidelines*, *Protocols for DWI analysis*.

Don't mix altitudes within one schema: if four acquisitions express generic requirements and a fifth pins exact values from one scanner, users can't tell which failures matter. If both views are valuable, publish two schemas and cross-reference them in the descriptions rather than duplicating acquisitions between files.

## 2. Choose the right constraint for each field

Supported constraints: exact `value`, `min`/`max` range, `value` + `tolerance`, `contains`, `contains_any`, `contains_all`.

- **Continuous numeric fields** (`RepetitionTime`, `EchoTime`, `SliceThickness`, `PixelSpacing`, `FlipAngle`, …): use a range or a tolerance unless you are pinning a reference protocol. Real scans vary slightly; exact matches are brittle. The editor's lint flags this (`exact-float`).
- **Enumerated fields** (`MRAcquisitionType`, `InPlanePhaseEncodingDirection`, `PatientPosition`, …): use the DICOM-defined values. `InPlanePhaseEncodingDirection` is `ROW` or `COL` — console display strings like `A >> P` never match stored DICOM and the lint flags them (`display-string`, `enum-mismatch`).
- **Composite/text fields** (`ImageType`, `ScanningSequence`, `SeriesDescription`): prefer `contains` / `contains_any` over exact matches. Be wary of constraining `SeriesDescription` at all in guideline schemas — naming is site-specific (`DIFF`, `dwi`, `ep2d_diff` all exist in the wild); if you must, use `contains_any` with the common variants.
- **Asserting absence**: an empty-string `value` (e.g. `ContrastBolusAgent: ""`) asserts the field is empty, e.g. pre-contrast.
- **Hardware/site fields** (`Manufacturer`, `SoftwareVersions`, `InstitutionName`, `ProtocolName`): constrain only in reference protocols, and only when the schema is genuinely scanner-locked. Exact `SoftwareVersions` breaks on every upgrade — include it only when the version materially matters. If the description says the schema applies to multiple platforms, the fields must not hard-require one of them. Whether such a field should fail a user at all is a severity question (§3).

## 3. Required vs. reference-only

Every field constraint is either a **requirement** (the default) or **reference-only** (`severity: warning`). A reference-only constraint records what the reference protocol used; data that differs is still reported compliant. Decide with one test:

**Can you name a consequence of a different value?**

- Yes — "b-values below 1500 can't resolve the kurtosis fit", "susceptibility scales with field strength, so these thresholds are 3T-specific" → **requirement**. Put that consequence in the field's `notes` (§4).
- No — the honest answer is "it would just be different" → **reference-only**.

Being a hardware or site field does not decide this. What the value *does* decides it:

- `ManufacturerModelName: contains_any [Connectom, Magnus]` in *Axon diameter mapping* is a **requirement**. It is a gradient-strength precondition wearing a model name — the method needs >250 mT/m and no other platform delivers it. A different value doesn't make the data merely different, it makes the method impossible.
- `ManufacturerModelName: Skyra` in a study-replication schema is **reference-only**. A Prisma running the same protocol yields equivalent data; the model is recorded for replication, not required of the user.
- `ImagingFrequency: 123.26 ± 1` is **reference-only** in any schema. It is a function of the individual magnet's field and shim — two scanners of the same model at different sites won't match, and nothing in the protocol depends on it.

Where the protocol's values were *tuned to* a particular instrument, the instrument field is a genuine requirement: the tuned values are only meaningful on hardware that can deliver them.

**Check the prose against the constraints.** Read the `detailed_description` and list every requirement it states — "needs 300 mT/m gradients", "a minimum of 30 directions is recommended", "reverse phase-encoded". Each one should map to a requirement or a rule. A claim made in prose and left unenforced is the most common way a schema ends up validating less than it appears to, and it is invisible from the field table alone. Where the prose, a field constraint, and a rule all state the same threshold, they must agree on the number.

**Reference-only is not the same as omitting the field.** Omit a field when its value is noise. Mark it reference-only when someone replicating the protocol would want to know what the reference used. Never mark something reference-only to silence a failure you haven't diagnosed — that hides a problem instead of recording a decision.

This interacts with the schema kind from §1:

- **Guideline schemas** should carry few reference-only fields. If a value doesn't matter for the guideline, it usually shouldn't be in the schema at all.
- **Reference-protocol schemas** are where severity earns its keep. It lets you record a complete protocol for replication while failing only on what actually matters — without it you must either drop useful detail or fail every user who isn't on that exact scanner.

Severity on a series field applies to the **whole column**, not one cell: the series table shows one dot per field for all series, so it cannot express per-series severity.

## 4. Notes — record the rationale, not the constraint

Any field or series constraint can carry a free-text `notes` string, shown on hover in the app and printed inline in reports. It is documentation only and never affects validation.

Write a note when the reasoning isn't recoverable from the value: a threshold that came from a specific paper, a value chosen to trade off against another, or a constraint that looks arbitrary but isn't. The §3 test doubles as the prompt — if you justified a requirement by naming the consequence of deviating, that sentence is the note.

Notes are most valuable on **reference-only** fields, where they answer the obvious question of why the schema bothers to mention a value it won't enforce.

Don't restate the constraint. "Must be 3" adds nothing next to `MagneticFieldStrength: 3`; "3T required for adequate SNR at this resolution" does.

Notes belong on acquisition fields and on the series as a whole. Series *fields* have none — a note per cell across a wide series table gives one rationale per value with nowhere to read it.

## 5. Field constraints vs. rules — don't encode the same requirement twice

Field constraints are checked verbatim against every matching acquisition. If a requirement is conditional or cross-field ("the b>1500 shell needs ≥28 directions"), express it as a **rule**.

When a rule owns a check, mark the underlying fields (`DiffusionBValues`, `DirectionsPerShell`, …) **reference-only** rather than pinning them to one example protocol as requirements. The example values stay visible for replication, but the rule alone decides compliance. Pinning them as well is how conforming data ends up passing your rules and failing your fields.

Watch for a field constraint that contradicts its own rule. If `MaxDiffGradient` is required to equal exactly `280` while the rule enforces `>= 250`, a 300 mT/m system passes the rule and fails the field — one of the two is wrong, and it is usually the exact value.

For rules:

- Declare **every** field the implementation reads in the rule's `fields` list — an undeclared field is a runtime error, not a validation failure.
- Attach the rule to the acquisition that actually contains the data it checks. A rule requiring a low-b shell must not live on an acquisition whose b-values are all high.
- Distinguish severity: recommendation-level findings should be tagged `[warning]`; untagged messages read as hard failures.
- Boundary conditions: check comparisons at the recommended value itself (`< 5` vs `<= 5` — "at least 5" must pass at 5).

## 6. Test your schema against its own example

Every rule should have at least **one passing and one failing test case**, with meaningful names and descriptions. The single most valuable passing case is the schema's own recommended protocol: if the values you list in `fields` don't pass your own rules, one of the two is wrong. (This has caught real submissions.)

## 7. Identifiers and structure

- Rule ids must be **unique within their acquisition** (a collision silently drops one of the rules), and test-case ids unique within their rule. Reusing ids across different acquisitions is harmless — rules are scoped per acquisition and there is no shared-rule mechanism.
- Every acquisition should have a short `description` (one line, shown in lists) and a `detailed_description` (markdown: purpose, key requirements, references). Don't leave placeholders like "Protocol from ProtocolFile.txt" or empty detailed descriptions.
- Add `tags` to every acquisition (e.g. `analysis:diffusion`, `brain`, method name) — they drive filtering in the library.
- `"tag": "derived"` marks non-DICOM fields computed by dicompare (e.g. `NumberOfDiffusionShells`, `PostLabelDelay`); use real DICOM tags for everything else.

## 8. Metadata and prose

- `name`, `version`, and `authors` are required. Bump `version` on any change to constraints or rules; prose-only fixes can share a version but note the change in the submission.
- The top-level `description` should state the schema's **intended use** (reference protocol vs. compatibility check), hardware assumptions, links to analysis code, and citations — the existing library schemas (ASL, HCP, MS CMSC) are good models.
- Proofread. Descriptions render verbatim in the app and in print reports.

## 9. Submission checklist

Before submitting (and for reviewers before approving):

- [ ] Schema kind is clear, and constraint altitude is consistent with it (§1)
- [ ] No exact matches on continuous fields in guideline schemas; no console display strings (§2)
- [ ] Editor lint warnings resolved or consciously accepted
- [ ] Every requirement can name a consequence of deviating; anything that can't is reference-only or dropped (§3)
- [ ] No acquisition is left with nothing enforced — a schema that requires only a scanner model validates nothing (§3)
- [ ] Every requirement stated in the prose is encoded, and prose/field/rule agree on shared thresholds (§3)
- [ ] Non-obvious values carry a note explaining the reasoning, not restating the value (§4)
- [ ] Rule-owned fields are reference-only, and no field constraint contradicts its own rule (§5)
- [ ] Rules declare all fields they read; message severity tagged; attached to the right acquisition (§5)
- [ ] Each rule has ≥1 passing and ≥1 failing test case; the schema's own example values pass its own rules (§6)
- [ ] Rule/test ids unique; no placeholder or empty descriptions; tags present (§7)
- [ ] Metadata complete; prose proofread; hardware claims in the description match the field constraints (§8)
