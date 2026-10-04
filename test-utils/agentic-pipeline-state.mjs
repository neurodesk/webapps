/** @param {string} app @param {{text: string, value: number | null, max: number}} status */
export function pipelineSettled(app, status) {
  if (/\b(error|failed|unable)\b/i.test(status.text)) return true;
  if (app === 'calmar') return /^(Complete|Threshold projection complete|Review and confirm the lesion mask)$/.test(status.text.trim());
  if (app === 'dwi2trx') return status.value !== null;
  return status.value !== null && status.value >= status.max;
}
