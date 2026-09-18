import { defineElement, upgradeProperties } from './define.js';

let nextId = 0;

export function defineExampleSelector(view = globalThis.window) {
  return defineElement('nd-example-selector', view => class extends view.HTMLElement {
    #examples = [];
    #onLoad;
    #onStatus = () => {};
    #scope;
    #boundScope;
    #select;
    #message;
    #cancelButton;
    #active = null;

    static get observedAttributes() {
      return ['disabled'];
    }

    connectedCallback() {
      upgradeProperties(this, ['examples', 'onLoad', 'onStatus', 'scope', 'disabled']);
      this.#initialize();
      this.#bindScope();
    }

    disconnectedCallback() {
      this.#unbindScope();
      queueMicrotask(() => {
        if (!this.isConnected) this.cancel();
      });
    }

    attributeChangedCallback() {
      this.#refresh();
    }

    get examples() { return this.#examples; }
    set examples(value) {
      this.cancel();
      this.#examples = value;
      if (this.#select) {
        this.#renderOptions();
        delete this.dataset.exampleId;
        this.dataset.exampleState = 'idle';
        this.#message.textContent = '';
      }
    }

    get onLoad() { return this.#onLoad; }
    set onLoad(value) { this.#onLoad = value; }
    get onStatus() { return this.#onStatus; }
    set onStatus(value) { this.#onStatus = value; }
    get scope() { return this.#scope; }
    set scope(value) {
      this.#scope = value;
      if (this.isConnected) this.#bindScope();
    }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
    get select() {
      this.#initialize();
      return this.#select;
    }

    setDisabled(value) {
      this.disabled = value;
    }

    destroy() {
      this.cancel();
      this.#unbindScope();
      this.remove();
    }

    #initialize() {
      if (this.#select) return;
      const doc = this.ownerDocument;
      this.classList.add('nd-field');
      this.dataset.neurodeskExamples = '';
      this.dataset.exampleState = 'idle';
      const label = doc.createElement('label');
      this.#select = doc.createElement('select');
      this.#select.id = `nd-example-${++nextId}`;
      this.#select.dataset.neurodeskExample = '';
      label.htmlFor = this.#select.id;
      label.textContent = 'Example';
      this.#message = doc.createElement('p');
      this.#message.className = 'nd-hint';
      this.#message.id = `${this.#select.id}-status`;
      this.#message.setAttribute('role', 'status');
      this.#message.setAttribute('aria-live', 'polite');
      this.#select.setAttribute('aria-describedby', this.#message.id);
      this.#cancelButton = doc.createElement('button');
      this.#cancelButton.type = 'button';
      this.#cancelButton.className = 'nd-btn nd-btn-secondary nd-btn-sm';
      this.#cancelButton.textContent = 'Cancel example download';
      this.append(label, this.#select, this.#message, this.#cancelButton);
      this.#renderOptions();
      this.#select.addEventListener('change', () => this.#load());
      this.#cancelButton.addEventListener('click', () => this.cancel());
      this.#refresh();
    }

    #renderOptions() {
      const placeholder = this.ownerDocument.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose an example…';
      this.#select.replaceChildren(placeholder);
      for (const example of this.#examples) {
        const option = this.ownerDocument.createElement('option');
        option.value = example.id;
        option.textContent = example.label;
        this.#select.append(option);
      }
    }

    #bindScope() {
      this.#unbindScope();
      this.#boundScope = this.#scope ?? this.closest('nd-imaging-workspace, .nd-imaging-workspace, [data-example-scope], form, #workspace') ?? this.parentElement;
      this.#boundScope?.addEventListener('change', this.#replaced, true);
      this.#boundScope?.addEventListener('drop', this.#replaced, true);
    }

    #unbindScope() {
      this.#boundScope?.removeEventListener('change', this.#replaced, true);
      this.#boundScope?.removeEventListener('drop', this.#replaced, true);
      this.#boundScope = undefined;
    }

    #replaced = event => {
      if (event.type !== 'drop' && !event.target?.matches('input[type="file"]')) return;
      if (this.#active) this.cancel();
      else {
        delete this.dataset.exampleId;
        this.dataset.exampleState = 'idle';
        this.#message.textContent = '';
      }
    };

    #status(state, text, error = false) {
      this.dataset.exampleState = state;
      this.#message.textContent = text;
      this.#onStatus(text, error);
      this.dispatchEvent(new view.CustomEvent('nd-example-status', {
        bubbles: true,
        composed: true,
        detail: { state, message: text, error },
      }));
    }

    #refresh() {
      if (!this.#select) return;
      this.#select.disabled = this.disabled || this.#active !== null;
      this.#cancelButton.hidden = this.#active === null;
      this.setAttribute('aria-busy', String(this.#active !== null));
    }

    cancel() {
      if (!this.#active) return;
      const job = this.#active;
      this.#active = null;
      job.abort();
      this.#select.value = '';
      delete this.dataset.exampleId;
      this.#refresh();
      this.#status('cancelled', 'Example loading cancelled. Choose an example to retry.');
    }

    async #load() {
      const example = this.#examples.find(item => item.id === this.#select.value);
      if (!example || this.disabled || !this.isConnected) return;
      this.cancel();
      const controller = new AbortController();
      this.#active = controller;
      delete this.dataset.exampleId;
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        if (this.#active !== controller || !this.isConnected) {
          throw new view.DOMException('Example loading cancelled', 'AbortError');
        }
      };
      this.#refresh();
      this.#status('loading', `Loading ${example.label}…`);
      try {
        await this.#onLoad(example, {
          signal: controller.signal,
          assertCurrent,
          async fetchFiles() {
            const files = await Promise.all(example.files.map(async asset => {
              assertCurrent();
              const response = await fetch(asset.url, { signal: controller.signal });
              if (!response.ok) throw new Error(`Could not download ${asset.name} (HTTP ${response.status}).`);
              const bytes = await response.arrayBuffer();
              assertCurrent();
              if (asset.sha256) {
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
                const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
                if (actual !== asset.sha256) throw new Error(`The checksum for ${asset.name} did not match.`);
              }
              assertCurrent();
              return new view.File([bytes], asset.name);
            }));
            assertCurrent();
            return files;
          },
        });
        assertCurrent();
        this.dataset.exampleId = example.id;
        this.#status('ready', `${example.description} ${example.expectedResult}`);
      } catch (error) {
        if (this.#active === controller && !controller.signal.aborted) {
          controller.abort();
          this.#status('error', `${error.message} Choose the example again to retry.`, true);
        }
      } finally {
        if (this.#active === controller) {
          this.#active = null;
          this.#select.value = '';
          this.#refresh();
        }
      }
    }
  }, view);
}

export function createExampleSelector({ examples, onLoad, onStatus = () => {}, scope }, doc = globalThis.document) {
  defineExampleSelector(doc.defaultView);
  const element = doc.createElement('nd-example-selector');
  element.examples = examples;
  element.onLoad = onLoad;
  element.onStatus = onStatus;
  element.scope = scope;
  return element;
}
