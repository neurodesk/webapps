---
"calmar": patch
---

Load every model, atlas, template and connectome from a fixed revision instead of `main`: `sbollmann/lnm-webapp-models` at commit `6fd71cdb`, the Schaefer400 2 mm atlas from CBIG commit `d1454a61` instead of a movable tag, and the Schaefer400 connectome index from `neurodeskorg/webapps` commit `4cc5b1a5`, a copy whose shard URLs are pinned to the same `lnm-webapp-models` commit. The bytes of every model, atlas and shard are unchanged.
