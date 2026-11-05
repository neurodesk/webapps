"""Write the TIFF fixtures of test/tiff-stack.test.js with tifffile (2026.10.15).

Run: python -I make_fixtures.py  (tifffile and numpy installed). Pixel values follow
value(page, sample, y, x) so the test recomputes them without the generator.
"""
import numpy as np
import tifffile


def value(page, sample, y, x, modulo):
    return (page * 37 + sample * 101 + y * 7 + x * 3) % modulo


def planes(pages, samples, height, width, dtype, modulo):
    p, s, y, x = np.meshgrid(np.arange(pages), np.arange(samples), np.arange(height), np.arange(width), indexing='ij')
    return value(p, s, y, x, modulo).astype(dtype)


# Three pages of 5 x 7 uint16, 4 pixels per centimetre in x and 2 in y, no description.
stack = planes(3, 1, 5, 7, np.uint16, 65521)[:, 0]
tifffile.imwrite('stack-u16.tif', stack, photometric='minisblack', metadata=None, resolution=(4.0, 2.0), resolutionunit='CENTIMETER')

# An ImageJ hyperstack: 2 slices x 2 channels of 4 x 6 uint8, 0.5 micron pixels, 2.5 micron slices.
hyper = planes(4, 1, 4, 6, np.uint8, 251)[:, 0].reshape(2, 2, 4, 6)
tifffile.imwrite('imagej-hyperstack.tif', hyper, imagej=True, resolution=(2.0, 2.0), metadata={'axes': 'ZCYX', 'spacing': 2.5, 'unit': 'um'})

# One RGBA page of 3 x 4 uint8 with unassociated alpha.
rgba = np.moveaxis(planes(1, 4, 3, 4, np.uint8, 251)[0], 0, -1)
tifffile.imwrite('rgba.tif', rgba, photometric='rgb', extrasamples=['unassalpha'])

# Two greyscale pages and a reduced-resolution thumbnail page after them.
with tifffile.TiffWriter('with-thumbnail.tif') as tif:
    for page in planes(2, 1, 4, 4, np.uint8, 251)[:, 0]:
        tif.write(page, metadata=None)
    tif.write(np.zeros((2, 2), np.uint8), subfiletype=1, metadata=None)

# A palette image, which the stack reader refuses.
tifffile.imwrite('palette.tif', planes(1, 1, 2, 2, np.uint8, 4)[0, 0], photometric='palette', colormap=np.zeros((3, 256), np.uint16), metadata=None)

# OME-XML written with a namespace prefix.
xml = ('<?xml version="1.0" encoding="UTF-8"?>'
       '<ome:OME xmlns:ome="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
       '<ome:Image ID="Image:0" Name="prefixed"><ome:Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint8" '
       'SizeX="3" SizeY="2" SizeZ="2" SizeC="1" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeXUnit="nm">'
       '<ome:Channel ID="Channel:0:0" Name="DAPI" SamplesPerPixel="1"/>'
       '<ome:TiffData IFD="0" PlaneCount="2"/></ome:Pixels></ome:Image></ome:OME>')
tifffile.imwrite('prefixed-ome.tif', planes(2, 1, 2, 3, np.uint8, 251)[:, 0], photometric='minisblack', description=xml, metadata=None)

# The same OME-XML with single-quoted attributes and an entity in the image name.
tifffile.imwrite('prefixed-ome-single-quoted.tif', planes(2, 1, 2, 3, np.uint8, 251)[:, 0], photometric='minisblack',
                 description=xml.replace('"', "'").replace("Name='prefixed'", "Name='cells &amp; nuclei'"), metadata=None)
