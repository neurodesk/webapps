// One image per frame, for a series dcm2niix refuses because its frames share no plane, such
// as the differently oriented slices of an MPR localizer. Each frame becomes a one-slice
// NIfTI in its own place and orientation. Only uncompressed greyscale frames are read.
import { readDicomFrames } from '@neurodesk/dicom2vid/readers/dicom.js';
import { createNiftiFromData, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io/nifti';

const unit = (vector) => {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
};

// NIfTI's i runs along a DICOM row (across columns), j down the columns; LPS becomes RAS.
export function frameAffine({ ipp, iop, spacing, thickness }) {
  const across = unit(iop.slice(0, 3));
  const down = unit(iop.slice(3, 6));
  const normal = [
    across[1] * down[2] - across[2] * down[1],
    across[2] * down[0] - across[0] * down[2],
    across[0] * down[1] - across[1] * down[0],
  ];
  const [rowSpacing, columnSpacing] = spacing ?? [1, 1];
  const depth = thickness > 0 ? thickness : 1;
  const flip = [-1, -1, 1];
  return [0, 1, 2].map((axis) => [
    flip[axis] * across[axis] * columnSpacing,
    flip[axis] * down[axis] * rowSpacing,
    flip[axis] * normal[axis] * depth,
    flip[axis] * ipp[axis],
  ]);
}

export function frameNifti(frame) {
  const affine = frameAffine(frame);
  const [rowSpacing, columnSpacing] = frame.spacing ?? [1, 1];
  const header = createNiftiHeaderFromVolume({
    hdr: {
      dims: [frame.cols, frame.rows, 1],
      pixDims: [columnSpacing, rowSpacing, frame.thickness > 0 ? frame.thickness : 1],
      affine,
    },
  });
  const data = new Float32Array(frame.pixels.length);
  for (let i = 0; i < data.length; i++) data[i] = frame.pixels[i] * frame.slope + frame.intercept;
  const bytes = createNiftiFromData(data, header, { range: 'auto' });
  // The sform alone places the slice; an identity qform beside it would only mislead.
  new DataView(bytes).setInt16(252, 0, true);
  return bytes;
}

// The outputs dcm2niix would give, { image, sidecar }, one per frame of a multiframe file.
export async function frameImages(file) {
  const frames = readDicomFrames(await file.arrayBuffer(), file.name);
  if (frames.length < 2) throw new Error(`${file.name} holds a single frame.`);
  return frames.map((frame, index) => {
    if (frame.isColor || !frame.ipp || !frame.iop) throw new Error(`${file.name}: frame ${index + 1} has no greyscale plane to show.`);
    return { image: new File([frameNifti(frame)], `frame${index + 1}.nii`, { type: 'application/octet-stream' }), sidecar: null };
  });
}
