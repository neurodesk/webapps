---
"dwi2trx": patch
---

Report a lost GPU device during tracking as such instead of as out of memory, and record the physical GPU command size (`maxWorkgroupsPerDispatch`) in the tracking provenance. A hardware test now runs the example with one GPU command per pass and with the bounded 16-workgroup commands and requires the same TRX bytes.
