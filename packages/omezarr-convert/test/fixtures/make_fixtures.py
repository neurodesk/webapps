"""Write the OME-TIFF fixtures of test/sources.test.js with tifffile (2026.10.15).

Run: python -I make_fixtures.py. value(t, c, z, y, x) is recomputed by the test.
"""
import numpy as np
import tifffile


def planes(shape, dtype):
    t, c, z, y, x = np.meshgrid(*[np.arange(n) for n in shape], indexing='ij')
    return ((t * 1000 + c * 100 + z * 10 + y * 3 + x) % 251).astype(dtype)


# T=2, C=3, Z=2 of 5 x 6 uint16, DimensionOrder XYCZT, channel names, nanometre pixels.
tifffile.imwrite(
    'tczyx-named.ome.tif', planes((2, 3, 2, 5, 6), np.uint16), ome=True, photometric='minisblack',
    metadata={
        'axes': 'TCZYX',
        'Name': 'named channels',
        'PhysicalSizeX': 65.0, 'PhysicalSizeXUnit': 'nm',
        'PhysicalSizeY': 65.0, 'PhysicalSizeYUnit': 'nm',
        'PhysicalSizeZ': 0.3, 'PhysicalSizeZUnit': 'µm',
        'Channel': {'Name': ['DAPI', 'GFP', 'mCherry'], 'Color': [65535, 16711935, -16776961]},
    },
)

# Float32, ZYX, no physical sizes.
tifffile.imwrite('zyx-float.ome.tif', (planes((1, 1, 3, 4, 7), np.float32) / 3)[0, 0], ome=True, metadata={'axes': 'ZYX'})

# A 16-bit greyscale PNG of 4 x 3 with pHYs 2,000,000 px/m in x and 1,000,000 in y (Pillow).
from PIL import Image  # noqa: E402

image = Image.fromarray(np.arange(12, dtype=np.uint16).reshape(3, 4) * 4000)
image.save('phys-16bit.png', dpi=(50800, 25400))

# The fixtures below are written with tifffile 2024.2.12 from hand-written OME-XML.
OME = 'http://www.openmicroscopy.org/Schemas/OME/2016-06'


def ome_xml(root_uuid, pixels_attributes, tiff_data):
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            f'<OME xmlns="{OME}" UUID="{root_uuid}">'
            '<Image ID="Image:0" Name="cells"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8" '
            f'SizeX="3" SizeY="2" {pixels_attributes}><Channel ID="Channel:0:0" SamplesPerPixel="1"/>'
            f'{tiff_data}</Pixels></Image></OME>')


# Bio-Formats style: the root UUID and each TiffData's UUID name the file as it was written
# (original.ome.tif). The test opens it under another name.
own = 'urn:uuid:0b4bd2e3-8f8c-4c8e-9a38-1d1c0d6f0001'
xml = ome_xml(own, 'SizeZ="2" SizeC="1" SizeT="1"',
              f'<TiffData FirstZ="0" IFD="0" PlaneCount="1"><UUID FileName="original.ome.tif">{own}</UUID></TiffData>'
              f'<TiffData FirstZ="1" IFD="1" PlaneCount="1"><UUID FileName="original.ome.tif">{own}</UUID></TiffData>')
tifffile.imwrite('bioformats-style.ome.tif', planes((1, 1, 2, 2, 3), np.uint8)[0, 0], photometric='minisblack', description=xml, metadata=None)

# One file of a two-file dataset: Z 1 is in another file (another UUID).
other = 'urn:uuid:0b4bd2e3-8f8c-4c8e-9a38-1d1c0d6f0002'
xml = ome_xml(own, 'SizeZ="2" SizeC="1" SizeT="1"',
              f'<TiffData FirstZ="0" IFD="0" PlaneCount="1"><UUID FileName="part0.ome.tif">{own}</UUID></TiffData>'
              f'<TiffData FirstZ="1" IFD="0" PlaneCount="1"><UUID FileName="part1.ome.tif">{other}</UUID></TiffData>')
tifffile.imwrite('multifile-part0.ome.tif', planes((1, 1, 1, 2, 3), np.uint8)[0, 0, 0], photometric='minisblack', description=xml, metadata=None)

# Units as character references (&#181;m, &#xB5;m) and a time increment in milliseconds.
xml = ome_xml(own, 'SizeZ="1" SizeC="1" SizeT="2" PhysicalSizeX="0.5" PhysicalSizeXUnit="&#181;m" '
              'PhysicalSizeY="0.5" PhysicalSizeYUnit="&#xB5;m" PhysicalSizeZ="2" PhysicalSizeZUnit="nm" '
              'TimeIncrement="2.5" TimeIncrementUnit="ms"', '<TiffData IFD="0" PlaneCount="2"/>')
tifffile.imwrite('calibrated-entities.ome.tif', planes((2, 1, 1, 2, 3), np.uint8)[:, 0, 0], photometric='minisblack', description=xml, metadata=None)
