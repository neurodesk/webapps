---
"carotid-flow": minor
"@neurodesk/webapp-components": patch
---

New app: Carotid Flow finds both carotid arteries in a gated phase-contrast neck slice and plots their flow over the cardiac cycle, with peak, time average and pulsatility index, a CSV of the curves and a NIfTI of the carotid labels. Signed velocity gives flow in ml/min: arteries are told from veins by direction and pulse, and each carotid is the artery carrying most flow on its side; on the open example (PCMCalculator's test data) the right carotid is within 6 % of PCMCalculator's manual measurement. Unsigned speed images go through a port of the requesting lab's MATLAB script, which names left and right from the image orientation where the script called the patient's right carotid the left one. Shared file I/O gains `readNiftiFrames`, which reads every frame of a 4D NIfTI.
