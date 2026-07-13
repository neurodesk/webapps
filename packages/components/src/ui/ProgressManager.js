export class ProgressManager {
  constructor(options = {}) {
    this.barElement = resolveTarget(options.barElement || options.progressBarId || 'progressBar');
    this.textElement = resolveTarget(options.textElement || options.statusTextId || 'statusText');
    this.animationSpeed = options.animationSpeed ?? 0.5;
    this.progress = 0;
    this.targetProgress = 0;
    this.animatedProgress = 0;
    this.animationFrame = null;
    this.lastAnimationTime = 0;
  }

  setProgress(value, text = null) {
    const next = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
    this.progress = next;
    this.targetProgress = next;
    this.animatedProgress = next;
    this.updateProgressBar();
    if (text != null && this.textElement) this.textElement.textContent = String(text);
    this.stopAnimation();
  }

  setIndeterminate(text = 'Working...') {
    this.targetProgress = 0.98;
    if (this.textElement) this.textElement.textContent = text;
    this.startAnimation();
  }

  startAnimation() {
    if (this.animationFrame || !globalThis.requestAnimationFrame) return;
    this.lastAnimationTime = performance.now();
    this.animationFrame = requestAnimationFrame(() => this.animate());
  }

  animate() {
    const now = performance.now();
    const delta = (now - this.lastAnimationTime) / 1000;
    this.lastAnimationTime = now;
    if (this.animatedProgress < this.targetProgress) {
      this.animatedProgress = Math.min(this.targetProgress, this.animatedProgress + this.animationSpeed * delta);
      this.updateProgressBar();
    }
    if (this.targetProgress < 1 && this.targetProgress > 0) {
      this.animationFrame = requestAnimationFrame(() => this.animate());
    } else {
      this.animationFrame = null;
    }
  }

  stopAnimation() {
    if (this.animationFrame && globalThis.cancelAnimationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  reset(text = 'Ready') {
    this.setProgress(0, text);
  }

  updateProgressBar() {
    if (this.barElement) this.barElement.style.width = `${this.animatedProgress * 100}%`;
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
