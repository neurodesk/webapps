import { createElement } from '../core/dom.js';
import { ConsoleOutput } from '../ui/ConsoleOutput.js';
import { bindSectionDisclosure, unbindSectionDisclosure } from '../ui/bindSectionDisclosures.js';
import { defineElement, upgradeProperties } from './define.js';

let nextId = 0;

export function defineConsole(view) {
  return defineElement('nd-console', createConsoleClass, view);
}

function createConsoleClass(view) {
  return class NeurodeskConsole extends view.HTMLElement {
    static observedAttributes = ['collapsed', 'label', 'max-lines'];

    #output;
    #console;
    #title;
    #observer;
    #copyTimer;
    #copyGeneration = 0;

    connectedCallback() {
      this.initialize();
      upgradeProperties(this, ['collapsed']);
      this.collapsed = this.classList.contains('collapsed');
      bindSectionDisclosure(this);
      this.#observer ??= new view.MutationObserver(() => {
        this.collapsed = this.classList.contains('collapsed');
      });
      this.#observer.observe(this, { attributes: true, attributeFilter: ['class'] });
    }

    disconnectedCallback() {
      queueMicrotask(() => {
        if (this.isConnected) return;
        unbindSectionDisclosure(this);
        this.#observer?.disconnect();
        clearTimeout(this.#copyTimer);
        this.#copyGeneration++;
        const copy = this.querySelector('[data-console-copy]');
        if (copy) copy.textContent = 'Copy';
      });
    }

    attributeChangedCallback(name) {
      if (!this.#output) return;
      if (name === 'collapsed') this.classList.toggle('collapsed', this.collapsed);
      if (name === 'label') this.#title.textContent = this.getAttribute('label') || 'Technical log';
      if (name === 'max-lines') this.#console.maxLines = this.#maxLines();
    }

    get collapsed() { return this.hasAttribute('collapsed'); }
    set collapsed(value) {
      this.toggleAttribute('collapsed', Boolean(value));
      this.classList.toggle('collapsed', Boolean(value));
    }
    get output() { this.initialize(); return this.#output; }
    get console() { this.initialize(); return this.#console; }

    #maxLines() {
      const value = Number(this.getAttribute('max-lines'));
      return Number.isInteger(value) && value > 0 ? value : 1000;
    }

    initialize(config = {}) {
      if (this.#output) return;
      const doc = this.ownerDocument;
      this.id ||= config.id || `nd-console-${++nextId}`;
      if (config.title) this.setAttribute('label', config.title);
      if (config.maxLines != null) this.setAttribute('max-lines', String(config.maxLines));
      if (config.collapsed !== undefined) this.toggleAttribute('collapsed', config.collapsed);
      this.classList.add('nd-console-container');
      this.classList.toggle('collapsed', this.collapsed);
      this.setAttribute('data-disclosure', '');
      this.#output = createElement('div', {
        className: 'nd-console-output', id: config.outputId || `${this.id}Output`,
        'aria-label': config.outputLabel || 'Processing log', 'data-disclosure-panel': '', ownerDocument: doc,
      });
      this.#title = createElement('button', {
        type: 'button', className: 'nd-console-title', 'data-disclosure-toggle': '',
        text: this.getAttribute('label') || 'Technical log', ownerDocument: doc,
      });
      const actions = createElement('div', { className: 'nd-console-actions', ownerDocument: doc });
      this.append(createElement('div', { className: 'nd-console-header', ownerDocument: doc }, [this.#title, actions]), this.#output);
      this.#console = new ConsoleOutput({ element: this.#output, mirrorToConsole: config.mirrorToConsole ?? false, maxLines: this.#maxLines() });
      if (config.copy !== false) {
        const button = createElement('button', {
          id: config.copyId || `${this.id}Copy`, type: 'button', className: 'nd-console-clear',
          text: 'Copy', 'data-console-copy': '', ownerDocument: doc,
        });
        button.addEventListener('click', async () => {
          const generation = ++this.#copyGeneration;
          const copied = await this.#console.copyToClipboard().catch(() => false);
          if (generation !== this.#copyGeneration || !this.isConnected) return;
          button.textContent = copied ? 'Copied' : 'Copy failed';
          clearTimeout(this.#copyTimer);
          this.#copyTimer = setTimeout(() => { button.textContent = 'Copy'; }, 1200);
        });
        actions.append(button);
      }
      if (config.clear !== false) {
        const button = createElement('button', {
          id: config.clearId || `${this.id}Clear`, type: 'button', className: 'nd-console-clear', text: 'Clear', ownerDocument: doc,
        });
        button.addEventListener('click', () => this.clear());
        actions.append(button);
      }
      this.#title.setAttribute('aria-controls', this.#output.id);
      this.#title.setAttribute('aria-expanded', String(!this.collapsed));
      this.#output.hidden = this.collapsed;
      this.#output.inert = this.collapsed;
    }

    open() { this.collapsed = false; }
    close() { this.collapsed = true; }
    log(message, level) {
      this.initialize();
      if (level === 'error') this.open();
      this.#console.log(message, level);
    }
    clear() { this.console.clear(); }
    getText() { return this.console.getText(); }
  };
}

export function createConsole(config = {}, doc = globalThis.document) {
  defineConsole(doc.defaultView);
  const element = doc.createElement('nd-console');
  element.initialize({ ...config, collapsed: config.collapsed !== false });
  return element;
}
