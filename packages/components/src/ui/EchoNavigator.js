export class EchoNavigator {
  constructor(options = {}) {
    this.currentEchoIndex = 0;
    this.currentViewType = null;
    this.echoNav = resolveTarget(options.echoNav || 'echoNav');
    this.echoLabel = resolveTarget(options.echoLabel || 'echoLabel');
    this.prevButton = resolveTarget(options.prevButton || 'echoPrev');
    this.nextButton = resolveTarget(options.nextButton || 'echoNext');
  }

  setViewType(viewType) {
    this.currentViewType = viewType;
    this.currentEchoIndex = 0;
  }

  navigate(direction, totalEchoes) {
    const next = this.currentEchoIndex + Number(direction);
    if (next < 0 || next >= totalEchoes) return false;
    this.currentEchoIndex = next;
    return true;
  }

  update(totalEchoes) {
    if (!this.echoNav || !this.currentViewType || totalEchoes <= 1) {
      if (this.echoNav) this.echoNav.style.display = 'none';
      return;
    }
    this.echoNav.style.display = 'flex';
    if (this.echoLabel) this.echoLabel.textContent = `Echo ${this.currentEchoIndex + 1}/${totalEchoes}`;
    if (this.prevButton) this.prevButton.disabled = this.currentEchoIndex === 0;
    if (this.nextButton) this.nextButton.disabled = this.currentEchoIndex >= totalEchoes - 1;
  }

  hide() {
    this.currentViewType = null;
    if (this.echoNav) this.echoNav.style.display = 'none';
  }

  getState() {
    return { viewType: this.currentViewType, echoIndex: this.currentEchoIndex };
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
