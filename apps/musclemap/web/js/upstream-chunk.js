// Nibabel 5.2.1 shared_range(float32, integer) used by MuscleMap temporary chunks.
const integerRanges = new Map([
  [2, [0, 255]],
  [4, [-32768, 32767]],
  [8, [-2147483648, 2147483520]],
  [256, [-128, 127]],
  [512, [0, 65535]],
  [768, [0, 4294967040]]
]);

function roundEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Match _write_temp_chunk: copied source dtype, automatic scaling, then float32 reload.
export function roundtripTemporaryChunk(data, datatype) {
  const range = integerRanges.get(datatype);
  if (!range) return data;
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === 0 && max === 0) return new Float32Array(data.length);
  const [outMin, outMax] = range;
  let slope = min === max ? 1 : (max - min) / (outMax - outMin);
  let intercept = min === max ? min : min - outMin * slope;
  if (outMin === 0 && Math.abs(max) < Math.abs(min) && min !== max) {
    intercept = max;
    slope = -slope;
  }
  slope = Math.fround(slope);
  intercept = Math.fround(intercept);
  if (slope === 0) throw new Error('Temporary NIfTI chunk scaling slope cannot be zero');
  const writeFloat = [min, max].every(value =>
    Number.isFinite(Math.fround(Math.fround(value - intercept) / slope))
  );
  const subtract = writeFloat ? value => Math.fround(value - intercept) : value => value - intercept;
  const divide = writeFloat ? value => Math.fround(value / slope) : value => value / slope;
  const readFloat = datatype !== 8 && datatype !== 768 && [outMin, outMax].every(value =>
    Number.isFinite(Math.fround(Math.fround(value * slope) + intercept))
  );
  const output = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const encoded = Math.max(outMin, Math.min(outMax, roundEven(divide(subtract(data[i])))));
    const scaled = slope === 1 ? encoded : readFloat ? Math.fround(encoded * slope) : encoded * slope;
    output[i] = intercept === 0 ? scaled : scaled + intercept;
  }
  return output;
}
