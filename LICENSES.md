# Licensing and provenance

This monorepo contains independently developed applications and packages. There is
no blanket repository-wide licence. The canonical source commit and declared licence
for each app are recorded in `registry/apps.yml`.

- `packages/components`: MIT (`packages/components/LICENSE`)
- `apps/musclemap`: MIT (`apps/musclemap/web/LICENSE`)
- `apps/qsmbly`: MIT (`apps/qsmbly/LICENSE`)
- `apps/seedseg` web application: MIT (`apps/seedseg/web/LICENSE`)
- `apps/vesselboost`, `apps/spinalcordtoolbox`, `apps/calmar`, and `apps/dicompare`:
  no machine-detectable top-level licence was present in the imported upstream
  snapshot; these are recorded as `NOASSERTION` until their maintainers add one.

Model and atlas licences are separate from application source licences. Scientific
asset manifests record their known licence and provenance; `NOASSERTION` means the
licence must be clarified before redistribution beyond the existing project scope.
