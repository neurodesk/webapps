// Voxel value checks for apps that pass an image to a method that cannot use NaN, infinite or
// constant values, so such an input is refused at load with a message, not after a long run.

/**
 * The range of `data`; throws when a value is not finite, or (unless `allowConstant`) when
 * every value is the same. `subject` names the image at the start of the message.
 * @param {ArrayLike<number>} data
 * @param {{ subject?: string, allowConstant?: boolean }} [options]
 * @returns {{ min: number, max: number }}
 */
export function assertImageValues(data, { subject = 'The image', allowConstant = false } = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (!Number.isFinite(value)) {
      throw new Error(`${subject} holds values that are not finite numbers (NaN or infinity).`);
    }
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!data.length) throw new Error(`${subject} holds no voxels.`);
  if (!allowConstant && min === max) throw new Error(`${subject} has the same value (${min}) in every voxel.`);
  return { min, max };
}
