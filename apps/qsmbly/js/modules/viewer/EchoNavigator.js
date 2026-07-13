/**
 * Echo Navigator Module
 *
 * Manages multi-echo navigation state and UI.
 */

export class EchoNavigator {
  constructor() {
    this.currentEchoIndex = 0;
    this.currentViewType = null; // 'magnitude' | 'phase' | null
    this.echoNavId = 'echoNav';
    this.echoLabelId = 'echoLabel';
    this.echoPrevId = 'echoPrev';
    this.echoNextId = 'echoNext';
  }

  /**
   * Reset to first echo of a view type
   * @param {string} viewType - 'magnitude' or 'phase'
   */
  setViewType(viewType) {
    this.currentViewType = viewType;
    this.currentEchoIndex = 0;
  }

  /**
   * Navigate by direction (-1 or +1)
   * @param {number} direction - Navigation direction
   * @param {number} numEchoes - Total number of echoes
   * @returns {boolean} True if navigation occurred
   */
  navigate(direction, numEchoes) {
    const newIndex = this.currentEchoIndex + direction;
    if (newIndex >= 0 && newIndex < numEchoes) {
      this.currentEchoIndex = newIndex;
      return true;
    }
    return false;
  }

  /**
   * Update the echo navigation UI
   * @param {number} numEchoes - Total number of echoes for current view type
   */
  updateUI(numEchoes) {
    const echoNav = document.getElementById(this.echoNavId);
    const echoLabel = document.getElementById(this.echoLabelId);
    const echoPrev = document.getElementById(this.echoPrevId);
    const echoNext = document.getElementById(this.echoNextId);

    if (!echoNav || !this.currentViewType) {
      if (echoNav) echoNav.style.display = 'none';
      return;
    }

    if (numEchoes <= 1) {
      echoNav.style.display = 'none';
      return;
    }

    echoNav.style.display = 'flex';
    if (echoLabel) {
      echoLabel.textContent = `Echo ${this.currentEchoIndex + 1}/${numEchoes}`;
    }
    if (echoPrev) {
      echoPrev.disabled = this.currentEchoIndex === 0;
    }
    if (echoNext) {
      echoNext.disabled = this.currentEchoIndex >= numEchoes - 1;
    }
  }

  /**
   * Hide echo navigation (used when viewing pipeline results)
   */
  hide() {
    this.currentViewType = null;
    const echoNav = document.getElementById(this.echoNavId);
    if (echoNav) echoNav.style.display = 'none';
  }

  /**
   * Get current state
   * @returns {Object} { viewType, echoIndex }
   */
  getState() {
    return {
      viewType: this.currentViewType,
      echoIndex: this.currentEchoIndex
    };
  }
}
