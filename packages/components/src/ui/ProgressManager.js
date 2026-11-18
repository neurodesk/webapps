/**
 * Drives the shared status footer: the message, a progress bar, an optional
 * elapsed-time counter and the cancel × that is shown only while a run can
 * be cancelled.
 *
 * The bar may be a native `<progress>` (the design-system footer) or a legacy
 * `.progress-fill` div whose width is animated. Defaults resolve the template
 * ids: `progress` (falling back to `progressBar`), `statusText`, `elapsed`
 * and `cancelButton`.
 */
const PROGRESS_MANAGER_KEY = Symbol.for('neurodesk.progressManager');

export class ProgressManager {
  constructor(options = {}) {
    this.barElement = resolveTarget(options.barElement || options.progressBarId || 'progress') || resolveTarget('progressBar');
    this.textElement = resolveTarget(options.textElement || options.statusTextId || 'statusText');
    this.elapsedElement = resolveTarget(options.elapsedElement || options.elapsedId || 'elapsed');
    this.cancelElement = resolveTarget(options.cancelElement || options.cancelId || 'cancelButton');
    this.animationSpeed = options.animationSpeed ?? 0.5;
    this.progress = 0;
    this.targetProgress = 0;
    this.animatedProgress = 0;
    this.animationFrame = null;
    this.lastAnimationTime = 0;
    this.timer = null;
    this.startedAt = 0;
    this.pinnedError = false;
    const doc = this.textElement?.ownerDocument;
    if (doc) doc[PROGRESS_MANAGER_KEY] = this;
  }

  get isNativeProgress() {
    return Boolean(this.barElement && this.barElement.tagName === 'PROGRESS');
  }

  setProgress(value, text = null) {
    const next = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
    this.progress = next;
    this.targetProgress = next;
    this.animatedProgress = next;
    this.updateProgressBar();
    if (text != null && this.textElement && !this.pinnedError) {
      if (this.textElement.classList?.contains('error')) this.textElement.classList.remove('error');
      const nextText = String(text);
      if (this.textElement.textContent !== nextText) this.textElement.textContent = nextText;
    }
    this.stopAnimation();
  }

  setIndeterminate(text = 'Working...') {
    this.targetProgress = 0.98;
    if (this.textElement && !this.pinnedError) {
      if (this.textElement.classList?.contains('error')) this.textElement.classList.remove('error');
      const nextText = String(text);
      if (this.textElement.textContent !== nextText) this.textElement.textContent = nextText;
    }
    if (this.isNativeProgress) {
      this.barElement.removeAttribute('value');
      return;
    }
    this.startAnimation();
  }

  /** Show the message without touching the bar. */
  setText(text) {
    if (!this.textElement || this.pinnedError) return;
    if (this.textElement.classList?.contains('error')) this.textElement.classList.remove('error');
    const next = String(text);
    if (this.textElement.textContent !== next) this.textElement.textContent = next;
  }

  /** Show an error message in the status bar without disturbing an active run's controls. */
  setError(text) {
    const activeRun = Boolean(
      this.timer
      || (this.cancelElement && !this.cancelElement.hidden && !this.cancelElement.disabled),
    );
    this.pinnedError = activeRun;
    if (!this.textElement) return;
    const next = String(text);
    if (this.textElement.textContent !== next) this.textElement.textContent = next;
    if (!this.textElement.classList.contains('error')) {
      this.textElement.classList.add('error');
    }
  }

  /** Show or hide the cancel ×. Hidden and disabled when a run cannot be cancelled. */
  setCancellable(cancellable) {
    if (!this.cancelElement) return;
    this.cancelElement.hidden = !cancellable;
    this.cancelElement.disabled = !cancellable;
  }

  /** Start the elapsed counter (mm:ss) next to the message. */
  startTimer() {
    this.stopTimer();
    this.startedAt = Date.now();
    this.renderElapsed();
    if (globalThis.setInterval) {
      this.timer = setInterval(() => this.renderElapsed(), 1000);
      this.timer?.unref?.();
    }
  }

  /** Freeze the elapsed counter at its final value; `clear` removes it. */
  stopTimer(clear = false) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (clear && this.elapsedElement) this.elapsedElement.textContent = '';
  }

  renderElapsed() {
    if (!this.elapsedElement) return;
    const seconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    this.elapsedElement.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  /** A run begins: message, indeterminate bar, timer and cancel. */
  begin(text = 'Working…', { cancellable = true } = {}) {
    this.pinnedError = false;
    if (this.textElement?.classList?.contains('error')) this.textElement.classList.remove('error');
    this.setIndeterminate(text);
    this.startTimer();
    this.setCancellable(cancellable);
  }

  /** A run ends: final message, full or empty bar, frozen timer, no cancel. */
  end(text, { success = true } = {}) {
    const label = text == null ? null : String(text);
    const preservePinned = !success && this.pinnedError && /^(?:failed|error)$/i.test((label || '').trim());
    this.pinnedError = false;
    if ((success || /^cancelled$/i.test((label || '').trim())) && this.textElement?.classList?.contains('error')) {
      this.textElement.classList.remove('error');
    }
    this.stopTimer();
    this.setCancellable(false);
    this.setProgress(success ? 1 : 0, null);
    if (!preservePinned && label != null && this.textElement && this.textElement.textContent !== label) {
      this.textElement.textContent = label;
    }
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
    this.pinnedError = false;
    if (this.textElement?.classList?.contains('error')) this.textElement.classList.remove('error');
    this.stopTimer(true);
    this.setCancellable(false);
    this.setProgress(0, text);
  }

  updateProgressBar() {
    if (!this.barElement) return;
    if (this.isNativeProgress) {
      this.barElement.max = 1;
      this.barElement.value = this.animatedProgress;
      return;
    }
    this.barElement.style.width = `${this.animatedProgress * 100}%`;
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
