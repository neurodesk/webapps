export const RESULT_STAGE_DISPLAY = Object.freeze({
  downsample: Object.freeze({
    kind: 'image',
    colormap: 'gray',
    defaultVisible: true,
    baseOpacity: 1,
    overlayOpacity: 0.45,
    scalar: true
  }),
  n4: Object.freeze({
    kind: 'image',
    colormap: 'gray',
    defaultVisible: true,
    baseOpacity: 1,
    overlayOpacity: 0.45,
    scalar: true
  }),
  nlm: Object.freeze({
    kind: 'image',
    colormap: 'gray',
    defaultVisible: true,
    baseOpacity: 1,
    overlayOpacity: 0.45,
    scalar: true
  }),
  bet: Object.freeze({
    kind: 'image',
    colormap: 'gray',
    defaultVisible: true,
    baseOpacity: 1,
    overlayOpacity: 0.45,
    scalar: true
  }),
  segmentation: Object.freeze({
    kind: 'mask',
    colormap: 'vesselboost',
    defaultVisible: true,
    opacity: 'segmentationOpacity',
    scalar: false
  }),
  brainmask: Object.freeze({
    kind: 'mask',
    colormap: 'blue',
    defaultVisible: false,
    opacity: 0.35,
    scalar: false
  })
});

export const IMAGE_RESULT_STAGES = Object.freeze(
  Object.keys(RESULT_STAGE_DISPLAY).filter(stage => RESULT_STAGE_DISPLAY[stage].kind === 'image')
);

export const MASK_RESULT_STAGES = Object.freeze(
  Object.keys(RESULT_STAGE_DISPLAY).filter(stage => RESULT_STAGE_DISPLAY[stage].kind === 'mask')
);

export function getResultDisplay(stage) {
  return RESULT_STAGE_DISPLAY[stage] || null;
}

export function isImageResultStage(stage) {
  return getResultDisplay(stage)?.kind === 'image';
}

export function isMaskResultStage(stage) {
  return getResultDisplay(stage)?.kind === 'mask';
}

export function defaultResultVisibility(stage) {
  return getResultDisplay(stage)?.defaultVisible === true;
}

export function isResultStageVisible(stage, visibility = {}) {
  if (Object.prototype.hasOwnProperty.call(visibility, stage)) {
    return visibility[stage] === true;
  }
  return defaultResultVisibility(stage);
}

function stageFile(results, stage) {
  return results?.[stage]?.file || null;
}

function opacityForStage(display, segmentationOpacity) {
  if (display.opacity === 'segmentationOpacity') return segmentationOpacity;
  return display.opacity ?? display.overlayOpacity ?? display.baseOpacity ?? 0.5;
}

export function chooseResultBaseStage({ stages = [], results = {}, visibility = {}, preferredBaseStage = null } = {}) {
  const visibleImages = stages.filter(stage =>
    isImageResultStage(stage) &&
    stageFile(results, stage) &&
    isResultStageVisible(stage, visibility)
  );

  if (preferredBaseStage && visibleImages.includes(preferredBaseStage)) {
    return { stage: preferredBaseStage, visible: true };
  }
  if (visibleImages.length) {
    return { stage: visibleImages.at(-1), visible: true };
  }

  const availableImages = stages.filter(stage => isImageResultStage(stage) && stageFile(results, stage));
  if (preferredBaseStage && availableImages.includes(preferredBaseStage)) {
    return { stage: preferredBaseStage, visible: false };
  }
  if (availableImages.length) {
    return { stage: availableImages.at(-1), visible: false };
  }

  return { stage: null, visible: false };
}

export function buildResultVolumeStack({
  stages = [],
  results = {},
  visibility = {},
  preferredBaseStage = null,
  segmentationOpacity = 0.5
} = {}) {
  const availableStages = stages.filter(stage => getResultDisplay(stage) && stageFile(results, stage));
  const visibleStages = availableStages.filter(stage => isResultStageVisible(stage, visibility));
  if (!visibleStages.length) return [];

  const { stage: baseStage, visible: baseVisible } = chooseResultBaseStage({
    stages: availableStages,
    results,
    visibility,
    preferredBaseStage
  });

  if (!baseStage) {
    const maskStage = visibleStages.find(isMaskResultStage);
    const display = getResultDisplay(maskStage);
    return maskStage ? [{
      file: stageFile(results, maskStage),
      stage: maskStage,
      colormap: display.colormap,
      opacity: opacityForStage(display, segmentationOpacity),
      visible: true,
      labelMask: true,
      scalar: display.scalar
    }] : [];
  }

  const baseDisplay = getResultDisplay(baseStage);
  const entries = [{
    file: stageFile(results, baseStage),
    stage: baseStage,
    colormap: baseDisplay.colormap,
    opacity: baseVisible ? baseDisplay.baseOpacity : 0,
    visible: baseVisible,
    scalar: baseDisplay.scalar
  }];

  for (const stage of visibleStages) {
    if (stage === baseStage) continue;
    const display = getResultDisplay(stage);
    entries.push({
      file: stageFile(results, stage),
      stage,
      colormap: display.colormap,
      opacity: isImageResultStage(stage)
        ? (display.overlayOpacity ?? 0.45)
        : opacityForStage(display, segmentationOpacity),
      visible: true,
      scalar: display.scalar,
      labelMask: false
    });
  }

  return entries;
}
