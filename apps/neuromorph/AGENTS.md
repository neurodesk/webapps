# neuromorph instructions

- The SWC checks, morphometrics, Sholl analysis and tables live in `apps/neuromorph/src/morph` (pure, no DOM); the app adds the UI and the NiiVue tube view. The definitions are NeuroM 4's, implemented cleanly; `README.md` lists them and every deliberate difference.
- Samples are rounded to single precision as they are read, because MorphIO stores them that way; without it bifurcation angles drift from NeuroM by up to 1e-4 relative.
- `validation/neurom-reference.json` holds NeuroM 4.0.6's numbers for both hosted examples and NeuroM's committed test morphologies (`test/fixtures/neurom`). `test/neurom-parity.test.js` and `e2e/smoke.spec.js` require 1e-6 relative and identical counts and Sholl intersections. Rerecord with `validation/neurom_reference.py` (pins in `validation/requirements.txt`) when a definition or an example changes.
