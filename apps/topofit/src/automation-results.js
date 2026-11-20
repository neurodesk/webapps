export function automationArtifacts(files) {
  return files.map(({ id, name, mediaType, bytes }) => {
    const role = mediaType === 'application/vnd.freesurfer.surface' ? id.endsWith('-registration') ? 'registration' : 'surface'
      : mediaType === 'application/nifti' ? id === 'region-mask' ? 'region-mask' : 'qc'
        : mediaType === 'text/csv' ? 'table'
          : mediaType === 'application/json' ? 'metadata'
            : mediaType === 'application/vnd.freesurfer.annotation' ? 'parcellation' : null;
    if (!role) throw new Error(`Unsupported TopoFit result format: ${mediaType}`);
    return { id: id.toLowerCase(), role, file: new File([bytes], name, { type: mediaType }) };
  });
}
