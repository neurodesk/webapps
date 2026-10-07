// The registered image's download name, shared by the web app and the command line.
export function registeredFileName(movingName) {
  return `${movingName.replace(/\.nii(\.gz)?$/i, '')}_registered.nii.gz`;
}
