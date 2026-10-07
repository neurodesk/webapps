// What the Disconnectome web app and the disconnectome command line must agree on: the table's
// row id and file name, and how a lesion off the atlas grid is refused.

/** The TSV row id: the lesion's file name without its NIfTI extension. */
export function lesionId(name) {
  return name.replace(/\.nii(\.gz)?$/i, '');
}

/** The atlas is in the name: the two atlases produce different tables for the same lesion. */
export function tableName(id, atlasId) {
  return `${id}_${atlasId}_disconnectome.tsv`;
}

/** The C core names the mismatch (grid, dim or sto_xyz) in the reason it prints. */
export function isGridMismatch(error) {
  return /grid|dim|sto_xyz/i.test(error.message);
}

export function gridAdvice(grid) {
  return `Not on the ${grid.dim.join(' × ')} MNI152 grid; normalize it with SYNcro first.`;
}
