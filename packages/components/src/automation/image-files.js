/** Pair explicit automation sidecars with their image, independently of source filenames. */
export function imageFiles(inputs, inputDetails = {}, {
  image = 'image', sidecar = 'sidecar', bval = 'bval', bvec = 'bvec', name,
} = {}) {
  const images = inputs[image] ?? [];
  const explicit = [[sidecar, 'json'], [bval, 'bval'], [bvec, 'bvec']]
    .flatMap(([role, extension]) => (inputs[role] ?? []).map(file => ({ file, extension })));
  if (explicit.length && images.length !== 1) {
    throw new Error(`${image}: explicit sidecars require exactly one image`);
  }
  if (name && images.length > 1) throw new Error(`${image}: expected one image`);
  const renamed = images.map(file => name ? new File([file], name, { type: file.type, lastModified: file.lastModified }) : file);
  const imageStem = renamed[0]?.name.replace(/\.nii(?:\.gz)?$/i, '');
  const overridden = new Set(explicit.map(entry => entry.extension));
  const inherited = (inputDetails[image]?.sidecars ?? []).filter(file => {
    const extension = file.name.split('.').pop().toLowerCase().replace(/^bvals$/, 'bval').replace(/^bvecs$/, 'bvec');
    return !overridden.has(extension);
  });
  const auxiliary = images.length === 1
    ? inherited.map(file => ({ file, extension: file.name.split('.').pop() }))
    : [];
  const sidecars = [...auxiliary, ...explicit].map(({ file, extension }) => new File([file], `${imageStem}.${extension}`, { type: file.type, lastModified: file.lastModified }));
  return [...renamed, ...(images.length === 1 ? sidecars : inherited)];
}
