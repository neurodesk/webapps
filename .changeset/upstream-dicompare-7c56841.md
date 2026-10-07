---
"dicompare": patch
---

Merge upstream astewartau/dicompare-web f0462e2..7c56841 (upstream 0.11.1 to 0.15.3):

- Runs the dicompare Python package 0.11.1 (was 0.6.0) with the patched pydicom 2.4.5 it requires; the offline bundle ships both wheels.
- Validation rules use dicompare's `ctx` rule API and can declare parameters, which the rule table and editor show and edit.
- Field constraints have a severity (fail, or warn as reference only), notes, graded pass/warn/fail ranges set on a number-line editor, and custom messages; tables and printed reports show them.
- The field picker reads dicompare's canonical field registry, including derived fields, and offers enumerated values.
- Schema lint hints, a production-faithful rule test harness, and confirmation of custom schema uploads in the Schema Library.
- New library schemas (HC-ChiSep, Axon diameter mapping, Protocols for DWI analysis); the validation-function library was rebuilt and existing schemas revised (tolerances, reference-only SAR/dB/dt).
- The worker rejects requests after five minutes of silence and recovers from a crashed worker; dialogs share one accessible modal with focus trapping; tooltips render above sticky table headers.
