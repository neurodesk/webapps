/**
 * Console Output Module
 * Writes CALMaR's technical log: timestamped lines with level and source.
 */
export class CalmarConsoleOutput {
  constructor({
    outputElementId = 'technicalConsoleOutput',
    copyButtonId = 'copyTechnicalConsole',
    mirrorToBrowserConsole = true
  } = {}) {
    this.outputElementId = outputElementId;
    this.copyButtonId = copyButtonId;
    this.mirrorToBrowserConsole = mirrorToBrowserConsole;
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  log(text, options = {}) {
    const outputElement = document.getElementById(this.outputElementId);
    const entry = JSON.stringify([String(text), options.level || 'info', options.source || '']);
    if (entry === this.lastEntry && (!outputElement || outputElement.childElementCount > 0)) return;
    this.lastEntry = entry;
    if (outputElement) {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      const line = document.createElement('div');
      const level = options.level || 'info';
      line.className = `nd-console-line nd-console-${level}`;
      const source = options.source
        ? `<span class="console-source">[${this.escapeHtml(options.source)}]</span> `
        : '';
      line.innerHTML =
        `<span class="nd-console-time">[${time}]</span> ` +
        `${source}<span class="nd-console-message">${this.escapeHtml(text)}</span>`;
      outputElement.appendChild(line);
      outputElement.scrollTop = outputElement.scrollHeight;
    }
    if (this.mirrorToBrowserConsole) console.log(text);
  }

  async copyToClipboard() {
    const outputElement = document.getElementById(this.outputElementId);
    if (!outputElement) return false;
    const lines = outputElement.querySelectorAll('.nd-console-line');
    const text = Array.from(lines).map(line => line.textContent).join('\n');
    try {
      await this.writeTextToClipboard(text);
      this.setCopyButtonText('Copied!');
      return true;
    } catch (err) {
      this.setCopyButtonText('Copy failed');
      console.warn('Console copy failed:', err);
      return false;
    }
  }

  async writeTextToClipboard(text) {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        return;
      } catch (err) {
        // Fall back below for in-app browsers or permission-denied contexts.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = !!document.execCommand?.('copy');
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error('document.execCommand("copy") failed');
  }

  setCopyButtonText(text) {
    const btn = document.getElementById(this.copyButtonId);
    if (!btn) return;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }

  clear() {
    this.lastEntry = undefined;
    const outputElement = document.getElementById(this.outputElementId);
    if (outputElement) {
      outputElement.innerHTML = '';
    }
  }
}
