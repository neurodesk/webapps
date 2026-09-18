import { defineElement, upgradeProperties } from './define.js';
import { bindFileDrop } from '../ui/renderFileField.js';

let nextId = 0;
const DEFAULT_TEXT = 'Drop NIfTI or DICOM files';
const UPLOAD_ICON = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>';

export function defineFileField(view = globalThis.window) {
  return defineElement('nd-file-field', window => class extends window.HTMLElement {
    static observedAttributes = ['input-id', 'name', 'text', 'label', 'kind', 'accept', 'multiple', 'directory', 'disabled'];
    #input;
    #text;
    #label;
    #drop;
    #handler;
    #defaultInputId;

    connectedCallback() {
      upgradeProperties(this, ['disabled']);
      this.#initialize();
      this.#input.addEventListener('change', this.#change);
      this.#drop = bindFileDrop(this.#label, files => this.#emit(files), this.ownerDocument, () => this.disabled || this.#input.disabled);
    }

    disconnectedCallback() {
      this.#input?.removeEventListener('change', this.#change);
      this.#drop?.destroy();
      this.#drop = undefined;
    }

    attributeChangedCallback(name) {
      if (this.#input) this.#sync(name);
    }

    get input() {
      this.#initialize();
      return this.#input;
    }

    get text() {
      this.#initialize();
      return this.#text;
    }

    get disabled() {
      return this.hasAttribute('disabled');
    }

    set disabled(value) {
      this.toggleAttribute('disabled', Boolean(value));
    }

    onFiles(handler) {
      this.#handler = handler;
      return this;
    }

    setText(value) {
      this.setAttribute('text', value);
    }

    setHasFiles(value) {
      this.#initialize();
      this.#label.classList.toggle('has-files', Boolean(value));
    }

    #initialize() {
      if (this.#input) return;
      const doc = this.ownerDocument;
      this.#label = doc.createElement('label');
      this.#label.className = 'nd-file';
      this.#input = doc.createElement('input');
      this.#input.type = 'file';
      this.#defaultInputId = `nd-file-input-${++nextId}`;
      this.#text = doc.createElement('span');
      this.#text.className = 'nd-file-text';
      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = UPLOAD_ICON;
      this.#label.append(this.#input, icon, this.#text);
      this.append(this.#label);
      this.#sync();
    }

    #sync(name) {
      this.#input.id = this.getAttribute('input-id') || this.#defaultInputId;
      this.#label.htmlFor = this.#input.id;
      this.#input.name = this.getAttribute('name') || '';
      this.#input.multiple = this.getAttribute('multiple') !== 'false';
      if (!name || name === 'disabled') this.#input.disabled = this.disabled;
      this.#input.dataset.neurodeskInput = this.getAttribute('kind') || 'image';
      for (const attribute of ['webkitdirectory', 'directory']) {
        this.#input.toggleAttribute(attribute, this.hasAttribute('directory'));
      }
      if (this.hasAttribute('accept')) this.#input.setAttribute('accept', this.getAttribute('accept'));
      else this.#input.removeAttribute('accept');
      if (!name || name === 'text') this.#text.textContent = this.getAttribute('text') || DEFAULT_TEXT;
      this.#input.setAttribute('aria-label', this.getAttribute('label') || this.#text.textContent);
      if (this.disabled) this.#label.classList.remove('dragover');
    }

    #change = () => {
      if (this.disabled || this.#input.disabled) return;
      const files = Array.from(this.#input.files || []);
      this.#input.value = '';
      if (files.length) this.#emit(Promise.resolve(files));
    };

    #emit(files) {
      files.catch(() => {});
      this.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, composed: true, detail: { files } }));
      this.#handler?.(files);
    }
  }, view);
}

export function createFileField(config = {}, doc = globalThis.document) {
  defineFileField(doc.defaultView);
  const field = doc.createElement('nd-file-field');
  const attributes = { 'input-id': config.id, name: config.name, text: config.text, label: config.label, kind: config.kind, accept: config.accept };
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) field.setAttribute(name, value);
  }
  if (config.rootId) field.id = config.rootId;
  if (config.multiple === false) field.setAttribute('multiple', 'false');
  if (config.directory) field.setAttribute('directory', '');
  if (config.disabled) field.disabled = true;
  if (config.html) {
    field.text.innerHTML = config.html;
    if (!config.label) field.input.setAttribute('aria-label', field.text.textContent);
  }
  return field;
}
