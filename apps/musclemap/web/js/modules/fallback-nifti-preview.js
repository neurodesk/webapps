export class FallbackNiftiPreview {
  constructor({ canvasId, messageId, updateOutput } = {}) {
    this.canvas = canvasId ? document.getElementById(canvasId) : null;
    this.message = messageId ? document.getElementById(messageId) : null;
    this.updateOutput = updateOutput || (() => {});
    this.reason = '';
    this.lastRendered = null;
  }

  isSupported() {
    return !!this.canvas && !!this.message && !!this.getNifti();
  }

  setUnavailable(reason) {
    this.reason = reason || '';
    this.lastRendered = null;
    document.body.classList.remove('viewer-fallback-2d');
    this.clearCanvas();
  }

  clear() {
    this.reason = '';
    this.lastRendered = null;
    document.body.classList.remove('viewer-fallback-2d');
    this.clearCanvas();
  }

  redraw() {
    if (!this.lastRendered) return false;
    this.drawSlice(this.lastRendered.preview);
    this.setPreviewMessage(
      this.lastRendered.stageName,
      this.lastRendered.preview,
      this.lastRendered.reason
    );
    return true;
  }

  async renderFile(file, { stageName = 'Image', reason = this.reason } = {}) {
    if (!this.isSupported() || !file) return false;

    try {
      const preview = await this.decodeNiftiForFallback(file);
      const fallbackReason = reason || this.reason;
      this.reason = fallbackReason;
      this.drawSlice(preview);
      this.lastRendered = { file, preview, stageName, reason: fallbackReason };
      document.body.classList.add('viewer-fallback-2d');
      this.setPreviewMessage(stageName, preview, fallbackReason);
      return true;
    } catch (error) {
      document.body.classList.remove('viewer-fallback-2d');
      this.clearCanvas();
      this.updateOutput(`2D image preview unavailable: ${error.message}`);
      return false;
    }
  }

  async decodeNiftiForFallback(file) {
    const nifti = this.getNifti();
    if (!nifti) throw new Error('NIfTI decoder unavailable');

    let data = await file.arrayBuffer();
    if (nifti.isCompressed(data)) {
      data = nifti.decompress(data);
    }

    const header = nifti.readHeader(data);
    if (!header) throw new Error('File is not a NIfTI volume');

    const imageBuffer = nifti.readImage(header, data);
    const width = Math.max(1, Number(header.dims?.[1]) || 1);
    const height = Math.max(1, Number(header.dims?.[2]) || 1);
    const depth = Math.max(1, Number(header.dims?.[3]) || 1);
    const datatypeCode = Number(header.datatypeCode);
    const bytesPerVoxel = this.getBytesPerVoxel(header);
    const view = new DataView(imageBuffer);
    const littleEndian = header.littleEndian !== false;
    const slope = Number.isFinite(header.scl_slope) && header.scl_slope !== 0 ? header.scl_slope : 1;
    const intercept = Number.isFinite(header.scl_inter) ? header.scl_inter : 0;
    const sliceIndex = this.selectRepresentativeSlice({
      view,
      width,
      height,
      depth,
      datatypeCode,
      bytesPerVoxel,
      littleEndian,
      slope,
      intercept
    });

    const values = new Float32Array(width * height);
    let min = Infinity;
    let max = -Infinity;
    const sliceOffset = sliceIndex * width * height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = y * width + x;
        const value = this.readScaledVoxel(view, sliceOffset + pixelIndex, {
          datatypeCode,
          bytesPerVoxel,
          littleEndian,
          slope,
          intercept
        });
        values[pixelIndex] = value;
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }

    return {
      fileName: file.name || 'volume',
      width,
      height,
      depth,
      sliceIndex,
      min,
      max,
      values
    };
  }

  selectRepresentativeSlice({ view, width, height, depth, datatypeCode, bytesPerVoxel, littleEndian, slope, intercept }) {
    if (depth <= 1) return 0;

    const middle = Math.floor(depth / 2);
    const voxelsPerSlice = width * height;
    const sampleStep = Math.max(1, Math.floor(voxelsPerSlice / 4096));
    let bestSlice = middle;
    let bestNonZero = -1;
    let bestRange = -Infinity;
    let bestDistance = Infinity;

    for (let z = 0; z < depth; z++) {
      let min = Infinity;
      let max = -Infinity;
      let nonZero = 0;
      const sliceOffset = z * voxelsPerSlice;

      for (let pixelIndex = 0; pixelIndex < voxelsPerSlice; pixelIndex += sampleStep) {
        const value = this.readScaledVoxel(view, sliceOffset + pixelIndex, {
          datatypeCode,
          bytesPerVoxel,
          littleEndian,
          slope,
          intercept
        });
        if (!Number.isFinite(value)) continue;
        if (value !== 0) nonZero++;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }

      const range = Number.isFinite(min) && Number.isFinite(max) ? max - min : -Infinity;
      const distance = Math.abs(z - middle);
      if (
        nonZero > bestNonZero ||
        (nonZero === bestNonZero && range > bestRange) ||
        (nonZero === bestNonZero && range === bestRange && distance < bestDistance)
      ) {
        bestSlice = z;
        bestNonZero = nonZero;
        bestRange = range;
        bestDistance = distance;
      }
    }

    return bestSlice;
  }

  drawSlice(preview) {
    const wrapper = this.canvas.parentElement;
    const rect = wrapper?.getBoundingClientRect?.() || { width: preview.width, height: preview.height };
    const dpr = window.devicePixelRatio || 1;
    const rectWidth = rect.width && rect.width > 20 ? rect.width : preview.width;
    const rectHeight = rect.height && rect.height > 20 ? rect.height : preview.height;
    const targetWidth = Math.max(1, Math.floor(rectWidth * dpr));
    const targetHeight = Math.max(1, Math.floor(rectHeight * dpr));
    const ctx = this.canvas.getContext('2d');
    const scratch = document.createElement('canvas');
    const scratchCtx = scratch.getContext('2d');
    const imageData = scratchCtx.createImageData(preview.width, preview.height);
    const range = preview.max > preview.min ? preview.max - preview.min : 1;

    scratch.width = preview.width;
    scratch.height = preview.height;
    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    ctx.clearRect(0, 0, targetWidth, targetHeight);

    for (let i = 0; i < preview.values.length; i++) {
      const value = Number.isFinite(preview.values[i]) ? preview.values[i] : preview.min;
      const gray = Math.max(0, Math.min(255, Math.round(((value - preview.min) / range) * 255)));
      const offset = i * 4;
      imageData.data[offset] = gray;
      imageData.data[offset + 1] = gray;
      imageData.data[offset + 2] = gray;
      imageData.data[offset + 3] = 255;
    }

    scratchCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const scale = Math.min(targetWidth / preview.width, targetHeight / preview.height);
    const drawWidth = Math.max(1, Math.floor(preview.width * scale));
    const drawHeight = Math.max(1, Math.floor(preview.height * scale));
    const dx = Math.floor((targetWidth - drawWidth) / 2);
    const dy = Math.floor((targetHeight - drawHeight) / 2);
    ctx.drawImage(scratch, dx, dy, drawWidth, drawHeight);
  }

  clearCanvas() {
    const ctx = this.canvas?.getContext?.('2d');
    if (ctx && this.canvas.width && this.canvas.height) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  setPreviewMessage(stageName, preview, reason) {
    if (!this.message) return;
    const reasonText = reason ? ` NiiVue: ${reason}` : '';
    this.message.hidden = false;
    this.message.textContent =
      `2D preview only. ${stageName}: axial slice ${preview.sliceIndex + 1}/${preview.depth}.`
      + ` Enable hardware acceleration (chrome://gpu) and reload for the 3D viewer.${reasonText}`;
    this.message.title = reason || '';
  }

  getNifti() {
    const root = typeof window !== 'undefined' ? window : globalThis;
    return root.nifti || null;
  }

  getBytesPerVoxel(header) {
    const bits = Number(header.numBitsPerVoxel);
    if (Number.isFinite(bits) && bits > 0) return Math.max(1, Math.floor(bits / 8));
    return this.getDatatypeBytes(Number(header.datatypeCode));
  }

  getDatatypeBytes(datatypeCode) {
    switch (datatypeCode) {
      case 2:
      case 256:
        return 1;
      case 4:
      case 512:
        return 2;
      case 8:
      case 16:
      case 768:
        return 4;
      case 64:
      case 1024:
      case 1280:
        return 8;
      default:
        throw new Error(`Unsupported NIfTI datatype ${datatypeCode}`);
    }
  }

  readScaledVoxel(view, voxelIndex, options) {
    const { bytesPerVoxel, slope, intercept } = options;
    const byteOffset = voxelIndex * bytesPerVoxel;
    if (byteOffset < 0 || byteOffset + bytesPerVoxel > view.byteLength) return NaN;
    return this.readVoxel(view, byteOffset, options) * slope + intercept;
  }

  readVoxel(view, byteOffset, { datatypeCode, littleEndian }) {
    switch (datatypeCode) {
      case 2:
        return view.getUint8(byteOffset);
      case 4:
        return view.getInt16(byteOffset, littleEndian);
      case 8:
        return view.getInt32(byteOffset, littleEndian);
      case 16:
        return view.getFloat32(byteOffset, littleEndian);
      case 64:
        return view.getFloat64(byteOffset, littleEndian);
      case 256:
        return view.getInt8(byteOffset);
      case 512:
        return view.getUint16(byteOffset, littleEndian);
      case 768:
        return view.getUint32(byteOffset, littleEndian);
      case 1024:
        return Number(view.getBigInt64(byteOffset, littleEndian));
      case 1280:
        return Number(view.getBigUint64(byteOffset, littleEndian));
      default:
        throw new Error(`Unsupported NIfTI datatype ${datatypeCode}`);
    }
  }
}
