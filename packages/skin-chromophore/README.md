# @neurodesk/skin-chromophore

Quantitative skin colorimetry (CIE L\*a\*b\*, ITA°, CIEDE2000) and uncalibrated fixed-basis RGB optical-density chromophore proxy mapping core and portable Node command line for the [Skin Chromophore](../../apps/skin-chromophore) web application.

## Usage

```bash
skin-chromophore self-check
skin-chromophore skin.jpg out
skin-chromophore skin.jpg out --white-balance --roi-mode auto
```

## Outputs

- `<stem>_hemoglobin.png` — hemoglobin optical-density proxy map (p2–p98 linear ramp)
- `<stem>_melanin.png` — melanin optical-density proxy map (p2–p98 linear ramp)
- `<stem>_ita.png` — 6-band Del Bino / Chardon ITA° skin typology map
- `<stem>_colorimetry.csv` — Target, Reference, and Target-minus-Reference colorimetry and ΔE2000 table
- `<stem>_provenance.json` — full JSON provenance, basis matrix specification, and ROI summaries
