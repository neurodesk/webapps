/**
 * Viewer Controller
 *
 * Manages echo navigation, visualization, and display of volumes in NiiVue.
 */

export class ViewerController {
  /**
   * @param {Object} options
   * @param {Object} options.nv - NiiVue instance
   * @param {Function} options.getMultiEchoFiles - Function to get multiEchoFiles
   * @param {Function} options.updateOutput - Logging callback
   * @param {Function} options.showOverlayControl - Function to show/hide overlay control
   * @param {Function} options.updateDownloadVolumeButton - Function to update download button
   */
  constructor(options) {
    this.nv = options.nv;
    this.getMultiEchoFiles = options.getMultiEchoFiles;
    this.updateOutput = options.updateOutput;
    this.showOverlayControl = options.showOverlayControl;
    this.updateDownloadVolumeButton = options.updateDownloadVolumeButton;

    // Navigation state
    this.currentEchoIndex = 0;
    this.currentViewType = null;
    this.currentFile = null;
  }

  // ==================== State Accessors ====================

  getCurrentEchoIndex() {
    return this.currentEchoIndex;
  }

  getCurrentViewType() {
    return this.currentViewType;
  }

  getCurrentFile() {
    return this.currentFile;
  }

  // ==================== Visualization ====================

  /**
   * Visualize magnitude data (first echo)
   */
  async visualizeMagnitude() {
    const multiEchoFiles = this.getMultiEchoFiles();
    if (multiEchoFiles.magnitude.length === 0) {
      this.updateOutput("No magnitude files uploaded");
      return;
    }

    this.currentViewType = 'magnitude';
    this.currentEchoIndex = 0;
    this.updateEchoNavigation();
    await this.visualizeCurrentEcho();
  }

  /**
   * Visualize phase data (first echo)
   */
  async visualizePhase() {
    const multiEchoFiles = this.getMultiEchoFiles();
    if (multiEchoFiles.phase.length === 0) {
      this.updateOutput("No phase files uploaded");
      return;
    }

    this.currentViewType = 'phase';
    this.currentEchoIndex = 0;
    this.updateEchoNavigation();
    await this.visualizeCurrentEcho();
  }

  /**
   * Navigate to previous/next echo
   * @param {number} direction - -1 for previous, +1 for next
   */
  navigateEcho(direction) {
    if (!this.currentViewType) return;

    const multiEchoFiles = this.getMultiEchoFiles();
    const files = multiEchoFiles[this.currentViewType];
    if (!files || files.length === 0) return;

    const newIndex = this.currentEchoIndex + direction;
    if (newIndex >= 0 && newIndex < files.length) {
      this.currentEchoIndex = newIndex;
      this.updateEchoNavigation();
      this.visualizeCurrentEcho();
    }
  }

  /**
   * Visualize the current echo based on currentViewType and currentEchoIndex
   */
  async visualizeCurrentEcho() {
    if (!this.currentViewType) return;

    const multiEchoFiles = this.getMultiEchoFiles();
    const files = multiEchoFiles[this.currentViewType];
    if (!files || files.length === 0) return;

    const file = files[this.currentEchoIndex].file;
    const typeName = this.currentViewType.charAt(0).toUpperCase() + this.currentViewType.slice(1);
    await this.loadAndVisualizeFile(file, `${typeName} (Echo ${this.currentEchoIndex + 1})`);
  }

  /**
   * Update echo navigation UI visibility and labels
   */
  updateEchoNavigation() {
    const echoNav = document.getElementById('echoNav');
    const echoLabel = document.getElementById('echoLabel');
    const echoPrev = document.getElementById('echoPrev');
    const echoNext = document.getElementById('echoNext');

    if (!echoNav || !this.currentViewType) {
      if (echoNav) echoNav.style.display = 'none';
      return;
    }

    const multiEchoFiles = this.getMultiEchoFiles();
    const files = multiEchoFiles[this.currentViewType];
    const numEchoes = files?.length || 0;

    if (numEchoes <= 1) {
      echoNav.style.display = 'none';
      return;
    }

    echoNav.style.display = 'flex';
    echoLabel.textContent = `Echo ${this.currentEchoIndex + 1}/${numEchoes}`;
    echoPrev.disabled = this.currentEchoIndex === 0;
    echoNext.disabled = this.currentEchoIndex >= numEchoes - 1;
  }

  /**
   * Hide echo navigation when viewing non-echo data (pipeline results)
   */
  hideEchoNavigation() {
    this.currentViewType = null;
    const echoNav = document.getElementById('echoNav');
    if (echoNav) echoNav.style.display = 'none';
  }

  /**
   * Load and display a file in NiiVue
   * @param {File} file - The file to load
   * @param {string} description - Description for logging
   */
  async loadAndVisualizeFile(file, description) {
    try {
      // Loading message removed — just log when done

      // Create a blob URL for NiiVue to load
      const url = URL.createObjectURL(file);

      // Load using loadVolumes which handles the URL properly
      await this.nv.loadVolumes([{ url: url, name: file.name }]);

      // Clean up the blob URL
      URL.revokeObjectURL(url);

      // Hide overlay control (no overlay after loading new volume)
      if (this.showOverlayControl) {
        this.showOverlayControl(false);
      }

      // Enable download button
      if (this.updateDownloadVolumeButton) {
        this.updateDownloadVolumeButton();
      }

      this.updateOutput(`${description} loaded`);
      this.currentFile = file;

      // Update units display from description (e.g. "QSM Result (ppm)" -> "Units: ppm")
      this.updateDataUnits(description);
    } catch (error) {
      this.updateOutput(`Error loading ${description}: ${error.message}`);
      console.error(error);
    }
  }

  /**
   * Extract units from a description string and display in the toolbar.
   * Descriptions follow the pattern "Name (units)", e.g. "B0 Field Map (Hz)".
   * Only recognizes known unit strings to avoid matching things like "(Echo 1)".
   * @param {string} description - The description to parse
   */
  updateDataUnits(description) {
    const el = document.getElementById('dataUnits');
    if (!el) return;
    const knownUnits = ['Hz', 'ppm', 'rad', 'rad/s', 'arb', 'T', 'ms', 's', '1/s'];
    const match = description && description.match(/\(([^)]+)\)\s*$/);
    if (match && knownUnits.includes(match[1])) {
      el.textContent = `Units: ${match[1]}`;
    } else {
      el.textContent = '';
    }
  }
}
