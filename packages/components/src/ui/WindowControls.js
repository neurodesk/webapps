export class WindowControls {
  constructor(options = {}) {
    this.root = options.root || document;
    this.getVolume = options.getVolume || (() => null);
    this.onReset = options.onReset || null;
    this.updateVolume = options.updateVolume || (() => {});
    this.minimumGap = options.minimumGap ?? 1;
  }

  bind() {
    const min = this.element('rangeMin'); const max = this.element('rangeMax');
    const inputMin = this.element('windowMin'); const inputMax = this.element('windowMax');
    if (!min || !max || !inputMin || !inputMax) return false;
    min.addEventListener('input', () => { if (+min.value > +max.value - this.minimumGap) min.value = +max.value - this.minimumGap; this.applySliders(); });
    max.addEventListener('input', () => { if (+max.value < +min.value + this.minimumGap) max.value = +min.value + this.minimumGap; this.applySliders(); });
    inputMin.addEventListener('change', () => this.applyInputs());
    inputMax.addEventListener('change', () => this.applyInputs());
    this.element('resetWindow')?.addEventListener('click', () => this.reset());
    return true;
  }

  element(id) {
    if (typeof this.root.control === 'function') return this.root.control(id);
    return this.root.getElementById(id);
  }
  range(volume) { const min = volume.global_min ?? 0; const max = volume.global_max ?? 1; return { min, max, span: max - min || 1 }; }
  commit(volume) { this.updateVolume(volume); this.sync(); }

  applySliders() {
    const volume = this.getVolume(); if (!volume) return;
    const range = this.range(volume);
    volume.cal_min = range.min + (+this.element('rangeMin').value / 100) * range.span;
    volume.cal_max = range.min + (+this.element('rangeMax').value / 100) * range.span;
    this.commit(volume);
  }

  applyInputs() {
    const volume = this.getVolume(); if (!volume) return;
    const min = +this.element('windowMin').value; const max = +this.element('windowMax').value;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    volume.cal_min = min; volume.cal_max = max; this.commit(volume);
  }

  reset() {
    const volume = this.getVolume(); if (!volume) return;
    if (this.onReset) return this.onReset(volume);
    volume.cal_min = volume.global_min ?? 0; volume.cal_max = volume.global_max ?? 1; this.commit(volume);
  }

  sync() {
    const volume = this.getVolume(); if (!volume) return;
    const min = this.element('windowMin'); const max = this.element('windowMax');
    if (min) min.value = (volume.cal_min ?? 0).toPrecision(4);
    if (max) max.value = (volume.cal_max ?? 1).toPrecision(4);
    this.syncSliders();
    const download = this.element('downloadCurrentVolume'); if (download) download.disabled = false;
  }

  syncSliders() {
    const volume = this.getVolume(); if (!volume) return;
    const range = this.range(volume); const min = this.element('rangeMin'); const max = this.element('rangeMax');
    if (!min || !max) return;
    const low = Math.max(0, Math.min(100, ((volume.cal_min - range.min) / range.span) * 100));
    const high = Math.max(0, Math.min(100, ((volume.cal_max - range.min) / range.span) * 100));
    min.value = low; max.value = high;
    const selected = this.element('rangeSelected'); if (selected) { selected.style.left = `${low}%`; selected.style.width = `${high - low}%`; }
  }
}

export function bindWindowControls(options) { const controls = new WindowControls(options); controls.bind(); return controls; }
