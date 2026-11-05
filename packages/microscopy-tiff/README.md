# @neurodesk/microscopy-tiff

Single-channel microscopy stacks from TIFF, OME-TIFF and ImageJ TIFF with their voxel size, and
calibrated float32 ImageJ TIFF output. geotiff.js (MIT, pinned 3.0.5) decodes the pixels with
every compression it supports; this package decides what the pages mean.

```js
import { readTiffStack, writeImageJTiff, TiffRefusal } from "@neurodesk/microscopy-tiff";

const stack = await readTiffStack(arrayBuffer, { maxBytes: 2 ** 30 });
// { width, height, depth, dtype, data /* [z][y][x], x fastest */, spacingUm: { x, y, z },
//   spacingSource: "OME-XML" | "ImageJ" | "TIFF resolution" | null, description }
const bytes = writeImageJTiff({ data: float32, width, height, depth, spacingUm });
```

Reading rules:

- **Intensity samples.** PhotometricInterpretation decides: BlackIsZero is read as is,
  WhiteIsZero is inverted, RGB, YCbCr, CMYK and other colour models are refused. Palette is
  read as intensity only in ImageJ files, which store a display lookup table that way, and
  refused elsewhere. ExtraSamples 1 and 2 (alpha) are skipped; unspecified extra samples (0)
  are further channels, so a page with more than one non-alpha sample is refused. Three
  samples are not assumed to be RGB.
- **Stacks.** Full-resolution pages (NewSubfileType bit 0 clear) form the z stack and must
  share size and type. OME-XML is recognised with or without a namespace prefix
  (`<ome:OME>`); multi-image (series), multichannel or time-lapse OME files and ImageJ
  hyperstacks with channels or frames are refused, as are OME sizes that disagree with the
  pages.
- **Memory.** Width × height × pages × samples × bytes per sample is checked against
  `maxBytes` before any pixel is decoded.
- **Voxel size**, in micrometres: OME `PhysicalSize*` with its unit (m, cm, mm, µm, nm, Å);
  else ImageJ's `unit=` with X/YResolution in pixels per unit and `spacing=` for z; else the
  TIFF resolution tags in inch or centimetre units. Axes without a calibration are `null`.

`writeImageJTiff` writes an uncompressed little-endian float32 TIFF, one page per plane, with
the ImageJ description (`unit=micron`, `spacing=`) and X/YResolution in pixels per micrometre,
so Fiji, ImageJ and tifffile open it as a calibrated stack.

The test fixtures are written by tifffile (`scripts/make_fixtures.py`), independently of this
reader. Licence: MIT.
