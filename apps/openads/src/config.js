export const APP = {
  id: 'openads',
  title: 'OpenADS',
};

export const ROLES = [
  { role: 'dwi', label: 'DWI', name: 'Diffusion-weighted MRI (DWI)' },
  { role: 'adc', label: 'ADC', name: 'Apparent Diffusion Coefficient (ADC)' },
  { role: 'b0', label: 'b0', name: 'b0 diffusion image' },
  { role: 'pwi', label: 'PWI (4D)', name: '4D Perfusion-weighted MRI (PWI)' },
  { role: 'pwi-json', label: 'PWI JSON', name: 'PWI BIDS JSON sidecar' },
  { role: 'mask', label: 'MNI lesion mask', name: 'Pre-registered MNI152 stroke mask' },
  { role: 'brainmask', label: 'MNI brain mask', name: 'Pre-registered MNI152 brain mask' },
];

function stripExtension(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.nii\.gz$|\.nii$|\.json$/i, '');
}

export function classifyFileName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.json')) {
    if (
      /(^|[_\-.])(pwi|dsc|perf|perfusion|ttp)([_\-.]|$)/.test(lower)
      && !/(^|[_\-.])(dwi|adc|b0|bzero|trace|t1w?|t2w?|flair|mask)([_\-.]|$)/.test(lower)
    ) {
      return 'pwi-json';
    }
    return null;
  }
  if (/(^|[_\-.])(brain[-_]?mask|dwibrain[-_]?mask|pwibrain[-_]?mask)([_\-.]|$)/.test(lower)) {
    return 'brainmask';
  }
  if (/(^|[_\-.])(stroke|lesion|hp[-_]?mask|infarct)([_\-.]|$)/.test(lower)) {
    return 'mask';
  }
  if (/(^|[_\-.])(pwi|dsc|perf)([_\-.]|$)/.test(lower)) {
    return 'pwi';
  }
  if (/(^|[_\-.])(adc)([_\-.]|$)/.test(lower)) {
    return 'adc';
  }
  if (/(^|[_\-.])(b0|bzero)([_\-.]|$)/.test(lower)) {
    return 'b0';
  }
  if (/(^|[_\-.])(dwi|trace)([_\-.]|$)/.test(lower)) {
    return 'dwi';
  }
  if (/(^|[_\-.])mask([_\-.]|$)/.test(lower)) {
    return 'brainmask';
  }
  return null;
}

export function assignRoles(files, explicitRoles = {}) {
  const assigned = Object.fromEntries(ROLES.map(({ role }) => [role, null]));
  const used = new Set();
  for (const [role, index] of Object.entries(explicitRoles)) {
    if (role in assigned && Number.isInteger(index) && index >= 0 && index < files.length) {
      assigned[role] = index;
      used.add(index);
    }
  }
  files.forEach((file, index) => {
    if (used.has(index)) return;
    const role = classifyFileName(file.name);
    if (role && role !== 'pwi-json' && assigned[role] === null) {
      assigned[role] = index;
      used.add(index);
    }
  });
  if (assigned['pwi-json'] === null && assigned.pwi !== null) {
    const pwiStem = stripExtension(files[assigned.pwi].name);
    const jsonIndices = [];
    files.forEach((file, index) => {
      if (!used.has(index) && String(file.name || '').toLowerCase().endsWith('.json')) {
        jsonIndices.push(index);
      }
    });
    const exactMatches = jsonIndices.filter((index) => stripExtension(files[index].name) === pwiStem);
    if (exactMatches.length === 1) {
      assigned['pwi-json'] = exactMatches[0];
      used.add(exactMatches[0]);
    } else if (exactMatches.length === 0) {
      const pwiNamed = jsonIndices.filter((index) => classifyFileName(files[index].name) === 'pwi-json');
      if (pwiNamed.length === 1) {
        assigned['pwi-json'] = pwiNamed[0];
        used.add(pwiNamed[0]);
      }
    }
  }
  return assigned;
}

export function detectMode(assigned) {
  const hasDwi = assigned.dwi !== null;
  const hasAdcOrB0 = assigned.adc !== null || assigned.b0 !== null;
  const hasPwi = assigned.pwi !== null;
  const hasMask = assigned.mask !== null;
  if (hasDwi && hasPwi) {
    return {
      mode: 'dwi-pwi',
      ready: true,
      label: hasAdcOrB0
        ? 'Full DWI core + 4D PWI hypoperfusion + mismatch + StrokeView report'
        : '4D DWI+b0 core + 4D PWI hypoperfusion + mismatch + StrokeView report',
    };
  }
  if (hasDwi && hasAdcOrB0) {
    return {
      mode: 'dwi',
      ready: true,
      label: 'Full DWI pipeline (SynthStrip → ANTs MNI152 → DAGMNet → Report + StrokeView)',
    };
  }
  if (hasMask) {
    return {
      mode: 'mni-report',
      ready: true,
      label: 'MNI152 radiological report, ASPECTS, TreeSHAP and StrokeView cohort',
    };
  }
  if (hasDwi) {
    return {
      mode: 'dwi',
      ready: true,
      label: '4D DWI+b0 pipeline (or add an ADC/b0 scan)',
    };
  }
  return {
    mode: null,
    ready: false,
    label: 'Load DWI + b0/ADC, or an MNI152 lesion mask.',
  };
}

export function inferSubjectId(files) {
  for (const file of files) {
    const subMatch = file.name.match(/sub-[a-zA-Z0-9]+/);
    if (subMatch) return subMatch[0];
    const hexMatch = file.name.match(/^([0-9a-f]{6,12})_/i);
    if (hexMatch) return `sub-${hexMatch[1]}`;
  }
  const first = files[0]?.name || 'subject';
  return first.replace(/\.nii(\.gz)?$/i, '').replace(/\.json$/i, '') || 'subject';
}
