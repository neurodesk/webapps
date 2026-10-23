# Licensing and provenance

This monorepo contains independently developed applications and packages. There is
no blanket repository-wide licence. The canonical source commit and declared licence
for each app are recorded in `registry/apps.yml`.

- `packages/calmar`: source licence unresolved, preserving CALMAR `NOASSERTION` as
  npm `UNLICENSED` (`packages/calmar/LICENSE`, `packages/calmar/NOTICE`).
- `packages/components`: MIT (`packages/components/LICENSE`)
- `packages/node-drivers`: MIT (`packages/node-drivers/LICENSE`); Node drivers and the `brainchop-mindgrab` command line
- `apps/musclemap`: MIT (`apps/musclemap/web/LICENSE`)
- `apps/qsmbly`: MIT (`apps/qsmbly/LICENSE`)
- `packages/qsmbly`: GPL-3.0-only (`packages/qsmbly/LICENSE`, `packages/qsmbly/NOTICE`); its
  release archives redistribute the unmodified GPL-3.0-only QSMxT 9.22.0 binaries and dcm2niix
- `apps/synthsr`: Apache-2.0 (`apps/synthsr/LICENSE`); upstream attribution in `apps/synthsr/NOTICE`
- `packages/synthsr`: Apache-2.0 (`packages/synthsr/LICENSE`); shared browser/native SynthSR pipeline
- `apps/seedseg` web application: MIT (`apps/seedseg/web/LICENSE`)
- `apps/deface`: BSD-2-Clause (`apps/deface/LICENSE`)
- `apps/easy-mp2rage`: GPL-3.0-or-later (`apps/easy-mp2rage/LICENSE`)
- `apps/niimath`: BSD-2-Clause (`apps/niimath/LICENSE`)
- `packages/degibbs`: MPL-2.0 (`packages/degibbs/LICENSE`), as the MRtrix3 `mrdegibbs` source it ports;
  attribution in `packages/degibbs/NOTICE`. It holds the degibbs WebAssembly module and command line
- `packages/shoreline`: Apache-2.0 AND BSD-3-Clause (`packages/shoreline/LICENSE`,
  `packages/shoreline/NOTICE`); the WebAssembly build of `exes/dwi/shoreline`, whose 3dSHORE
  and topup displacement crates port QSIPrep and DIPY code (BSD-3-Clause)
- `apps/dwicorrect`: Apache-2.0 AND BSD-3-Clause AND GPL-3.0-or-later: `@neurodesk/shoreline`,
  and the GPL-3.0-or-later PyHySCO port in `@neurodesk/sdc` (`packages/sdc/LICENSE`) for the
  susceptibility field
- `packages/niimath`: BSD-2-Clause (`packages/niimath/LICENSE`); niimath attribution in `packages/niimath/NOTICE`
- `apps/me-ica`: LGPL-2.1-only, as the `@niivue/meica` package it ships (LGPL-2.1-only, from
  https://github.com/niivue/meica-rs; a port of tedana, LGPL-2.1, and mapca and GIFT, GPL-2.0,
  whose developers permitted the LGPL-2.1)
- `apps/mri2vid`: BSD-3-Clause (`apps/mri2vid/LICENSE`)
- `packages/mri2vid`: BSD-3-Clause (`packages/mri2vid/LICENSE`); the shared
  mri2vid pipeline and its command line. The vendored muxers are MIT and the
  label font is public domain. The command line's VP9 encoder,
  `@libav.js/variant-vp9-opus`, is FFmpeg (LGPL-2.1-or-later) with libvpx and
  Opus (BSD-3-Clause), shipped unmodified as a separate replaceable module
  (`packages/mri2vid/NOTICE`).
- `apps/dcm2niix`: MIT (`apps/dcm2niix/LICENSE`); it runs the dcm2niix
  WebAssembly build (BSD, with OpenJPEG and CharLS) and its example is CC BY 4.0
  TCIA data. Notices are in `apps/dcm2niix/NOTICE`.
- `apps/browserqc`: BSD-2-Clause (`apps/browserqc/LICENSE`)
- `apps/surfannotate`: MIT (`apps/surfannotate/LICENSE`); bundled third-party
  notices in `apps/surfannotate/THIRD-PARTY.md`
- `packages/vesselboost`: UNLICENSED / NOASSERTION; extracted source preserves the upstream app status. QSM.rs and Rust third-party notices are included under `packages/vesselboost/preprocessing/`.
- `packages/spinalcordtoolbox`: UNLICENSED / NOASSERTION; extracted source preserves the upstream app status.
- `apps/vesselboost`, `apps/spinalcordtoolbox`, `apps/calmar`, and `apps/dicompare`:
  no machine-detectable top-level licence was present in the imported upstream
  snapshot; these are recorded as `NOASSERTION` until their maintainers add one.

Model and atlas licences are separate from application source licences. Scientific
asset manifests record their known licence and provenance; `NOASSERTION` means the
licence must be clarified before redistribution beyond the existing project scope.

## Homepage easter egg data

The human pial artery segmentation used by the homepage game (Vessel Surfer) is Subject 02's 140 µm whole-brain 7T time-of-flight arterial segmentation from Bollmann S, Mattern H, Bernier M, Robinson SD, Park D, Speck O, Polimeni JR. *Imaging of the pial arterial vasculature of the human brain in vivo using high-resolution 7T time-of-flight angiography.* eLife 2022;11:e71186, https://doi.org/10.7554/eLife.71186, shared on OSF at https://doi.org/10.17605/OSF.IO/NR6GC. The OSF project does not declare a data license; the article itself is CC BY 4.0. Attribution, pinned source checksum and processing changes are in `site/easter-eggs/vessel-surfer/public/data/ATTRIBUTION.md`. Derived assets are downloaded from the pinned Hugging Face revision in `data-manifest.json` during build; this data is separate from the site source license.
