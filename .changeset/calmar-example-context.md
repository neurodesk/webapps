---
"calmar": minor
---

Fill the behavioural form from every example with what its dataset publishes for that case, linking the pinned source file.

- Replace the SOOP acute example `sub-1`, which has no row in the dataset's participants table, with `sub-2`: age 78 (at the scan), male, NIHSS 17, with the admission diagnosis and aetiology in the notes.
- Fill the ISLES 2022 acute example from the case's DWI and ADC sidecars: age 88 (at imaging), female.
- Add a second chronic example from the Aphasia Recovery Cohort, `sub-M2001` ses-1076: age 38 at stroke, female, WAB-R Aphasia Quotient 87.1 at day 895. The two chronic entries are now labelled by participant.
- Remove the alternating "Acute DWI + ADC — next case" entry. Each menu entry now names the scan it loads, so the participant and the behavioural context on screen are never ambiguous.

Neither acute dataset publishes time since onset for individual cases, so that field stays blank for both. The new scans are checksum-pinned on the mirror with their sidecars, notices and provenance records, and the Aphasia Recovery Cohort is cited.
