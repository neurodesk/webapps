export class ConsoleOutput {
  constructor(options = {}) {
    this.element = resolveTarget(options.element || options.outputElementId || 'consoleOutput');
    this.mirrorToConsole = options.mirrorToConsole ?? true;
    this.maxLines = options.maxLines || 1000;
  }

  log(message, level = 'info') {
    const text = message == null ? '' : String(message);
    if (this.element) {
      const line = this.element.ownerDocument.createElement('div');
      line.className = `nd-console-line nd-console-${level}`;

      const time = this.element.ownerDocument.createElement('span');
      time.className = 'nd-console-time';
      time.textContent = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;

      const body = this.element.ownerDocument.createElement('span');
      body.className = 'nd-console-message';
      body.textContent = text;

      line.append(time, body);
      this.element.appendChild(line);
      while (this.element.children.length > this.maxLines) this.element.firstElementChild.remove();
      this.element.scrollTop = this.element.scrollHeight;
    }
    if (this.mirrorToConsole) console[level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log'](text);
  }

  clear() {
    if (this.element) this.element.innerHTML = '';
  }

  getText() {
    if (!this.element) return '';
    return Array.from(this.element.querySelectorAll('.nd-console-line'))
      .map(line => line.textContent)
      .join('\n');
  }

  async copyToClipboard() {
    const text = this.getText();
    if (!globalThis.navigator?.clipboard) return false;
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
