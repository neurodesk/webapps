import { defineElement, upgradeProperties } from './define.js';
import { bindInfoTooltips, renderInfoIcon } from '../ui/bindInfoTooltips.js';
import { fetchWithRetry } from '../net/fetchWithRetry.js';
import { fetchModel } from '../worker/fetchModel.js';
import { bindPageDrop, deliverFiles, primaryInput } from '../ui/pageDrop.js';

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
    #info;
    #cancelButton;
    #folder;
    #actionsFor = null;
    #active = null;

    static get observedAttributes() {
      return ['disabled'];
    }

    connectedCallback() {
      upgradeProperties(this, ['examples', 'onLoad', 'onStatus', 'scope', 'disabled']);
      this.#initialize();
      this.#bindScope();
      bindPageDrop(this.ownerDocument);
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
    get uploadScope() { return this.#boundScope; }
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
      // Name the select from this span alone so the info icon below never
      // becomes part of its accessible name ("Example", not "Example About…").
      const name = doc.createElement('span');
      name.id = `${this.#select.id}-label`;
      name.textContent = 'Input';
      name.className = 'nd-sr-only';
      label.append(name);
      this.#select.setAttribute('aria-labelledby', name.id);
      // The loaded example's description and expected result live in a
      // tooltip beside the label; the visible hint stays one short line.
      this.#info = renderInfoIcon('', { label: 'About this example' }, doc);
      this.#info.hidden = true;
      label.append(' ', this.#info);
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
      bindInfoTooltips(this);
      this.#renderOptions();
      this.#folder = doc.createElement('input');
      this.#folder.type = 'file';
      this.#folder.setAttribute('webkitdirectory', '');
      this.#folder.addEventListener('change', () => {
        if (this.#actionsFor && this.#folder.files.length) deliverFiles(this.#actionsFor, [...this.#folder.files]);
        this.#folder.value = '';
      });
      this.#select.addEventListener('change', () => this.#choose());
      this.#select.addEventListener('focus', this.#renderActions);
      this.#select.addEventListener('pointerdown', this.#renderActions);
      this.#cancelButton.addEventListener('click', () => this.cancel());
      this.#refresh();
    }

    #option(text, value = '', action) {
      const node = this.ownerDocument.createElement('option');
      node.value = value;
      node.textContent = text;
      if (action) node.dataset.action = action;
      return node;
    }

    #renderOptions() {
      this.#select.replaceChildren(this.#option('Choose an example…'));
      for (const example of this.#examples) this.#select.append(this.#option(example.label, example.id));
      this.#actionsFor = null;
      this.#renderActions();
    }

    // Actions carry empty values so the options still list exactly the manifest's
    // examples. Apps may add or replace their file field after the selector, so
    // this reruns when the select is focused or pressed.
    #renderActions = () => {
      const input = primaryInput(this.#boundScope ?? this.#scope);
      if (!input) this.#actionsFor = null;
      if (!input || input === this.#actionsFor) return;
      this.#actionsFor?.closest('.nd-file')?.classList.remove('nd-file-merged');
      this.#select.querySelectorAll('hr, option[data-action]').forEach(node => node.remove());
      this.#select.append(this.ownerDocument.createElement('hr'), this.#option('Choose files…', '', 'files'));
      if (input.dataset.neurodeskInput === 'image') this.#select.append(this.#option('Choose folder…', '', 'folder'));
      input.closest('.nd-file')?.classList.add('nd-file-merged');
      this.#actionsFor = input;
    };

    #choose() {
      const action = this.#select.selectedOptions[0]?.dataset.action;
      if (!action) return this.#load();
      this.#select.value = '';
      const input = action === 'folder' ? this.#folder : this.#actionsFor;
      if (!input) return;
      try {
        input.showPicker();
      } catch (error) {
        // A browser that withholds activation from a select's change event refuses the
        // picker; show the drop box again so the user can open it directly.
        if (error?.name !== 'NotAllowedError') return input.click();
        this.#actionsFor?.closest('.nd-file')?.classList.remove('nd-file-merged');
        this.#message.textContent = 'Use the file box below to choose your files.';
      }
    }

    #bindScope() {
      this.#unbindScope();
      this.#boundScope = this.#scope ?? this.closest('nd-imaging-workspace, .nd-imaging-workspace, [data-example-scope], form, #workspace') ?? this.parentElement;
      this.#boundScope?.addEventListener('change', this.#replaced, true);
      this.#boundScope?.addEventListener('drop', this.#replaced, true);
      if (this.#select) this.#renderActions();
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
        this.#describe(null);
      }
    };

    #describe(example) {
      if (!this.#info) return;
      const text = example ? [example.description, example.expectedResult].filter(Boolean).join(' ') : '';
      this.#info.querySelector('.nd-info-tooltip').textContent = text;
      this.#info.hidden = !text;
    }

    #status(state, text, error = false, extra = {}) {
      this.dataset.exampleState = state;
      this.#message.textContent = text;
      this.#onStatus?.(text, error);
      this.dispatchEvent(new view.CustomEvent('nd-example-status', {
        bubbles: true,
        composed: true,
        detail: { state, message: text, error, ...extra },
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
      const onRetry = ({ status, delay }) => {
        if (this.#active === controller) this.#status('loading', `The example host is busy (HTTP ${status}); retrying in ${Math.ceil(delay / 1000)} s…`);
      };
      try {
        await this.#onLoad(example, {
          signal: controller.signal,
          assertCurrent,
          async fetchFiles() {
            const files = await Promise.all(example.files.map(async asset => {
              assertCurrent();
              let bytes;
              try {
                bytes = await fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
                  signal: controller.signal,
                  fetch: async (url, init) => {
                    const response = await fetchWithRetry(url, init, { onRetry });
                    if (!response.ok) throw new Error(`Could not download ${asset.name} (HTTP ${response.status}).`);
                    return response;
                  },
                });
              } catch (error) {
                if (error.message === 'Model SHA-256 mismatch') {
                  throw new Error(`The checksum for ${asset.name} did not match.`, { cause: error });
                }
                throw error;
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
        this.#describe(example);
        this.#status('ready', `${example.label} loaded.`, false, { description: example.description, expectedResult: example.expectedResult });
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
