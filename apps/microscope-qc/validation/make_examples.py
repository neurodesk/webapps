"""Writes the two microscope-qc examples (run with python -I; numpy and tifffile).

beads: a 512 x 512 x 81 crop (x 576-1087, y 704-1215, every plane) of
  "NA095/Z-Stack 13-08-2021 01.21.20/stack/stack.tif" from Miora, Senftleben and
  Abrahamsson, Zenodo 10.5281/zenodo.10522322 (CC BY 4.0): 100 nm TetraSpeck beads,
  EVOS M5000 widefield, Olympus 40x/0.95 air objective, GFP cube, correction collar at
  0.17 mm. The pixel size, z step, NA and refractive index come from the EVOS metadata of
  the stack's planes (MicronsPerPixel, StepSizeInMicrons, Objective NA, Objective RI); the
  wavelengths are the EVOS GFP light cube's band centres (excitation 470 nm, emission 525 nm).
  Pixels are unchanged; only the OME-XML header is added (sizes in the default unit, µm).

field: a synthetic 640 x 480 uint16 field-illumination image with a known, off-centre
  Gaussian illumination profile and Poisson noise (seed 20261105). It is not a measurement.

usage: python -I make_examples.py <stack.tif> <out-dir>
"""
import sys
from pathlib import Path
import numpy as np
import tifffile

stack_path, out = sys.argv[1], Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

PIXEL = 0.12615174312957611
STEP = 0.1328337499999975


def ome(size_x, size_y, size_z, pixel_type, pixels_extra, channel, objective, mode):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
        '<Instrument ID="Instrument:0">'
        f'<Objective ID="Objective:0" {objective}/>'
        '</Instrument>'
        '<Image ID="Image:0" Name="example">'
        '<ObjectiveSettings ID="Objective:0" RefractiveIndex="1.000277"/>'
        f'<Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="{pixel_type}" SizeX="{size_x}" SizeY="{size_y}" SizeZ="{size_z}" SizeC="1" SizeT="1" {pixels_extra}>'
        f'<Channel ID="Channel:0:0" SamplesPerPixel="1" AcquisitionMode="{mode}" {channel}/>'
        '<TiffData/>'
        '</Pixels></Image></OME>'
    )


stack = tifffile.imread(stack_path)
assert stack.shape == (81, 1536, 2048) and stack.dtype == np.uint8
beads = np.ascontiguousarray(stack[:, 704:1216, 576:1088])
xml = ome(512, 512, 81, 'uint8',
          f'PhysicalSizeX="{PIXEL}" PhysicalSizeY="{PIXEL}" PhysicalSizeZ="{STEP}"',
          'Name="GFP" ExcitationWavelength="470" ExcitationWavelengthUnit="nm" EmissionWavelength="525" EmissionWavelengthUnit="nm"',
          'Manufacturer="Olympus" Model="AMEP4907 40x" NominalMagnification="40" LensNA="0.95" Immersion="Air"',
          'WideField')
tifffile.imwrite(out / 'evos-40x-na095-tetraspeck-100nm.ome.tif', beads, description=xml, compression='zlib', metadata=None)

height, width = 480, 640
y, x = np.mgrid[0:height, 0:width].astype(np.float64)
cx, cy, sigma = 352.0, 228.0, 330.0
profile = 200.0 + 3800.0 * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))
rng = np.random.default_rng(20261105)
field = rng.poisson(profile).astype(np.uint16)
xml = ome(width, height, 1, 'uint16',
          'PhysicalSizeX="0.65" PhysicalSizeY="0.65"',
          'Name="synthetic" EmissionWavelength="525" EmissionWavelengthUnit="nm"',
          'LensNA="0.3" Immersion="Air"',
          'WideField')
tifffile.imwrite(out / 'synthetic-field-illumination.ome.tif', field, description=xml, compression='zlib', metadata=None)
np.save(out / 'synthetic-field-profile.npy', profile)
print('beads', beads.shape, 'field', field.shape, field.min(), field.max())
