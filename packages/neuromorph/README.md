# `@neurodesk/neuromorph`

SWC neuron morphology validation, repair, NeuroM 4 morphometrics and Sholl analysis core and portable command line.

## Usage

```bash
# Verify installation
neuromorph self-check

# Measure a single SWC reconstruction with 10 µm Sholl step
neuromorph n120.CNG.swc results

# Measure a folder of SWC reconstructions with 20 µm Sholl step
neuromorph swc_dir/ results --sholl-step 20
```

No network connection or external model files are required.
