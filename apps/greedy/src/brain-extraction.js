import { segment } from "@brainchop/mindgrab";

export function strippedName(name) {
  return name.replace(/(\.nii)?(\.gz)?$/i, "_brain$1$2");
}

export async function extractBrain({ file, assetPath, onLog = () => {}, segmenter = segment }) {
  if (!file) throw new Error("Choose an image to brain extract.");
  const result = await segmenter(await file.arrayBuffer(), {
    model: "mindgrab",
    worker: true,
    backend: "auto",
    assetPath,
    timeoutMs: 300_000,
    onLog,
  });
  if (!result.image) throw new Error("MindGrab did not return a brain-extracted image.");
  return {
    ...result,
    file: new File([result.image], strippedName(file.name)),
  };
}
