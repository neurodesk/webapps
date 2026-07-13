/**
 * Console Output Module
 *
 * Handles logging output to the UI console panel.
 */

export class ConsoleOutput {
  constructor(outputElementId = 'output') {
    this.outputElementId = outputElementId;
  }

  /**
   * Append a message to the console output
   * @param {string} text - Message to display
   */
  log(text) {
    const outputElement = document.getElementById(this.outputElementId);
    if (outputElement) {
      outputElement.textContent += text + "\n";
      outputElement.scrollTop = outputElement.scrollHeight;
    }
  }

  /**
   * Clear the console output
   */
  clear() {
    const outputElement = document.getElementById(this.outputElementId);
    if (outputElement) {
      outputElement.textContent = '';
    }
  }
}
