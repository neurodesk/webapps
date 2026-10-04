---
"syncro": patch
---

Correct the normalized lesion in the viewer before downloading it. When a run includes a lesion map, Results offers Edit lesion, which opens the shared mask editor on the normalized primary scan with the normalized lesion as the drawing. Apply replaces the lesion in the result archive with the edited uint8 NIfTI under the same name and labels the viewer `(edited)`; Cancel discards the strokes. A new run, new input or removed input closes an open edit. Automation results stay as the pipeline computed them.
