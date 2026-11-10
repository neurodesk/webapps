/** In-place 1D complex FFT of `re`/`im` (any length). The inverse is unscaled. */
export function fft1d(re: Float64Array, im: Float64Array, inverse?: boolean): void;

/** The smallest power of two that is at least `n`. */
export function nextPowerOfTwo(n: number): number;

/**
 * In-place n-dimensional complex FFT of an array of `shape`, first axis fastest
 * ([width, height] for a row-major image). Any lengths; the inverse is unscaled.
 */
export function fftn(re: Float64Array, im: Float64Array, shape: readonly number[], inverse?: boolean): void;
