export class ModalManager {
  constructor(options = {}) {
    // Back-compat: accept a plain element-id string (e.g. new ModalManager('aboutModal')).
    if (typeof options === 'string') options = { modalId: options };
    this.element = resolveTarget(options.element || options.modalId);
    this.closeOnOverlayClick = options.closeOnOverlayClick ?? true;
    this.activeClass = options.activeClass || 'active';
    if (this.element && this.closeOnOverlayClick) {
      this.element.addEventListener('click', event => {
        if (event.target === this.element) this.close();
      });
    }
  }

  open() {
    this.element?.classList.add(this.activeClass);
  }

  close() {
    this.element?.classList.remove(this.activeClass);
  }

  toggle() {
    this.isOpen() ? this.close() : this.open();
  }

  isOpen() {
    return this.element?.classList.contains(this.activeClass) ?? false;
  }
}

function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === 'string') return globalThis.document?.getElementById(target) || null;
  return target;
}
