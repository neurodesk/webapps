---
"dwi2trx": patch
---

Remove streamlines longer than a maximum length, 250 mm by default. Without a limit, bootstrap tracking with a 60° turn limit kept streamlines that loop back on themselves: on a full-size Philips series 1,059 were longer than 400 mm and the longest was 689 mm, in a head about 250 mm across (#598). The new "Max length" setting (automation parameter `maxLength`, 20 to 1000 mm) measures each streamline in mm through the image affine. The status bar says how many were removed, and the report records the limit (`provenance.tracking.maxLengthMm`) and the count (`measurements.removedTooLong`).
