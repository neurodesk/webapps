import { inferenceModelsList } from '../vendor/brainchop/brainchop-parameters.js';

export const REVISION = '4c87885f3a2a8835e260d521dcec922b58d91d41';
export const MODEL_ROOT = `https://raw.githubusercontent.com/neuroneural/brainchop/${REVISION}/public`;
const choices = [
  ['tissue-light', 'Tissue GWM (light)', 'model5_gw_ae'],
  ['tissue', 'Tissue GWM (high accuracy)', 'model20chan3cls'],
  ['subcortical', 'Subcortical + GWM', 'model30chan18cls'],
  ['subcortical-small', 'Subcortical + GWM (small model)', 'model18cls'],
  ['aparc50', 'Aparc+Aseg 50', 'model30chan50cls'],
  ['aparc104', 'Aparc+Aseg 104', 'model21_104class'],
];
export const MODELS = choices.map(([id, label, directory]) => {
  const variants = inferenceModelsList.filter(model => model.path === `/models/${directory}/model.json` && ['Segmentation', 'Atlas'].includes(model.type));
  const entry = id.startsWith('aparc') ? variants.find(model => model.enableSeqConv) : variants[0];
  return { id, label, entry: entry ?? variants[0] };
});
