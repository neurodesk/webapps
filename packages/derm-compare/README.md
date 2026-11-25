# @neurodesk/derm-compare

Sequential digital dermoscopy alignment, lesion contour comparison, and CIEDE2000 chromatic change mapping core and portable Node command line for the [DermCompare](../../apps/derm-compare) web application.

## Usage

```bash
derm-compare self-check
derm-compare t0.jpg t1.jpg out
derm-compare t0.jpg t1.jpg out --max-angle 35 --allow-scale
```

## Outputs

With `stem = <baseline>_vs_<followup>`:

- `<stem>_aligned.png` — follow-up image warped onto baseline coordinates (masked to mutual valid FOV)
- `<stem>_deltaE2000.png` — CIEDE2000 change heatmap composited over baseline with lesion contours
- `<stem>_metrics.csv` — registration transform, NCC, overlap, lesion area change, Dice/Jaccard, and ΔE2000 summary
- `<stem>_provenance.json` — full JSON provenance, transform convention, and metrics record
