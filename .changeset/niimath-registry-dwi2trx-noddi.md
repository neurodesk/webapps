---
"@neurodesk/dwi2trx": patch
"dwi2trx": patch
"@neurodesk/noddi": patch
"noddi": patch
---

Replace the vendored `@niivue/niimath` (`1.2.0-dtifit.1`) build with the published `@niivue/niimath@1.4.20261114` release across DWI2TRX and NODDI. Upstream `1.4.20261114` includes the repeated-eigenvalue eigenvector fix (`rordenlab/niimath#83`), preservation of small positive eigenvalues below `1e-4` (`rordenlab/niimath#84`), and the `./package.json` export (`rordenlab/niimath#82`). Provenance in both apps and command lines now reports `1.4.20261114`, and the `dwi2trx` browser reference is rerecorded for the updated release.
