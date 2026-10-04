---
"seedseg": patch
---

Correct the consensus marker mask in the viewer before downloading it. The Consensus result has an Edit button that opens the shared mask editor with Draw, Erase and Fill tools, Undo, Apply and Cancel. Apply replaces the result, which is then labelled `Consensus (edited)`, and Download returns the edited mask as a uint8 NIfTI with the same name. The automation report keeps the masks the pipeline computed. SeedSeg now loads NiiVue 0.68.2, whose drawing API has the brush size the editor needs.
