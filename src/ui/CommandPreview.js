export class CommandPreview {
  constructor(options = {}) {
    this.generator = options.generator || (() => '');
    this.modal = resolveTarget(options.modal);
    this.textElement = resolveTarget(options.textElement);
    this.copyButton = resolveTarget(options.copyButton);
    this.copyButton?.addEventListener('click', () => this.copy());
  }

  render(settings, context = {}) {
    const command = this.generator(settings, context);
    if (this.textElement) this.textElement.textContent = command;
    return command;
  }

  open(settings, context = {}) {
    const command = this.render(settings, context);
    this.modal?.classList.add('active');
    return command;
  }

  close() {
    this.modal?.classList.remove('active');
  }

  async copy() {
    if (!this.textElement || !globalThis.navigator?.clipboard) return false;
    await navigator.clipboard.writeText(this.textElement.textContent || '');
    return true;
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
