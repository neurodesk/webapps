/**
 * Progress Manager Module
 *
 * Handles progress bar updates with smooth animation.
 */

export class ProgressManager {
  constructor(config) {
    this.progressBarId = 'progressBar';
    this.progressTextId = 'progressText';

    // Animation state
    this.progress = 0;
    this.targetProgress = 0;
    this.animatedProgress = 0;
    this.progressAnimationId = null;
    this.lastAnimationTime = 0;
    this.animationSpeed = config.animationSpeed;
  }

  /**
   * Set progress value and optional text
   * @param {number} value - Progress value 0-1
   * @param {string|null} text - Optional text to display
   */
  setProgress(value, text = null) {
    this.progress = value;
    this.targetProgress = value;

    const textEl = document.getElementById(this.progressTextId);
    if (textEl) textEl.textContent = text || `${Math.round(value * 100)}%`;

    // Update progress bar immediately for accurate feedback
    this.animatedProgress = value;
    this.updateProgressBar();

    // Stop any running animation since we update immediately
    this.stopAnimation();
  }

  /**
   * Animate progress bar smoothly toward target
   */
  animate() {
    const now = performance.now();
    const deltaTime = (now - this.lastAnimationTime) / 1000; // Convert to seconds
    this.lastAnimationTime = now;

    // Move animated progress toward target, but don't exceed it
    if (this.animatedProgress < this.targetProgress) {
      const increment = this.animationSpeed * deltaTime;
      this.animatedProgress = Math.min(this.animatedProgress + increment, this.targetProgress);
      this.updateProgressBar();
    }

    // Continue animation loop if not complete
    if (this.targetProgress < 1 && this.targetProgress > 0) {
      this.progressAnimationId = requestAnimationFrame(() => this.animate());
    }
  }

  /**
   * Start progress animation
   */
  startAnimation() {
    if (this.progressAnimationId) return; // Already running
    this.lastAnimationTime = performance.now();
    this.progressAnimationId = requestAnimationFrame(() => this.animate());
  }

  /**
   * Stop progress animation
   */
  stopAnimation() {
    if (this.progressAnimationId) {
      cancelAnimationFrame(this.progressAnimationId);
      this.progressAnimationId = null;
    }
  }

  /**
   * Update progress bar DOM element
   */
  updateProgressBar() {
    const bar = document.getElementById(this.progressBarId);
    if (bar) bar.style.width = `${this.animatedProgress * 100}%`;
  }

  /**
   * Reset progress to zero
   */
  reset() {
    this.setProgress(0, '');
  }
}
