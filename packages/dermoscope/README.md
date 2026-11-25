# @neurodesk/dermoscope

Deterministic dermoscopic lesion preprocessing (vignette masking, DullRazor hair removal, Shades of Gray color constancy), CIE L\*a\*b\* Otsu border segmentation, and experimental automated ABCD morphometry core and portable Node command line for the [Dermoscope ABCD](../../apps/dermoscope) web application.

## Usage

```bash
dermoscope self-check
dermoscope lesion.jpg out
dermoscope lesion.jpg out --pixels-per-mm 12.5 --differential-structures 3
```

## Outputs

- `<stem>_preprocessed.png` — preprocessed dermoscopy image (hair-removed, color-constant)
- `<stem>_mask.png` — binary 8-bit lesion mask (0/255)
- `<stem>_abcd_metrics.csv` — experimental automated A/B/C morphometry, geometry, and color coverage
- `<stem>_provenance.json` — structured JSON provenance and full morphometry record

Experimental automated morphometry only — not a clinical diagnosis.
