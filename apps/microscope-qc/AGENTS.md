# microscope-qc instructions

- The numerics are pure JavaScript in `apps/microscope-qc/src/core` (`fit.js`, `psf.js`, `field.js`, `optics.js`), written from MetroloJ_QC's published definitions (Faklaris et al. 2022). MetroloJ_QC's repository has no licence, so never copy its code; it and Fiji ran only as references. `field.js` ports ImageJ 1's public-domain `GaussianBlur`, float32 arithmetic and integer rounding included, so the field metrics equal ImageJ's; keep that port exact.
- `test/fixtures/metroloj-reference.json` holds the ImageJ and MetroloJ_QC numbers, recorded by `validation/reference.mjs` (Docker `fiji/fiji`, MetroloJ_QC 1.3.1.2 jar). Rerecord it when detection, centring, the fit or an example changes; do not loosen the tolerances.
- TIFF input goes only through `@neurodesk/webapp-components/file-io/tiff`. Optics come from OME-XML when present (`src/core/optics.js`); every value can be typed in and a TIFF without metadata runs on typed values alone.
- The field-illumination example is synthetic: no openly licensed uniform-slide image was found. Replace it with a real one when one is published under an open licence.
