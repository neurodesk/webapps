export class ConsoleOutput {
  constructor(options = {}) {
    // Back-compat: accept a plain element-id string (e.g. new ConsoleOutput('consoleOutput')).
    if (typeof options === 'string') options = { outputElementId: options };
    this.element = resolveTarget(options.element || options.outputElementId || 'consoleOutput');
    this.mirrorToConsole = options.mirrorToConsole ?? true;
    this.maxLines = options.maxLines || 1000;

    // Theming/behaviour knobs. Defaults reproduce the library's original markup, so existing
    // consumers are unaffected; MuscleMap overrides them to reproduce its exact `console-*` DOM.
    this.lineClass = options.lineClass || 'nd-console-line';
    this.timeClass = options.timeClass || 'nd-console-time';
    this.messageClass = options.messageClass || 'nd-console-message';
    this.separator = options.separator ?? '';
    this.showTime = options.showTime ?? true;
    this.levelOn = options.levelOn || 'line'; // 'line' | 'message'
    this.levelClass = options.levelClass || ((level) => `nd-console-${level}`);
    this.deriveLevel = options.deriveLevel || null; // (text) => level; used when level not passed
    this.mirror = options.mirror || defaultMirror;
  }

  log(message, level) {
    const text = message == null ? '' : String(message);
    const lvl = level ?? (this.deriveLevel ? this.deriveLevel(text) : 'info');
    if (this.element) {
      const doc = this.element.ownerDocument;
      const line = doc.createElement('div');
      const levelCls = this.levelClass(lvl);
      line.className =
        this.levelOn === 'line' ? `${this.lineClass} ${levelCls}`.trim() : this.lineClass;

      const parts = [];
      if (this.showTime) {
        const time = doc.createElement('span');
        time.className = this.timeClass;
        time.textContent = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
        parts.push(time);
        if (this.separator) parts.push(this.separator);
      }
      const body = doc.createElement('span');
      body.className =
        this.levelOn === 'message' ? `${this.messageClass} ${levelCls}`.trim() : this.messageClass;
      body.textContent = text;
      parts.push(body);

      line.append(...parts);
      this.element.appendChild(line);
      while (this.element.children.length > this.maxLines) this.element.firstElementChild.remove();
      this.element.scrollTop = this.element.scrollHeight;
    }
    if (this.mirrorToConsole) this.mirror(text, lvl);
  }

  clear() {
    if (this.element) this.element.innerHTML = '';
  }

  getText() {
    if (!this.element) return '';
    return Array.from(this.element.querySelectorAll(`.${this.lineClass}`))
      .map((line) => line.textContent)
      .join('\n');
  }

  async copyToClipboard() {
    const text = this.getText();
    if (!globalThis.navigator?.clipboard) return false;
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  }
}

function defaultMirror(text, level) {
  console[level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log'](text);
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
