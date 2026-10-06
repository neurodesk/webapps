// The files a run produces, shared by the web downloads and the command line so both name and
// describe their results the same way. Keys are the automation artifact roles in automation.json.

// Unit codes the WASM core takes for a measured B1 map.
export const B1_MAP_KINDS = Object.freeze({ tfl: 0, percent: 1, relative: 2 });

export function outputFiles(task, mode) {
  if (task === 'denoise') return [['unic', 'UNI_denoised.nii.gz']];
  const b1 = mode === 'sa2rage' ? 'B1map_from_SA2RAGE.nii.gz' : 'B1map.nii.gz';
  if (task === 'b1only') return [['b1', b1]];
  return [
    ['t1', 'T1map.nii.gz'],
    ['b1', b1],
    ['t1u', 'T1map_uncorrected.nii.gz'],
    ['unic', 'UNI_b1corrected.nii.gz'],
  ];
}

// Every setting that changes a result is recorded, so parameters.json reproduces the run.
export function parametersRecord({
  software,
  note,
  task,
  mode,
  mp2rage,
  sa2rage,
  b1MapType,
  referenceAngle,
  extendFov,
  fallbackUncorrected,
  maskSource,
  regularization,
}) {
  const denoise = task === 'denoise';
  const b1map = !denoise && mode === 'b1map';
  return {
    software,
    task,
    mode: denoise ? undefined : mode,
    mp2rage: denoise ? undefined : mp2rage,
    sa2rage: !denoise && mode === 'sa2rage' ? sa2rage : undefined,
    b1_map_type: b1map ? b1MapType : undefined,
    b1_reference_angle_deg: b1map && b1MapType === 'tfl' ? referenceAngle : undefined,
    extend_fov: b1map ? extendFov : undefined,
    fallback_uncorrected: task === 't1' ? fallbackUncorrected : undefined,
    mask_source: denoise ? undefined : maskSource,
    regularization: denoise ? regularization : undefined,
    note,
  };
}
