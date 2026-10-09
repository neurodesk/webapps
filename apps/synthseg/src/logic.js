// DOM-independent helpers, unit-tested under Node (see test/logic.test.js).
// Naming and CT detection come from the package so the synthseg command line makes the same decisions.
export { looksLikeCt, outputStem } from '@neurodesk/synthseg/results';

export const gridOf = ({ dims, header }) => ({ dims, affine: header.affine });

// The mask editor paints on the viewed image's voxels, so the input can be the edit base only on the labels' own grid.
export const sameGrid = (a, b, tolerance = 1e-4) =>
  a.dims.every((size, axis) => size === b.dims[axis])
  && a.affine.every((row, r) => Array.from(row).every((value, c) => Math.abs(value - b.affine[r][c]) <= tolerance));

export const labelNames = (lut) =>
  Object.fromEntries(lut.I.map((value, index) => [value, lut.labels[index]]).filter(([value]) => value > 0));

export const labelsResult = (file, grid) => ({ description: 'FreeSurfer labels', editable: true, file, grid });

export const editedResult = (result, file) => ({ ...result, file, original: result.original ?? result.file, edited: true });
