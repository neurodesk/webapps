# Licensing and provenance

This monorepo contains independently developed applications and packages. There is
no blanket repository-wide licence. The canonical source commit and declared licence
for each app are recorded in `registry/apps.yml`.

- `packages/components`: MIT (`packages/components/LICENSE`)
- `apps/musclemap`: MIT (`apps/musclemap/web/LICENSE`)
- `apps/qsmbly`: MIT (`apps/qsmbly/LICENSE`)
- `apps/synthsr`: Apache-2.0 (`apps/synthsr/LICENSE`); upstream attribution in `apps/synthsr/NOTICE`
- `packages/synthsr`: Apache-2.0 (`packages/synthsr/LICENSE`); shared browser/native SynthSR pipeline
- `apps/seedseg` web application: MIT (`apps/seedseg/web/LICENSE`)
- `apps/deface`: BSD-2-Clause (`apps/deface/LICENSE`)
- `apps/easy-mp2rage`: GPL-3.0-or-later (`apps/easy-mp2rage/LICENSE`)
- `apps/niimath`: BSD-2-Clause (`apps/niimath/LICENSE`)
- `apps/dicom2vid`: BSD-3-Clause (`apps/dicom2vid/LICENSE`)
- `apps/browserqc`: BSD-2-Clause (`apps/browserqc/LICENSE`)
- `apps/surfannotate`: MIT (`apps/surfannotate/LICENSE`); bundled third-party
  notices in `apps/surfannotate/THIRD-PARTY.md`
- `apps/vesselboost`, `apps/spinalcordtoolbox`, `apps/calmar`, and `apps/dicompare`:
  no machine-detectable top-level licence was present in the imported upstream
  snapshot; these are recorded as `NOASSERTION` until their maintainers add one.

Model and atlas licences are separate from application source licences. Scientific
asset manifests record their known licence and provenance; `NOASSERTION` means the
licence must be clarified before redistribution beyond the existing project scope.

## Homepage easter egg data

The human pial artery segmentation used by the homepage game (Vessel Surfer) is Subject 02's 140 µm whole-brain 7T time-of-flight arterial segmentation from Bollmann S, Mattern H, Bernier M, Robinson SD, Park D, Speck O, Polimeni JR. *Imaging of the pial arterial vasculature of the human brain in vivo using high-resolution 7T time-of-flight angiography.* eLife 2022;11:e71186, https://doi.org/10.7554/eLife.71186, shared on OSF at https://doi.org/10.17605/OSF.IO/NR6GC. The OSF project does not declare a data license; the article itself is CC BY 4.0. Attribution, pinned source checksum and processing changes are in `site/easter-eggs/vessel-surfer/public/data/ATTRIBUTION.md`. Derived assets are downloaded from the pinned Hugging Face revision in `data-manifest.json` during build; this data is separate from the site source license.
