const CONSOLE_OUTPUT_KEY = Symbol.for('neurodesk.consoleOutput');

export class ConsoleOutput {
  static forElement(element, options = {}) {
    if (!element) return null;
    if (element[CONSOLE_OUTPUT_KEY]) return element[CONSOLE_OUTPUT_KEY];
    return new ConsoleOutput({ mirrorToConsole: false, ...options, element, fallback: true });
  }

  constructor(options = {}) {
    // Back-compat: accept a plain element-id string (e.g. new ConsoleOutput('consoleOutput')).
    if (typeof options === 'string') options = { outputElementId: options };
    this.element = resolveTarget(options.element || options.outputElementId || 'consoleOutput');
    this.isFallback = Boolean(options.fallback);
    this._entries = [];
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

    if (this.element) {
      const previous = this.element[CONSOLE_OUTPUT_KEY];
      if (!this.isFallback || !previous) this.element[CONSOLE_OUTPUT_KEY] = this;
      if (!this.isFallback && previous && previous !== this && previous.isFallback && Array.isArray(previous._entries)) {
        for (const entry of previous._entries) {
          entry.node?.remove?.();
          this._appendLine(entry.text, entry.level, entry.timestamp);
        }
      }
    }
  }

  _appendLine(text, lvl, timestamp = new Date()) {
    this.lastMessage = text;
    this.lastLevel = lvl;
    if (!this.element) return null;
    if (lvl === 'error') {
      this.element.closest('[data-disclosure]')?.classList.remove('collapsed');
      const details = this.element.closest('details');
      if (details) details.open = true;
    }
    const doc = this.element.ownerDocument;
    const line = doc.createElement('div');
    const levelCls = this.levelClass(lvl);
    line.className =
      this.levelOn === 'line' ? `${this.lineClass} ${levelCls}`.trim() : this.lineClass;

    const parts = [];
    if (this.showTime) {
      const time = doc.createElement('span');
      time.className = this.timeClass;
      time.textContent = `[${timestamp.toLocaleTimeString('en-US', { hour12: false })}]`;
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
    this._entries.push({ text, level: lvl, timestamp, node: line });
    while (this.element.children.length > this.maxLines) this.element.firstElementChild.remove();
    while (this._entries.length > this.maxLines) this._entries.shift();
    this.element.scrollTop = this.element.scrollHeight;
    return line;
  }

  log(message, level) {
    const text = message == null ? '' : String(message);
    const lvl = level ?? (this.deriveLevel ? this.deriveLevel(text) : 'info');
    if (this.lastMessage === text && this.lastLevel === lvl && (!this.element || this.element.childElementCount > 0)) return;
    this._appendLine(text, lvl);
    if (this.mirrorToConsole) this.mirror(text, lvl);
  }

  clear() {
    this.lastMessage = undefined;
    this.lastLevel = undefined;
    this._entries = [];
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
    const navigator = this.element?.ownerDocument.defaultView?.navigator || globalThis.navigator;
    if (!navigator?.clipboard) return false;
    await navigator.clipboard.writeText(text);
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
