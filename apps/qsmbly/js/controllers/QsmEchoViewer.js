import { ViewerController as SharedViewerController } from '@neurodesk/webapp-components';

class QsmEchoViewer extends SharedViewerController {
  constructor(options) {
    super(options);
    this.getMultiEchoFiles = options.getMultiEchoFiles;
    this.showOverlayControl = options.showOverlayControl;
    this.updateDownloadVolumeButton = options.updateDownloadVolumeButton;
    this.currentEchoIndex = 0;
    this.currentViewType = null;
  }
  getCurrentEchoIndex() { return this.currentEchoIndex; }
  getCurrentViewType() { return this.currentViewType; }
  async visualizeMagnitude() { return this.visualizeEchoType('magnitude'); }
  async visualizePhase() { return this.visualizeEchoType('phase'); }
  async visualizeEchoType(type) {
    if (!this.getMultiEchoFiles()[type]?.length) { this.updateOutput(`No ${type} files uploaded`); return; }
    this.currentViewType = type; this.currentEchoIndex = 0; this.updateEchoNavigation(); await this.visualizeCurrentEcho();
  }
  navigateEcho(direction) {
    const files = this.getMultiEchoFiles()[this.currentViewType] || []; const index = this.currentEchoIndex + direction;
    if (index >= 0 && index < files.length) { this.currentEchoIndex = index; this.updateEchoNavigation(); void this.visualizeCurrentEcho(); }
  }
  async visualizeCurrentEcho() {
    const file = this.getMultiEchoFiles()[this.currentViewType]?.[this.currentEchoIndex]?.file; if (!file) return;
    const type = this.currentViewType[0].toUpperCase() + this.currentViewType.slice(1);
    await this.loadAndVisualizeFile(file, `${type} (Echo ${this.currentEchoIndex + 1})`);
  }
  updateEchoNavigation() {
    const nav = document.getElementById('echoNav'); if (!nav || !this.currentViewType) { if (nav) nav.style.display = 'none'; return; }
    const count = this.getMultiEchoFiles()[this.currentViewType]?.length || 0; nav.style.display = count > 1 ? 'flex' : 'none';
    const label = document.getElementById('echoLabel'); if (label) label.textContent = `Echo ${this.currentEchoIndex + 1}/${count}`;
    const previous = document.getElementById('echoPrev'); if (previous) previous.disabled = this.currentEchoIndex === 0;
    const next = document.getElementById('echoNext'); if (next) next.disabled = this.currentEchoIndex >= count - 1;
  }
  hideEchoNavigation() { this.currentViewType = null; const nav = document.getElementById('echoNav'); if (nav) nav.style.display = 'none'; }
  async loadAndVisualizeFile(file, description) {
    if (!await this.loadBaseVolume(file)) return;
    this.showOverlayControl?.(false); this.updateDownloadVolumeButton?.(); this.updateOutput(`${description} loaded`); this.updateDataUnits(description);
  }
  updateDataUnits(description) {
    const element = document.getElementById('dataUnits'); if (!element) return; const match = description?.match(/\(([^)]+)\)\s*$/);
    element.textContent = match && ['Hz', 'ppm', 'rad', 'rad/s', 'arb', 'T', 'ms', 's', '1/s'].includes(match[1]) ? `Units: ${match[1]}` : '';
  }
}

export { QsmEchoViewer as ViewerController };
