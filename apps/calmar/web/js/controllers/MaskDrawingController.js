export class MaskDrawingController {
  constructor(options) {
    this.nv = options.nv;
    this.updateOutput = options.updateOutput || (() => {});
    this.defaultOpacity = options.defaultOpacity ?? 0.7;
    this.defaultColormap = options.defaultColormap || 'gray';
    this.manualUndoSnapshots = [];
  }

  get hasDrawing() {
    return !!this.nv?.drawBitmap;
  }

  getPenTypes() {
    return globalThis.niivue?.PEN_TYPE || { PEN: 0, RECTANGLE: 1, ELLIPSE: 2 };
  }

  applyDrawingStyle() {
    this.nv?.setDrawColormap?.(this.defaultColormap);
    this.nv?.setDrawOpacity?.(this.defaultOpacity);
  }

  ensureDrawing() {
    if (!this.nv) throw new Error('MaskDrawingController: NiiVue instance is required');
    if (!this.nv.drawBitmap) this.nv.createEmptyDrawing?.();
    this.applyDrawingStyle();
    this.nv.setDrawingEnabled?.(true);
    this.setTool('paint');
  }

  copyDrawingBitmap() {
    return this.nv?.drawBitmap ? new Uint8Array(this.nv.drawBitmap) : null;
  }

  bitmapsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  expectedDrawingLength() {
    const dims = this.nv?.back?.dims || this.nv?.volumes?.[0]?.dims;
    if (!dims || dims.length < 4) return null;
    return dims[1] * dims[2] * dims[3];
  }

  currentDrawingMatchesBase() {
    const expected = this.expectedDrawingLength();
    return !expected || this.nv?.drawBitmap?.length === expected;
  }

  pushManualUndoSnapshot(snapshot) {
    if (!snapshot) return;
    this.manualUndoSnapshots.push(snapshot);
    if (this.manualUndoSnapshots.length > 8) this.manualUndoSnapshots.shift();
  }

  restoreManualUndoSnapshot() {
    const snapshot = this.manualUndoSnapshots.pop();
    if (!snapshot || !this.nv) return false;
    if (!this.nv.drawBitmap || this.nv.drawBitmap.length !== snapshot.length) {
      this.nv.drawBitmap = new Uint8Array(snapshot);
    } else {
      this.nv.drawBitmap.set(snapshot);
    }
    this.nv.refreshDrawing?.(true);
    this.nv.drawScene?.();
    return true;
  }

  drawAddUndoBitmap() {
    try {
      this.nv?.drawAddUndoBitmap?.();
    } catch (err) {
      this.updateOutput(`Drawing undo snapshot warning: ${err.message}`);
    }
  }

  startBlank() {
    if (!this.nv) throw new Error('MaskDrawingController: NiiVue instance is required');
    if (this.nv.drawBitmap && this.currentDrawingMatchesBase()) {
      this.pushManualUndoSnapshot(this.copyDrawingBitmap());
      this.drawAddUndoBitmap();
      this.nv.drawBitmap.fill(0);
      this.nv.refreshDrawing?.(true);
      this.nv.drawScene?.();
      this.drawAddUndoBitmap();
    } else {
      if (this.nv.drawBitmap) this.nv.closeDrawing?.();
      this.nv.createEmptyDrawing?.();
      this.manualUndoSnapshots = [];
    }
    this.applyDrawingStyle();
    this.nv?.setDrawingEnabled?.(true);
    this.setTool('paint');
    this.updateOutput('Blank editable lesion mask ready.');
  }

  async loadSeedFile(file) {
    if (!file) throw new Error('loadSeedFile: seed file is required');
    const url = URL.createObjectURL(file);
    try {
      const ok = await this.nv.loadDrawingFromUrl(url, true);
      if (ok === false) throw new Error('NiiVue rejected the drawing mask');
    } finally {
      URL.revokeObjectURL(url);
    }
    this.applyDrawingStyle();
    this.nv.setDrawingEnabled?.(true);
    this.setTool('paint');
    this.updateOutput(`Editable lesion seed loaded: ${file.name}`);
  }

  setTool(tool) {
    if (!this.nv) return;
    this.nv.opts.clickToSegment = false;
    this.nv.setDrawingEnabled?.(tool !== 'off');
    if (tool === 'off') return;
    if (tool === 'erase') {
      this.nv.setPenValue?.(0, !!this.nv.opts.isFilledPen);
    } else if (tool === 'eraseCluster') {
      this.nv.setPenValue?.(-0, !!this.nv.opts.isFilledPen);
    } else {
      this.nv.setPenValue?.(1, !!this.nv.opts.isFilledPen);
    }
  }

  setPenShape(shape) {
    const types = this.getPenTypes();
    const nextType = shape === 'rectangle'
      ? types.RECTANGLE
      : shape === 'ellipse'
        ? types.ELLIPSE
        : types.PEN;
    if (this.nv?.document?.opts) {
      this.nv.document.opts.penType = nextType;
    } else if (this.nv?.opts) {
      this.nv.opts.penType = nextType;
    }
    this.nv?.drawScene?.();
  }

  setBrushSize(value) {
    const size = Math.max(1, Math.min(25, Math.round(Number(value) || 1)));
    if (this.nv?.opts) this.nv.opts.penSize = size;
    this.nv?.drawScene?.();
    return size;
  }

  setFilled(enabled) {
    const penValue = this.nv?.opts?.penValue ?? 1;
    this.nv?.setPenValue?.(penValue, !!enabled);
  }

  undo() {
    const before = this.copyDrawingBitmap();
    let usedNiiVueUndo = false;
    try {
      if (this.nv?.drawUndo) {
        this.nv.drawUndo();
        usedNiiVueUndo = true;
      }
    } catch (err) {
      this.updateOutput(`Drawing undo warning: ${err.message}`);
    }
    const after = this.copyDrawingBitmap();
    if (!usedNiiVueUndo || (before && after && this.bitmapsEqual(before, after))) {
      if (!this.restoreManualUndoSnapshot()) {
        this.updateOutput('No mask edit to undo.');
      }
    } else if (this.manualUndoSnapshots.length) {
      this.manualUndoSnapshots.pop();
    }
  }

  setOpacity(value) {
    const opacity = Math.max(0, Math.min(1, Number(value)));
    this.nv?.setDrawOpacity?.(Number.isFinite(opacity) ? opacity : this.defaultOpacity);
  }

  setVisible(visible) {
    if (visible) this.nv?.setDrawColormap?.(this.defaultColormap);
    this.nv?.setDrawOpacity?.(visible ? this.defaultOpacity : 0);
    this.nv?.drawScene?.();
  }

  smoothDrawing() {
    const bmp = this.nv?.drawBitmap;
    const dims = this.nv?.back?.dims || this.nv?.volumes?.[0]?.dims;
    if (!bmp || !dims || dims.length < 4) return false;
    const [X, Y, Z] = [dims[1], dims[2], dims[3]];
    const next = new Uint8Array(bmp.length);
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          let n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = z + dz;
            if (zz < 0 || zz >= Z) continue;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= Y) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= X) continue;
                if (bmp[xx + yy * X + zz * X * Y] > 0) n++;
              }
            }
          }
          next[x + y * X + z * X * Y] = n >= 14 ? 1 : 0;
        }
      }
    }
    this.nv.drawBitmap.set(next);
    this.nv.refreshDrawing?.(true);
    return true;
  }

  interpolateAcrossSlices(sliceType = 0) {
    const bounds = this.nv?.findDrawingBoundarySlices?.(Number(sliceType));
    if (!bounds || bounds.first === null || bounds.last === null || bounds.first === bounds.last) {
      return false;
    }
    this.nv.interpolateMaskSlices?.(bounds.first, bounds.last, {
      sliceType: Number(sliceType),
      binaryThreshold: 0.5
    });
    return true;
  }

  async exportDrawingFile(name = 'lnm-lesion-edited-native.nii') {
    const bytes = await this.nv?.saveImage?.({ filename: '', isSaveDrawing: true });
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('No editable lesion drawing is available.');
    }
    return new File([bytes], name, { type: 'application/octet-stream' });
  }

  async downloadDrawing(filename = 'lnm-lesion-edited-native.nii') {
    const saved = await this.nv?.saveImage?.({ filename, isSaveDrawing: true });
    if (saved === false) throw new Error('No editable lesion drawing is available.');
    return saved;
  }

  close(options = {}) {
    this.nv?.setDrawingEnabled?.(false);
    if (options.clearDrawing) {
      if (typeof this.nv?.closeDrawing === 'function') {
        this.nv.closeDrawing();
      } else if (this.nv && Object.prototype.hasOwnProperty.call(this.nv, 'drawBitmap')) {
        this.nv.drawBitmap = null;
      }
      this.manualUndoSnapshots = [];
      this.nv?.drawScene?.();
    }
  }
}
