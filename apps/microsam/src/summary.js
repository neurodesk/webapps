// A compact record of an image embedding for provenance and the parity test: its mean, standard
// deviation and every `stride`-th value (validation/reference.py samples the same positions).
export const EMBEDDING_SAMPLES = 512;

export function embeddingSummary(embedding) {
  let sum = 0;
  for (let i = 0; i < embedding.length; i++) sum += embedding[i];
  const mean = sum / embedding.length;
  let squares = 0;
  for (let i = 0; i < embedding.length; i++) squares += (embedding[i] - mean) ** 2;
  const stride = Math.floor(embedding.length / EMBEDDING_SAMPLES);
  const samples = Array.from({ length: EMBEDDING_SAMPLES }, (_, i) => embedding[i * stride]);
  return { length: embedding.length, mean, std: Math.sqrt(squares / embedding.length), stride, samples };
}
