// DOM-free helpers for the loaded stacks: header inspection, thickness
// defaults and mask assignment.
import { decodeNiftiBuffer, isValidNifti1, parseNiftiHeader } from '@neurodesk/webapp-components/file-io';

const NIFTI_NAME = /\.nii(\.gz)?$/i;

export function stem(name) {
  return String(name).replace(NIFTI_NAME, '');
}

export function isNiftiName(name) {
  return NIFTI_NAME.test(String(name));
}

/** Read what the stack table shows: dimensions, spacing and the default thickness. */
export async function describeStack(file) {
  const head = await file.slice(0, 4096).arrayBuffer();
  let header;
  try {
    header = await decodeNiftiBuffer(head);
  } catch {
    // Slicing a gzip stream truncates it; decode the whole file when the head is not enough.
    header = await decodeNiftiBuffer(await file.arrayBuffer());
  }
  if (!isValidNifti1(header)) throw new Error(`${file.name} is not a NIfTI-1 image`);
  const parsed = parseNiftiHeader(header.slice(0, 352));
  const spacing = parsed.voxelSize.map(value => Math.abs(value));
  return {
    name: file.name,
    dims: [parsed.nx, parsed.ny, parsed.nz],
    spacing,
    thickness: defaultThickness(spacing),
    slices: parsed.nz,
  };
}

/** NeSVoR falls back to the slice gap when no thickness is given; so does the table. */
export function defaultThickness(spacing) {
  const value = Number(spacing?.[2]);
  if (!Number.isFinite(value) || value <= 0) return 3;
  return Math.round(value * 100) / 100;
}

/**
 * Pair masks with stacks. When the counts match, masks follow the stack order;
 * otherwise a mask whose name starts with a stack's name (plus `_mask`, `-mask`
 * or `mask`) is assigned to that stack. Returns a stack index per mask, or -1.
 */
export function matchMasks(stackNames, maskNames) {
  if (maskNames.length === stackNames.length) return maskNames.map((_, index) => index);
  const stems = stackNames.map(name => stem(name).toLowerCase());
  return maskNames.map(maskName => {
    const maskStem = stem(maskName).toLowerCase();
    let best = -1;
    let bestLength = 0;
    stems.forEach((stackStem, index) => {
      if (!maskStem.startsWith(stackStem) || stackStem.length <= bestLength) return;
      const suffix = maskStem.slice(stackStem.length);
      if (/^([_-]?mask)?$/i.test(suffix) || /mask/i.test(suffix)) {
        best = index;
        bestLength = stackStem.length;
      }
    });
    return best;
  });
}

export function formatDims(dims) {
  return dims.map(value => value || 1).join(' × ');
}

export function formatSpacing(spacing) {
  return spacing.map(value => (Math.round(value * 100) / 100).toString()).join(' × ');
}

/** The multipart parts and spec stacks for the loaded table rows. */
export function assembleJob(rows, options) {
  const files = {};
  const stacks = rows.map((row, index) => {
    const name = `stack-${index}`;
    files[name] = row.file;
    const entry = { file: name, thickness: row.thickness };
    if (row.mask) {
      const maskName = `mask-${index}`;
      files[maskName] = row.mask;
      entry.mask = maskName;
    }
    return entry;
  });
  const complete = stacks.length > 0 && stacks.every(stack => stack.mask);
  if (!complete) {
    for (const stack of stacks) {
      if (stack.mask) delete files[stack.mask];
      delete stack.mask;
    }
  }
  return { spec: { tool: 'nesvor', command: 'reconstruct', stacks, options }, files, masksUsed: complete };
}
