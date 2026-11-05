"""Stages the pinned example movie, froemke-nv60-a1-gcamp-400frames.ome.tif, from DANDI 000249.

    python -I stage_example.py <output directory>

Downloads `sub-NV60/sub-NV60_ses-20180307T125239_ophys.nwb` (asset 3f5e9d1d-…, 82.4 MB) from
DANDI 000249 version 0.230423.1416 (https://doi.org/10.48324/dandi.000249/0.230423.1416, CC BY
4.0), checks its SHA-256, and writes frames 400-799 (0-based, end exclusive) of its raw
TwoPhotonSeries (820 x 256 x 256 uint16 at 3.90625 Hz) as a zlib OME-TIFF with tifffile
2026.3.3 (h5py 3.x reads the NWB). tifffile compresses with Python's zlib (1.2.11) here, as it
did for the pinned file: with imagecodecs it would use libdeflate, whose bytes differ. The
result equals the pinned file byte for byte except the random OME UUID, so its SHA-256 is not
the one in `examples.json`.
Also writes the README.md uploaded beside it on Hugging Face (`calcium-imaging/example/`).
"""
import hashlib
import sys
import urllib.request

import h5py
import numpy as np

sys.modules["imagecodecs"] = None  # tifffile's own zlib codec, as for the pinned file (above)
import tifffile  # noqa: E402

DANDISET = "000249"
VERSION = "0.230423.1416"
ASSET_ID = "3f5e9d1d-f1c0-44c1-bff2-2b005c9e1edc"
ASSET_PATH = "sub-NV60/sub-NV60_ses-20180307T125239_ophys.nwb"
NWB_SHA256 = "56dd53d81c5cd62b2b40d6640954129bcbd96e927eea8e22e69a94fa2dda8827"
FIRST, END = 400, 800
NAME = "froemke-nv60-a1-gcamp-400frames.ome.tif"

NOTICE = f"""# Calcium imaging example

`{NAME}` is an excerpt (frames 400-799, 0-based, of 820) of the raw, unaligned two-photon
TwoPhotonSeries in `{ASSET_PATH}`, converted to OME-TIFF (uint16, zlib, 256 x 256 pixels,
TimeIncrement 0.256 s). It was made by `apps/calcium-imaging/validation/stage_example.py` in
https://github.com/neurodesk/webapps. No pixel was changed.

Source: DANDI archive, Dandiset {DANDISET} version {VERSION}, "Innate and plastic mechanisms for
maternal behaviour in auditory cortex", https://doi.org/10.48324/dandi.{DANDISET}/{VERSION}

Authors: Jennifer K. Schiavo, Silvana Valtcheva, Chloe J. Bair-Marshall, Soomin C. Song,
Kathleen A. Martin and Robert C. Froemke (dataset contributor: Ben Dichter).

Licence: Creative Commons Attribution 4.0 International (CC BY 4.0),
https://creativecommons.org/licenses/by/4.0/. The excerpt is distributed under the same licence.

Cite: Schiavo JK, Valtcheva S, Bair-Marshall CJ, Song SC, Martin KA, Froemke RC (2020) Innate and
plastic mechanisms for maternal behaviour in auditory cortex. Nature 587:426-431, and the
Dandiset above.
"""


def main(out):
    nwb = f"{out}/{ASSET_PATH.split('/')[-1]}"
    urllib.request.urlretrieve(f"https://api.dandiarchive.org/api/assets/{ASSET_ID}/download/", nwb)
    with open(nwb, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    if digest != NWB_SHA256:
        sys.exit(f"{nwb}: SHA-256 {digest}, expected {NWB_SHA256}")
    with h5py.File(nwb, "r") as f:
        series = f["acquisition/TwoPhotonSeries"]
        rate = float(series["starting_time"].attrs["rate"])
        movie = np.asarray(series["data"][FIRST:END], dtype=np.uint16)
    tifffile.imwrite(f"{out}/{NAME}", movie, ome=True, compression="zlib", predictor=True,
                     metadata={"axes": "TYX", "TimeIncrement": 1 / rate, "TimeIncrementUnit": "s"})
    with open(f"{out}/README.md", "w", encoding="utf-8") as handle:
        handle.write(NOTICE)


if __name__ == "__main__":
    main(sys.argv[1])
