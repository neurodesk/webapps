"""Writes the small TIFF fixtures of test/tiff.test.js with tifffile.

    python -I make_tiff_fixtures.py <fixtures directory>

`main` was run with tifffile 2026.3.3; `microscopy` (the microscopy-*.tif files, moved here from
the deconvolution app's former reader), `page_mapping` and `samples_per_channel` with tifffile
2024.2.12.
"""
import sys

import numpy as np
import tifffile


def main(out):
    ramp = np.arange(3 * 4 * 5, dtype=np.uint16).reshape(3, 4, 5) * 997
    tifffile.imwrite(f"{out}/stack-deflate-uint16.ome.tif", ramp, ome=True, compression="zlib", predictor=True,
                     metadata={"axes": "TYX", "TimeIncrement": 0.25, "TimeIncrementUnit": "s",
                               "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm", "PhysicalSizeY": 750, "PhysicalSizeYUnit": "nm"})
    signed = (np.arange(3 * 4 * 5, dtype=np.int16).reshape(3, 4, 5) - 30) * 101
    tifffile.imwrite(f"{out}/stack-lzw-int16.tif", signed, compression="lzw", photometric="minisblack")
    floats = (np.arange(3 * 4 * 5, dtype=np.float32).reshape(3, 4, 5) / 7).astype(np.float32)
    tifffile.imwrite(f"{out}/stack-imagej-float32.tif", floats, imagej=True, resolution=(1 / 0.8, 1 / 0.8),
                     metadata={"axes": "TYX", "finterval": 0.5, "unit": "um"})
    rgb = np.zeros((4, 5, 3), dtype=np.uint8)
    tifffile.imwrite(f"{out}/rgb-uint8.tif", rgb, photometric="rgb")
    # Two OME Image series in one file: 3 time points, then 2.
    with tifffile.TiffWriter(f"{out}/two-series.ome.tif", ome=True) as tif:
        tif.write(ramp, metadata={"axes": "TYX"})
        tif.write(ramp[:2], metadata={"axes": "TYX"})
    # Planes for openTiffPlanes: an RGB page with an alpha, then an unspecified sample; a palette page.
    base = (np.arange(4 * 6).reshape(4, 6) * 7).astype(np.uint8)
    extras = np.stack([base, base + 1, base + 2, np.full_like(base, 255), base + 3], -1)
    tifffile.imwrite(f"{out}/rgb-alpha-extra.tif", extras, photometric="rgb", planarconfig="contig", extrasamples=["unassalpha", "unspecified"])
    colormap = np.zeros((3, 256), dtype=np.uint16)
    colormap[:, 1] = [65535, 0, 0]
    colormap[:, 2] = [0, 65535, 0]
    tifffile.imwrite(f"{out}/palette-uint8.tif", base % 3, photometric="palette", colormap=colormap)


def microscopy(out):
    stack = (np.arange(3 * 5 * 7, dtype=np.uint16).reshape(3, 5, 7) * 3 + 1)
    # ImageJ z stack, deflate-compressed, 0.0659 x 0.0659 x 0.13 micron.
    tifffile.imwrite(f"{out}/microscopy-imagej-uint16.tif", stack, imagej=True, resolution=(1 / 0.0659, 1 / 0.0659),
                     metadata={"spacing": 0.13, "unit": "micron", "axes": "ZYX"}, compression="zlib")
    # ImageJ with two channels.
    tifffile.imwrite(f"{out}/microscopy-imagej-two-channels.tif", np.stack([stack, stack], axis=1), imagej=True, metadata={"axes": "ZCYX"})
    # OME-TIFF float32 with nanometre sizes, then the same XML with an ome: namespace prefix.
    ome = dict(axes="ZYX", PhysicalSizeX=65.9, PhysicalSizeXUnit="nm", PhysicalSizeY=65.9, PhysicalSizeYUnit="nm", PhysicalSizeZ=0.13, PhysicalSizeZUnit="µm")
    tifffile.imwrite(f"{out}/microscopy-ome-float32-nm.ome.tif", stack.astype(np.float32) / 7, ome=True, metadata=ome)
    with tifffile.TiffFile(f"{out}/microscopy-ome-float32-nm.ome.tif") as tif:
        xml = tif.ome_metadata
    prefixed = xml.replace("<OME ", "<ome:OME xmlns:ome=\"http://www.openmicroscopy.org/Schemas/OME/2016-06\" ", 1).replace("</OME>", "</ome:OME>")
    for tag in ("Image", "Pixels", "Channel", "TiffData", "Plane"):
        prefixed = prefixed.replace(f"<{tag} ", f"<ome:{tag} ").replace(f"<{tag}>", f"<ome:{tag}>").replace(f"</{tag}>", f"</ome:{tag}>")
    with tifffile.TiffWriter(f"{out}/microscopy-ome-prefixed-nm.ome.tif") as writer:
        for z, plane in enumerate(stack.astype(np.float32) / 7):
            writer.write(plane, photometric="minisblack", description=prefixed.encode("utf-8") if z == 0 else None, metadata=None)
    # Grey plus an alpha extra sample per page: the first sample is the intensity.
    alpha = np.stack([stack.astype(np.uint8), np.full_like(stack, 255, dtype=np.uint8)], axis=-1)
    tifffile.imwrite(f"{out}/microscopy-gray-alpha.tif", alpha, photometric="minisblack", extrasamples=["unassalpha"], metadata=None)
    # Three samples marked MinIsBlack with no extra samples: three channels.
    tifffile.imwrite(f"{out}/microscopy-three-samples-minisblack.tif", np.stack([stack.astype(np.uint8)] * 3, axis=-1), photometric="minisblack", planarconfig="contig", metadata=None)
    # WhiteIsZero 8-bit.
    tifffile.imwrite(f"{out}/microscopy-white-is-zero.tif", stack.astype(np.uint8), photometric="miniswhite", metadata=None)
    # Plain TIFF with a centimetre resolution (20000 px/cm), which is a print size, not a voxel size.
    tifffile.imwrite(f"{out}/microscopy-resolution-cm.tif", stack[:1], resolution=(20000, 20000), resolutionunit="CENTIMETER", metadata=None)
    # ImageJ 8-bit stack with a colour lookup table, stored as Palette: indices are intensities.
    lut = np.zeros((3, 256), dtype=np.uint8)
    lut[0] = np.arange(256)
    tifffile.imwrite(f"{out}/microscopy-imagej-palette.tif", stack.astype(np.uint8), imagej=True, colormap=lut, metadata={"axes": "ZYX"})
    # The same Palette pages without ImageJ metadata: indexed colour.
    tifffile.imwrite(f"{out}/microscopy-palette.tif", stack.astype(np.uint8), photometric="palette", colormap=lut, metadata=None)


def page_mapping(out):
    ns = "http://www.openmicroscopy.org/Schemas/OME/2016-06"
    pixels = '<Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="3" SizeY="2" SizeC="1" SizeZ="2" SizeT="1">'
    planes = [np.full((2, 3), 20, dtype=np.uint16), np.full((2, 3), 10, dtype=np.uint16)]
    # IFD 0 holds Z 1 and IFD 1 holds Z 0: tifffile's asarray() gives the planes as [10, 20].
    swapped = f'<OME xmlns="{ns}"><Image ID="Image:0">{pixels}<TiffData IFD="0" FirstZ="1" PlaneCount="1"/><TiffData IFD="1" FirstZ="0" PlaneCount="1"/></Pixels></Image></OME>'
    # The planes are in another file.
    external = (f'<OME xmlns="{ns}" UUID="urn:uuid:11111111-1111-1111-1111-111111111111"><Image ID="Image:0">{pixels}'
                '<TiffData IFD="0" PlaneCount="2"><UUID FileName="other.ome.tif">urn:uuid:22222222-2222-2222-2222-222222222222</UUID></TiffData></Pixels></Image></OME>')
    for name, xml in (("ome-swapped-planes.ome.tif", swapped), ("ome-external-planes.ome.tif", external)):
        with tifffile.TiffWriter(f"{out}/{name}") as writer:
            for k, plane in enumerate(planes):
                writer.write(plane, photometric="minisblack", description=xml.encode() if k == 0 else None, metadata=None)
        if name == "ome-swapped-planes.ome.tif":
            with tifffile.TiffFile(f"{out}/{name}") as tif:
                assert tif.series[0].asarray()[:, 0, 0].tolist() == [10, 20]
    # Two full-resolution pages, each followed by a half-size reduced-resolution copy (NewSubfileType 1).
    with tifffile.TiffWriter(f"{out}/reduced-resolution.tif") as writer:
        for value in (5, 7):
            writer.write(np.full((4, 6), value, dtype=np.uint8), photometric="minisblack", metadata=None)
            writer.write(np.full((2, 3), 99, dtype=np.uint8), photometric="minisblack", subfiletype=1, metadata=None)


def samples_per_channel(out):
    # OME counts samples in SizeC: tifffile writes SizeC 3 (or 2) with one Channel of
    # SamplesPerPixel 3 (or 2) and one IFD per z plane, as Bio-Formats does.
    rgb = np.zeros((2, 3, 4, 3), dtype=np.uint8)
    rgb[0] = (30, 60, 90)
    rgb[1] = (90, 120, 150)
    tifffile.imwrite(f"{out}/ome-rgb-z2.ome.tif", rgb, ome=True, photometric="rgb", metadata={"axes": "ZYXS"})
    alpha = np.full((2, 3, 4, 2), 255, dtype=np.uint8)
    alpha[0, ..., 0] = 10
    alpha[1, ..., 0] = 20
    tifffile.imwrite(f"{out}/ome-gray-alpha.ome.tif", alpha, ome=True, photometric="minisblack", extrasamples=["unassalpha"], metadata={"axes": "ZYXS"})


if __name__ == "__main__":
    main(sys.argv[1])
    microscopy(sys.argv[1])
    page_mapping(sys.argv[1])
    samples_per_channel(sys.argv[1])
