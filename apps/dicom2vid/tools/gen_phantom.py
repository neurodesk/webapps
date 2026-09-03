"""Generate fully synthetic phantom images for parity and reader tests.

Zero subject data (PHI) is involved: every value here is computed from a formula.
Outputs go to tools/phantom_out/ (gitignored) and reader goldens to tools/golden/
(gitignored). Regenerate any time with:

    python tools/gen_phantom.py

The phantom volume is small and anisotropic (Rows, Columns, Slices all differ) so
that orientation transposes yield distinguishable shapes, and the values increase
monotonically along every axis so that flips are detectable.
"""

import json
import struct
from pathlib import Path

import numpy as np
import nibabel as nib
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "phantom_out"
GOLDEN = ROOT / "golden"

# Volume dimensions: rows (H), columns (W), slices (N). All distinct.
H, W, N = 8, 6, 5
SPACING_Z = 2.5

MR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.4"           # MR Image Storage
ENHANCED_MR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.4.1"  # Enhanced MR Image Storage


def raw_gray(r, c, s):
    """Monotonic, non-symmetric pattern so transposes and flips are detectable."""
    return r * 37 + c * 11 + s * 5


def gray_volume():
    v = np.zeros((H, W, N), dtype=np.uint16)
    for r in range(H):
        for c in range(W):
            for s in range(N):
                v[r, c, s] = raw_gray(r, c, s)
    return v


def slope_for(s):
    return 1.0 + 0.25 * s


def intercept_for(s):
    return -3.0 * s


def z_for(s):
    return s * SPACING_Z


def new_file_meta(sop_class, sop_inst):
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = sop_class
    fm.MediaStorageSOPInstanceUID = sop_inst
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = generate_uid()
    return fm


def base_dataset(path, sop_class, study_uid, series_uid):
    sop_inst = generate_uid()
    ds = FileDataset(str(path), {}, file_meta=new_file_meta(sop_class, sop_inst),
                     preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.PatientName = "PHANTOM"
    ds.PatientID = "PHANTOM"
    ds.Modality = "MR"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SOPInstanceUID = sop_inst
    ds.SOPClassUID = sop_class
    ds.FrameOfReferenceUID = generate_uid()
    return ds


# ----------------------------------------------------------------------------
# Single-frame grayscale DICOM series
# ----------------------------------------------------------------------------
def write_dicom_single(volume, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    study = generate_uid()
    series = generate_uid()
    for s in range(N):
        # Filenames run opposite to spatial order, so the spatial sort has work
        # to do: alphabetical order gives slices reversed.
        path = out_dir / f"img_{N - 1 - s:03d}.dcm"
        ds = base_dataset(path, MR_SOP_CLASS, study, series)
        ds.SeriesDescription = "T1 MPRAGE"
        ds.RepetitionTime = "2300"
        ds.EchoTime = "2.98"
        ds.InversionTime = "900"
        ds.FlipAngle = "9"
        ds.MRAcquisitionType = "3D"
        ds.Rows = H
        ds.Columns = W
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleSlope = f"{slope_for(s):g}"
        ds.RescaleIntercept = f"{intercept_for(s):g}"
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [0.0, 0.0, float(z_for(s))]
        ds.PixelSpacing = [1.0, 1.0]
        ds.SpacingBetweenSlices = SPACING_Z
        ds.InstanceNumber = s + 1
        ds.PixelData = np.ascontiguousarray(volume[:, :, s]).astype("<u2").tobytes()
        ds.save_as(str(path), write_like_original=False)
    return series


# ----------------------------------------------------------------------------
# Single-frame series with NO geometry, only InstanceNumber. Filenames are in an
# order (img1, img10, img2, ...) that differs from instance order, so sorting must
# use InstanceNumber, matching load_and_sort_dicoms.
# ----------------------------------------------------------------------------
def write_dicom_nogeo(out_dir, count=10):
    out_dir.mkdir(parents=True, exist_ok=True)
    study = generate_uid()
    series = generate_uid()
    rows, cols = 4, 4
    for inst in range(1, count + 1):
        path = out_dir / f"img{inst}.dcm"  # lexicographic: img1, img10, img2, ...
        ds = base_dataset(path, MR_SOP_CLASS, study, series)
        ds.SeriesDescription = "NOGEO"
        ds.Rows = rows
        ds.Columns = cols
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.InstanceNumber = inst
        # Every pixel equals the InstanceNumber, so slice order is readable back.
        ds.PixelData = np.full((rows, cols), inst, dtype="<u2").tobytes()
        ds.save_as(str(path), write_like_original=False)
    return series


# ----------------------------------------------------------------------------
# Enhanced multiframe grayscale DICOM (single file, same volume)
# ----------------------------------------------------------------------------
def write_dicom_multiframe(volume, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "frames.dcm"
    study = generate_uid()
    series = generate_uid()
    ds = base_dataset(path, ENHANCED_MR_SOP_CLASS, study, series)
    ds.SeriesDescription = "T1 MPRAGE MF"
    ds.Rows = H
    ds.Columns = W
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.NumberOfFrames = N

    # Frame f holds slice s = N-1-f, so frames are stored in reverse spatial
    # order and the per-frame geometry sort must reorder them.
    per_frame = Sequence()
    frame_stack = np.zeros((N, H, W), dtype="<u2")
    for f in range(N):
        s = N - 1 - f
        frame_stack[f] = volume[:, :, s].astype("<u2")

        item = Dataset()
        pp = Dataset()
        pp.ImagePositionPatient = [0.0, 0.0, float(z_for(s))]
        item.PlanePositionSequence = Sequence([pp])

        po = Dataset()
        po.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        item.PlaneOrientationSequence = Sequence([po])

        pvt = Dataset()
        pvt.RescaleSlope = f"{slope_for(s):g}"
        pvt.RescaleIntercept = f"{intercept_for(s):g}"
        pvt.RescaleType = "US"
        item.PixelValueTransformationSequence = Sequence([pvt])

        fc = Dataset()
        fc.DimensionIndexValues = [f + 1]
        item.FrameContentSequence = Sequence([fc])

        per_frame.append(item)

    ds.PerFrameFunctionalGroupsSequence = per_frame
    ds.PixelData = frame_stack.tobytes()
    ds.save_as(str(path), write_like_original=False)
    return series


# ----------------------------------------------------------------------------
# RGB (color) DICOM series, e.g. a color-FA map. No Python golden exists for the
# video pipeline (the reference is grayscale-only); this is for the JS reader.
# ----------------------------------------------------------------------------
def rgb_volume():
    v = np.zeros((H, W, N, 3), dtype=np.uint8)
    for r in range(H):
        for c in range(W):
            for s in range(N):
                v[r, c, s, 0] = (r * 37 + c * 11 + s * 5) % 256
                v[r, c, s, 1] = (r * 30 + c * 20) % 256
                v[r, c, s, 2] = (s * 50 + r * 10) % 256
    return v


def write_dicom_rgb(volume_rgb, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    study = generate_uid()
    series = generate_uid()
    for s in range(N):
        path = out_dir / f"rgb_{s:03d}.dcm"
        ds = base_dataset(path, MR_SOP_CLASS, study, series)
        ds.SeriesDescription = "DTI_ColFA"
        ds.Rows = H
        ds.Columns = W
        ds.SamplesPerPixel = 3
        ds.PhotometricInterpretation = "RGB"
        ds.PlanarConfiguration = 0
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [0.0, 0.0, float(z_for(s))]
        ds.InstanceNumber = s + 1
        # Interleaved R,G,B per pixel, row-major.
        ds.PixelData = np.ascontiguousarray(volume_rgb[:, :, s, :]).tobytes()
        ds.save_as(str(path), write_like_original=False)
    return series


# ----------------------------------------------------------------------------
# Siemens mosaic series: each file tiles a whole volume into one square frame, so
# a run of files is 4D (fMRI timepoints or diffusion directions). Tiles sit
# row-major on a ceil(sqrt(n)) grid with the unused trailing cells zero-filled.
# ----------------------------------------------------------------------------
MOSAIC_TILE = 4      # tile is TILE x TILE
MOSAIC_SLICES = 5    # real slices per volume (grid is 3x3, so 4 cells are padding)
MOSAIC_VOLUMES = 3


def mosaic_voxel(r, c, s, v):
    """Distinct along every axis including the volume index."""
    return r * 29 + c * 7 + s * 3 + v * 100


def mosaic_expected():
    """The (tile, tile, slices, volumes) array the reader must recover."""
    out = np.zeros((MOSAIC_TILE, MOSAIC_TILE, MOSAIC_SLICES, MOSAIC_VOLUMES), dtype=np.float32)
    for r in range(MOSAIC_TILE):
        for c in range(MOSAIC_TILE):
            for s in range(MOSAIC_SLICES):
                for v in range(MOSAIC_VOLUMES):
                    out[r, c, s, v] = mosaic_voxel(r, c, s, v)
    return out


def write_dicom_mosaic(out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    study = generate_uid()
    series = generate_uid()
    grid = int(np.ceil(np.sqrt(MOSAIC_SLICES)))
    side = grid * MOSAIC_TILE
    expected = mosaic_expected()

    for v in range(MOSAIC_VOLUMES):
        path = out_dir / f"mosaic_{v:03d}.dcm"
        ds = base_dataset(path, MR_SOP_CLASS, study, series)
        ds.SeriesDescription = "cmrr_mbep2d_bold"
        ds.ImageType = ["ORIGINAL", "PRIMARY", "M", "ND", "MOSAIC"]
        ds.RepetitionTime = "900"
        ds.EchoTime = "22"
        ds.Rows = side
        ds.Columns = side
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.PixelSpacing = [1.5, 1.5]
        ds.SliceThickness = 1.5
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [0.0, 0.0, 0.0]
        ds.InstanceNumber = v + 1
        # Siemens private tag: number of real slices tiled into the frame.
        ds.add_new((0x0019, 0x100A), "US", MOSAIC_SLICES)

        frame = np.zeros((side, side), dtype=np.uint16)
        for s in range(MOSAIC_SLICES):
            r0 = (s // grid) * MOSAIC_TILE
            c0 = (s % grid) * MOSAIC_TILE
            frame[r0:r0 + MOSAIC_TILE, c0:c0 + MOSAIC_TILE] = expected[:, :, s, v].astype(np.uint16)
        ds.PixelData = np.ascontiguousarray(frame).astype("<u2").tobytes()
        ds.save_as(str(path), write_like_original=False)

    return series, expected


# ----------------------------------------------------------------------------
# NIfTI and MGZ phantoms (for the JS readers; validated against nibabel)
# ----------------------------------------------------------------------------
NIFTI_AFFINE = np.array([
    [2.0, 0.0, 0.0, -10.0],
    [0.0, 2.0, 0.0, -8.0],
    [0.0, 0.0, 2.5, -6.0],
    [0.0, 0.0, 0.0, 1.0],
], dtype=np.float64)


def nifti_gray_data():
    x, y, z = 8, 6, 5
    d = np.zeros((x, y, z), dtype=np.int16)
    for i in range(x):
        for j in range(y):
            for k in range(z):
                d[i, j, k] = i * 41 + j * 13 + k * 7
    return d


def write_nifti_gray(out_nii, out_niigz):
    data = nifti_gray_data()
    img = nib.Nifti1Image(data, NIFTI_AFFINE)
    img.header.set_slope_inter(1, 0)
    nib.save(img, str(out_nii))
    nib.save(img, str(out_niigz))
    return data


def write_nifti_rgb(out_nii):
    x, y, z = 8, 6, 5
    rgb_dtype = np.dtype([("R", "u1"), ("G", "u1"), ("B", "u1")])
    arr = np.zeros((x, y, z), dtype=rgb_dtype)
    plain = np.zeros((x, y, z, 3), dtype=np.uint8)
    for i in range(x):
        for j in range(y):
            for k in range(z):
                r, g, b = (i * 20) % 256, (j * 25) % 256, (k * 40 + i) % 256
                arr[i, j, k] = (r, g, b)
                plain[i, j, k] = (r, g, b)
    img = nib.Nifti1Image(arr, NIFTI_AFFINE)
    nib.save(img, str(out_nii))
    return plain


def write_mgz(out_mgz):
    x, y, z = 8, 6, 5
    data = np.zeros((x, y, z), dtype=np.float32)
    for i in range(x):
        for j in range(y):
            for k in range(z):
                data[i, j, k] = float(i * 3 + j * 2 + k)
    img = nib.MGHImage(data, NIFTI_AFFINE)
    nib.save(img, str(out_mgz))
    return data


def dump_bin(name, arr):
    arr = np.ascontiguousarray(arr)
    (GOLDEN / f"{name}.bin").write_bytes(arr.tobytes())
    return {"name": name, "dtype": str(arr.dtype), "shape": list(arr.shape)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    GOLDEN.mkdir(parents=True, exist_ok=True)

    vol = gray_volume()
    single_series = write_dicom_single(vol, OUT / "dicom_single")
    mf_series = write_dicom_multiframe(vol, OUT / "dicom_mf")
    write_dicom_nogeo(OUT / "dicom_nogeo")

    rgb = rgb_volume()
    rgb_series = write_dicom_rgb(rgb, OUT / "dicom_rgb")

    mosaic_series, mosaic_exp = write_dicom_mosaic(OUT / "dicom_mosaic")

    nii_data = write_nifti_gray(OUT / "nifti_gray.nii", OUT / "nifti_gray.nii.gz")
    nii_rgb = write_nifti_rgb(OUT / "nifti_rgb.nii")
    mgz_data = write_mgz(OUT / "vol.mgz")

    # Reader goldens: what the JS readers must reproduce.
    readers = {
        "nifti_gray": {
            "array": dump_bin("reader_nifti_gray", nii_data),
            "affine": NIFTI_AFFINE.tolist(),
        },
        "nifti_rgb": {
            "array": dump_bin("reader_nifti_rgb", nii_rgb),
            "affine": NIFTI_AFFINE.tolist(),
        },
        "mgz": {
            "array": dump_bin("reader_mgz", mgz_data),
            "affine": nib.load(str(OUT / "vol.mgz")).affine.tolist(),
        },
        "dicom_rgb": {
            "array": dump_bin("reader_dicom_rgb", rgb),
            "note": "stacked (H,W,N,3) in spatial slice order 0..N-1",
        },
        "dicom_mosaic": {
            "first": dump_bin("reader_mosaic_first", mosaic_exp[:, :, :, 0]),
            "mean": dump_bin("reader_mosaic_mean", mosaic_exp.mean(axis=3)),
            "max": dump_bin("reader_mosaic_max", mosaic_exp.max(axis=3)),
            "slices": MOSAIC_SLICES,
            "volumes": MOSAIC_VOLUMES,
            "tile": MOSAIC_TILE,
            "note": "de-tiled (tile,tile,slices) per reduction across volumes",
        },
    }
    (GOLDEN / "readers.json").write_text(json.dumps(readers, indent=2))

    manifest = {
        "dims": {"H": H, "W": W, "N": N},
        "series": {
            "single": single_series,
            "multiframe": mf_series,
            "rgb": rgb_series,
            "mosaic": mosaic_series,
        },
        "paths": {
            "dicom_single": "phantom_out/dicom_single",
            "dicom_mf": "phantom_out/dicom_mf",
            "dicom_nogeo": "phantom_out/dicom_nogeo",
            "dicom_rgb": "phantom_out/dicom_rgb",
            "dicom_mosaic": "phantom_out/dicom_mosaic",
            "nifti_gray_nii": "phantom_out/nifti_gray.nii",
            "nifti_gray_niigz": "phantom_out/nifti_gray.nii.gz",
            "nifti_rgb": "phantom_out/nifti_rgb.nii",
            "mgz": "phantom_out/vol.mgz",
        },
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("Wrote phantoms to", OUT)
    print("Wrote reader goldens to", GOLDEN)


if __name__ == "__main__":
    main()
