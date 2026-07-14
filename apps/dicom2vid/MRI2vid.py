## TBS 20230606
## take a dicom folder and make into an MP4 (AVI doesn't work b/c codec issues)


import os
import argparse
import pydicom
import numpy as np
import cv2


class Slice:
    """
    Simple container for a single slice of a DICOM volume
    """
    def __init__(self, **kwargs):
        """
        Accepts any keyword arguments and sets them as attributes on
        the instance, but only for those that are not None.
        """
        for k, v in kwargs.items():
            if v is not None:
                setattr(self, k, v)


def convert_to_2d(dcm):
    """
    Convert 3D DICOM to a list of 2D slices, preserving metadata for each slice if available
    """
    pixel_array = dcm.pixel_array
    if pixel_array.ndim == 2:
        raise ValueError("DICOM pixel array is already 2D.")

    # Determine which axis corresponds to the slices to iterate over.
    n_slices = dcm.NumberOfFrames
    shape = pixel_array.shape
    if np.nansum([n_slices == dim for dim in shape]) != 1:
        raise ValueError(f"Cannot determine slice axis from pixel array shape. Number of frames: {n_slices}, pixel array shape: {shape}")
    axis = shape.index(n_slices)

    if hasattr(dcm, "PerFrameFunctionalGroupsSequence"):
        slice_iterator = dcm.PerFrameFunctionalGroupsSequence
    else:
        # If no PerFrameFunctionalGroupsSequence is present, iterate
        # over the slices using the shape of the `pixel_array` and use
        # default values for the metadata.
        slice_iterator = range(pixel_array.shape[axis])

    datasets = []
    for slice_idx, slice in enumerate(slice_iterator):
        pps = getattr(slice, "PlanePositionSequence", [None])
        image_position = getattr(pps[0], "ImagePositionPatient", None)

        pos = getattr(slice, "PlaneOrientationSequence", [None])
        image_orientation = getattr(pos[0], "ImageOrientationPatient", None)

        fcs = getattr(slice, "FrameContentSequence", [None])
        instance_number = getattr(fcs[0], "InstanceNumber", slice_idx)

        pvts = getattr(slice, "PixelValueTransformationSequence", [None])
        rescale_slope = getattr(pvts[0], "RescaleSlope", 1.0)
        rescale_intercept = getattr(pvts[0], "RescaleIntercept", 0.0)

        # The items in the PerFrameFunctionalGroupsSequence do not have
        # `PixelData` or `pixel_array` that are accessible.
        current_data = pixel_array.take(indices=slice_idx, axis=axis)

        current_slice = Slice(
            pixel_array=current_data,
            RescaleSlope=rescale_slope,
            RescaleIntercept=rescale_intercept,
            ImagePositionPatient=image_position,
            ImageOrientationPatient=image_orientation,
            InstanceNumber=instance_number
        )

        datasets.append(current_slice)

    return datasets


def load_and_sort_dicoms(folder_path):
    if not os.path.isdir(folder_path):
        raise FileNotFoundError(f"Folder not found: {folder_path}")

    valid_exts = {".dcm", ".ima"}
    dicom_paths = [
        os.path.join(folder_path, name)
        for name in os.listdir(folder_path)
        if os.path.splitext(name)[-1].lower() in valid_exts
    ]

    if not dicom_paths:
        raise RuntimeError("No DICOM files with extensions .dcm or .ima found")

    datasets = []
    for path in sorted(dicom_paths):
        try:
            ds = pydicom.dcmread(path)
            # Access pixel_array once so decompression errors surface early
            _ = ds.pixel_array
            datasets.append(ds)
        except Exception as exc:
            print(f"Skipping {path}: {exc}")

    if not datasets:
        raise RuntimeError("No readable DICOMs found")

    # Handle 3D DICOMs. If there are multiple 3D DICOMs they cannot be
    # processed as one.
    if any(ds.pixel_array.ndim == 3 for ds in datasets):
        if len(datasets) > 1:
            raise TypeError("Multiple DICOMs contain 3D pixel data")

        datasets = convert_to_2d(datasets[0])

    first = datasets[0]

    if hasattr(first, "ImagePositionPatient") and hasattr(first, "ImageOrientationPatient"):
        iop = np.array(first.ImageOrientationPatient, dtype=float)
        row_cos = iop[:3]
        col_cos = iop[3:]
        normal = np.cross(row_cos, col_cos)

        def spatial_key(ds):
            position = np.array(ds.ImagePositionPatient, dtype=float)
            return float(np.dot(position, normal))

        datasets.sort(key=spatial_key)
    elif hasattr(first, "ImagePositionPatient"):
        datasets.sort(key=lambda ds: float(ds.ImagePositionPatient[2]))
    elif hasattr(first, "InstanceNumber"):
        datasets.sort(key=lambda ds: int(ds.InstanceNumber))
    else:
        datasets.sort(key=lambda ds: os.path.basename(ds.filename))

    return datasets


def get_orientation_slice(view, volume):
    orientation = view.lower()

    if orientation == "sagittal":
        return np.transpose(volume, (2, 0, 1))
    if orientation == "coronal":
        return np.moveaxis(volume, 1, 0)
    if orientation == "axial":
        return volume
    if orientation == "sagittal_flipped":
        return np.flip(np.transpose(volume, (2, 0, 1)), axis=1)
    if orientation == "coronal_flipped":
        return np.flip(np.moveaxis(volume, 1, 0), axis=1)
    if orientation == "axial_flipped":
        return np.flip(volume, axis=1)

    raise ValueError(f"Unknown orientation: {view}")


def process_dicom_files(
    folder_path,
    output_file,
    orientation,
    fps,
    start_slice,
    end_slice,
    slice_step,
    annotate_slices,
):
    datasets = load_and_sort_dicoms(folder_path)

    base_array = datasets[0].pixel_array
    base_shape = base_array.shape

    frames = []
    for idx, ds in enumerate(datasets):
        array = ds.pixel_array
        if array.shape != base_shape:
            raise ValueError(
                f"Slice {idx} shape {array.shape} does not match first slice {base_shape}"
            )

        slope = getattr(ds, "RescaleSlope", 1.0)
        intercept = getattr(ds, "RescaleIntercept", 0.0)

        try:
            slope = float(slope)
        except (TypeError, ValueError):
            slope = 1.0

        try:
            intercept = float(intercept)
        except (TypeError, ValueError):
            intercept = 0.0

        frames.append(array.astype(np.float32) * slope + intercept)

    volume = np.stack(frames, axis=-1)

    volume = cv2.normalize(volume, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)

    oriented_full = get_orientation_slice(orientation, volume)
    if oriented_full.ndim != 3:
        raise ValueError("Unexpected orientation result; expected 3D array")

    total_slices = oriented_full.shape[0]

    if slice_step == 0:
        raise ValueError("slice_step must be non-zero")
    if slice_step < 0:
        raise ValueError("slice_step must be positive")

    def resolve_index(value, default):
        if value is None:
            return default
        if value < 0:
            value += total_slices
        return value

    start_idx = resolve_index(start_slice, 0)
    end_idx = resolve_index(end_slice, total_slices)

    if not 0 <= start_idx < total_slices:
        raise ValueError(f"start_slice {start_slice} resolves outside available range")
    if end_idx < 0:
        raise ValueError(f"end_slice {end_slice} resolves outside available range")
    end_idx = min(end_idx, total_slices)
    if start_idx >= end_idx:
        raise ValueError("start_slice must point to a slice before end_slice")

    slice_indices = list(range(start_idx, end_idx, slice_step))
    if not slice_indices:
        raise ValueError("Slice selection produced no frames; adjust start/end/step")

    oriented = oriented_full[slice_indices]

    height, width_px = oriented.shape[1], oriented.shape[2]

    codec = cv2.VideoWriter_fourcc(*"mp4v")
    output_dir = os.path.dirname(os.path.abspath(output_file))
    if output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    writer = cv2.VideoWriter(output_file, codec, fps, (width_px, height), isColor=False)
    if not writer.isOpened():
        raise RuntimeError(f"Could not open video writer for {output_file}")

    try:
        for frame_idx, slice_idx in enumerate(slice_indices):
            frame = oriented[frame_idx]
            if annotate_slices:
                annotated = frame.copy()
                label = f"Slice {slice_idx + 1}/{total_slices}"
                cv2.putText(
                    annotated,
                    label,
                    (10, height - 10),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    255,
                    1,
                    cv2.LINE_AA,
                )
                frame_to_write = annotated
            else:
                frame_to_write = frame

            writer.write(np.ascontiguousarray(frame_to_write))
    finally:
        writer.release()


def main():
    parser = argparse.ArgumentParser(description="Convert a stack of DICOM images into a grayscale MP4")
    parser.add_argument("--folder", required=True, help="Directory containing DICOM files")
    parser.add_argument("--output", required=True, help="Output video file path")
    parser.add_argument(
        "--orientation",
        choices=[
            "sagittal",
            "coronal",
            "axial",
            "sagittal_flipped",
            "coronal_flipped",
            "axial_flipped",
        ],
        default="sagittal",
        help="Orientation of the output video",
    )
    parser.add_argument("--fps", type=float, default=20.0, help="Frames per second for the output video")
    parser.add_argument(
        "--start-slice",
        type=int,
        help="First slice index (0-based) to include; negative values index from the end",
    )
    parser.add_argument(
        "--end-slice",
        type=int,
        help="Slice index at which to stop (exclusive); negative values index from the end",
    )
    parser.add_argument(
        "--slice-step",
        type=int,
        default=1,
        help="Step between slices; use values >1 to subsample through the stack",
    )
    parser.add_argument(
        "--annotate-slices",
        action="store_true",
        help="Overlay slice numbering onto each frame",
    )

    args = parser.parse_args()

    process_dicom_files(
        args.folder,
        args.output,
        args.orientation,
        args.fps,
        args.start_slice,
        args.end_slice,
        args.slice_step,
        args.annotate_slices,
    )


if __name__ == "__main__":
    main()
