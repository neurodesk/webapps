import { computeOtsuThreshold, createThresholdMask } from '../volume/normalization.js';
import { dilateMask3D, erodeMask3D, fillHoles3D, robustMask } from '../volume/morphology.js';

export class MaskState {
  constructor(options = {}) {
    this.dims = options.dims || null;
    this.data = options.data || null;
    this.originalData = options.data ? new Float32Array(options.data) : null;
    this.history = [];
  }

  hasMask() {
    return this.data !== null;
  }

  setMask(data, dims = this.dims) {
    this.data = data;
    this.dims = dims;
    this.originalData = new data.constructor(data);
    this.history = [];
  }

  fromThreshold(sourceData, thresholdPercent = null) {
    const otsu = computeOtsuThreshold(sourceData);
    const threshold = thresholdPercent ?? otsu.thresholdPercent;
    this.data = createThresholdMask(sourceData, threshold, otsu.maxVal);
    this.originalData = new this.data.constructor(this.data);
    this.history.push({ op: 'threshold', threshold });
    return { mask: this.data, otsu };
  }

  applyRobust(options = {}) {
    this.requireMask();
    this.data = robustMask(this.data, this.dims, options);
    this.history.push({ op: 'robust', options });
    return this.data;
  }

  fillHoles() {
    this.requireMask();
    this.data = fillHoles3D(this.data, this.dims);
    this.history.push({ op: 'fill-holes' });
    return this.data;
  }

  erode() {
    this.requireMask();
    this.data = erodeMask3D(this.data, this.dims);
    this.history.push({ op: 'erode' });
    return this.data;
  }

  dilate(iterations = 1) {
    this.requireMask();
    this.data = dilateMask3D(this.data, this.dims, iterations);
    this.history.push({ op: 'dilate', iterations });
    return this.data;
  }

  reset() {
    if (this.originalData) this.data = new this.originalData.constructor(this.originalData);
    this.history = [];
    return this.data;
  }

  requireMask() {
    if (!this.data || !this.dims) throw new Error('No mask data is available');
  }
}
