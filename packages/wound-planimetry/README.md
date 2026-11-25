# @neurodesk/wound-planimetry

Calibrated digital wound planimetry (area, perimeter, Feret/principal axes, Kundin ellipsoid area, circularity, compactness) and heuristic CIE L\*a\*b\* / HSV Red-Yellow-Black (RYB) tissue estimation core and portable Node command line for the [Wound Planimetry](../../apps/wound-planimetry) web application.

## Usage

```bash
wound-planimetry self-check
wound-planimetry wound.jpg out
wound-planimetry wound.jpg out --mm-per-pixel 0.1
wound-planimetry wound.jpg out --ruler 20,20,120,20 --scale-mm 10
```

## Calibration options

- `--pixels-per-mm N` — spatial calibration in pixels per millimetre (0–1000; default 0 reports pixel units)
- `--mm-per-pixel N` — spatial calibration in millimetres per pixel (converted to `1 / N` px/mm)
- `--scale-mm N --scale-px P` — known physical length in mm spanning `P` pixels
- `--scale-mm N --ruler X1,Y1,X2,Y2` — known physical length in mm between two pixel coordinates on a ruler

## Outputs

- `<stem>_wound-ryb-overlay.png` — composited RYB tissue + wound contour overlay PNG
- `<stem>_wound-mask.png` — binary 8-bit wound mask (0/255)
- `<stem>_wound-planimetry.csv` — planimetry geometry and RYB tissue table
- `<stem>_wound-provenance.json` — full JSON provenance, calibration, segmentation, and RYB record
