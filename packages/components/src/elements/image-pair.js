import { defineElement, upgradeProperties } from './define.js';
import { createExampleSelector } from './example-selector.js';
import { bindFileDrop } from '../ui/bindFileDrop.js';
import { bindInfoTooltips, renderInfoIcon } from '../ui/bindInfoTooltips.js';
import { templateAsset } from '../ui/templates.js';
import { fetchModel } from '../worker/fetchModel.js';

export const IMAGE_SLOTS = Object.freeze(['fixed', 'moving']);
const TITLES = { fixed: 'Fixed image', moving: 'Moving image' };
const TEMPLATE_CACHE = 'neurodesk-templates';

/**
 * The fixed and moving inputs of a registration app. The element owns the
 * slot state, the example, the built-in templates, swap and clear; the app
 * owns reading and display through three hooks:
 *
 *   read(files, { slot, signal })        → candidates (one per series), each { name, … }
 *   open(slot, candidate, { signal })    → { name, dims, spacingMm, dimensionality, note?, brainExtracted? }
 *   clear(slot)                          → empties that slot's viewer
 *
 * `open` shows the image and describes it. When it throws, the element
 * reopens the previous image (or clears the slot), so a failed load never
 * replaces a good one. `perform(message, task)` runs each operation under the
 * app's busy state and footer status; it must return or throw what `task`
 * does. A change emits `nd-image-pair-change` and calls `onChange`.
 */
export function defineImagePair(view = globalThis.window) {
  return defineElement('nd-image-pair', window => class extends window.HTMLElement {
    #state = { fixed: null, moving: null };
    #parts = {};
    #error = '';
    #initialized = false;
    #drops = [];
    #example;
    #queue = Promise.resolve();

    static get observedAttributes() {
      return ['disabled'];
    }

    connectedCallback() {
      upgradeProperties(this, ['examples', 'templates', 'lockedFixed', 'slotHelp', 'read', 'open', 'clear', 'validatePair', 'perform', 'onChange', 'onStatus', 'fetchTemplate', 'disabled']);
      this.#initialize();
    }

    disconnectedCallback() {
      for (const drop of this.#drops.splice(0)) drop.destroy();
      this.#initialized = false;
    }

    attributeChangedCallback() {
      this.#refresh();
    }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }

    get fixed() { return this.#state.fixed; }
    get moving() { return this.#state.moving; }
    get ready() { return Boolean(this.#state.fixed && this.#state.moving && !this.#error); }
    get error() { return this.#error; }
    get exampleControl() { return this.#example; }

    /** Read files into a slot, as the picker and a drop do. */
    load(slot, files) {
      return this.#operation(`Reading the ${slot} image · converting DICOM if needed…`, signal => this.#loadFiles(slot, files, signal));
    }

    /** Put one already-read candidate into a slot, as automation and an app action do. */
    use(slot, candidate) {
      return this.#operation(`Loading the ${slot} image…`, signal => this.#commit(slot, [candidate], 0, signal));
    }

    /**
     * `use` and `load` for a caller already inside its own busy operation,
     * such as an automation run: no second `perform`, and failures throw.
     */
    async useWithin(slot, candidate, signal) {
      await this.#commit(slot, [candidate], 0, signal);
    }

    async loadWithin(slot, files, signal) {
      await this.#loadFiles(slot, files, signal);
    }

    reset(slot) {
      if (slot === 'fixed' && this.lockedFixed) return;
      this.#example?.reset();
      this.#state[slot] = null;
      this.clear?.(slot);
      this.#changed(slot);
    }

    swap() {
      if (this.lockedFixed) return Promise.resolve();
      return this.#operation('Swapping the fixed and moving images…', signal => this.#swap(signal));
    }

    #initialize() {
      if (this.#initialized) return;
      this.#initialized = true;
      if (!this.#parts.fixed) this.#render();
      for (const slot of IMAGE_SLOTS) {
        const parts = this.#parts[slot];
        if (parts.section && !this.#isLocked(slot)) {
          this.#drops.push(bindFileDrop(parts.section, files => void this.load(slot, files), this.ownerDocument, () => this.disabled));
        }
      }
      if (this.lockedFixed && !this.#state.fixed) this.#state.fixed = lockedState(this.lockedFixed);
      this.#refresh();
    }

    #render() {
      const doc = this.ownerDocument;
      this.classList.add('nd-image-pair');
      this.dataset.exampleScope = '';
      const children = [];
      if (this.examples?.length) {
        this.#example = createExampleSelector({
          examples: this.examples,
          scope: this,
          // Each card has its own pickers, so the menu lists only the examples.
          fileActions: false,
          onStatus: (message, error) => this.onStatus?.(message, error),
          onLoad: (example, context) => this.#loadExample(example, context),
        }, doc);
        children.push(this.#example);
      }
      for (const slot of IMAGE_SLOTS) {
        this.#parts[slot] = this.#renderSlot(slot);
        children.push(this.#parts[slot].section);
        if (slot === 'fixed' && !this.lockedFixed) {
          this.#parts.swap = element(doc, 'button', { id: 'swapButton', className: 'nd-btn nd-btn-secondary nd-btn-sm', type: 'button' }, '⇅ Swap fixed and moving');
          this.#parts.swap.addEventListener('click', () => void this.swap());
          children.push(this.#parts.swap);
        }
      }
      this.#parts.message = element(doc, 'p', { id: 'pairMessage', className: 'nd-message', role: 'status' });
      this.#parts.message.hidden = true;
      children.push(this.#parts.message);
      this.replaceChildren(...children);
      bindInfoTooltips(this);
    }

    #renderSlot(slot) {
      const doc = this.ownerDocument;
      const locked = this.#isLocked(slot);
      const section = element(doc, 'section', { id: `${slot}Slot`, className: 'nd-image-slot', 'aria-labelledby': `${slot}SlotTitle` });
      section.dataset.slot = slot;
      // The card takes its own drops; the page drop leaves it alone.
      if (!locked) section.dataset.dropTarget = '';
      const header = element(doc, 'div', { className: 'nd-image-slot-header' });
      const title = element(doc, 'span', { id: `${slot}SlotTitle`, className: 'nd-image-slot-title' }, TITLES[slot]);
      header.append(title);
      if (this.slotHelp?.[slot]) header.append(' ', renderInfoIcon(this.slotHelp[slot], { label: `About the ${slot} image` }, doc));
      const clear = element(doc, 'button', { id: `${slot}Clear`, className: 'nd-btn-icon nd-btn-icon-sm nd-image-slot-clear', type: 'button', 'aria-label': `Clear the ${slot} image`, title: `Clear the ${slot} image` }, '×');
      clear.hidden = true;
      clear.addEventListener('click', () => this.reset(slot));
      header.append(clear);
      const info = element(doc, 'p', { id: `${slot}Info`, className: 'nd-file-info', 'aria-live': 'polite' });
      info.hidden = true;
      const hint = element(doc, 'p', { id: `${slot}Hint`, className: 'nd-hint' });
      hint.hidden = true;
      const parts = { section, clear, info, hint };
      if (locked) {
        section.classList.add('locked');
        section.append(header, info);
        return parts;
      }
      const actions = element(doc, 'div', { className: 'nd-row nd-image-slot-actions' });
      parts.input = this.#picker(actions, `${slot}Input`, `Load ${slot} image…`, `Load ${slot} image`, slot, false);
      parts.folder = this.#picker(actions, `${slot}FolderInput`, 'Folder…', `Load ${slot} image folder`, slot, true);
      section.append(header, info, actions);
      if (slot === 'fixed' && this.templates?.length) {
        const field = element(doc, 'div', { id: 'fixedTemplateField', className: 'nd-field' });
        const label = element(doc, 'label', { htmlFor: 'fixedTemplate' }, 'Template');
        const licences = this.templates.map(entry => `${entry.label}: ${entry.license}.`).join(' ');
        label.append(' ', renderInfoIcon(`Built-in fixed images. ${licences}`, { label: 'About the templates' }, doc));
        const select = element(doc, 'select', { id: 'fixedTemplate' });
        select.append(new window.Option('Choose a template…', ''));
        for (const entry of this.templates) select.append(new window.Option(entry.label, entry.id));
        select.addEventListener('change', () => {
          const entry = this.templates.find(item => item.id === select.value);
          if (entry) void this.#operation(`Loading the ${entry.label} template…`, signal => this.#loadTemplate(entry, signal));
        });
        field.append(label, select);
        section.append(field);
        parts.template = select;
      }
      const seriesField = element(doc, 'div', { id: `${slot}SeriesField`, className: 'nd-field' });
      seriesField.hidden = true;
      const series = element(doc, 'select', { id: `${slot}Series` });
      seriesField.append(element(doc, 'label', { htmlFor: `${slot}Series` }, `${slot === 'fixed' ? 'Fixed' : 'Moving'} series`), series);
      series.addEventListener('change', () => {
        const state = this.#state[slot];
        if (!state) return;
        const index = Number(series.value);
        void this.#operation(`Loading the ${slot} series…`, signal => this.#commit(slot, state.series, index, signal));
      });
      section.append(seriesField, hint);
      Object.assign(parts, { series, seriesField });
      return parts;
    }

    #picker(parent, id, text, label, slot, directory) {
      const doc = this.ownerDocument;
      const wrapper = element(doc, 'label', { className: 'nd-file nd-file-button', htmlFor: id });
      const input = element(doc, 'input', { id, type: 'file', multiple: true, 'aria-label': label });
      input.dataset.neurodeskInput = 'image';
      if (directory) {
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
      }
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length && !this.disabled) void this.load(slot, Promise.resolve(files));
      });
      wrapper.append(input, element(doc, 'span', {}, text));
      parent.append(wrapper);
      return input;
    }

    #isLocked(slot) {
      return slot === 'fixed' && Boolean(this.lockedFixed);
    }

    // Loads run one at a time, so a drop of two scans fills both slots in turn.
    // After any outcome the controls show the image the slot really holds.
    #enqueue(task) {
      const run = this.#queue.then(task);
      this.#queue = run.catch(() => {});
      return run;
    }

    #operation(message, task) {
      if (this.disabled) return Promise.resolve();
      this.#example?.reset();
      return this.#enqueue(async () => {
        try {
          await this.#perform(message, task);
        } catch (error) {
          if (error?.name !== 'AbortError') this.onStatus?.(error?.message || String(error), true);
        } finally {
          this.#refresh();
          this.#report();
        }
      });
    }

    // Tell the page drop which slots hold an image, so a dropped scan goes to an empty one.
    #report() {
      for (const slot of IMAGE_SLOTS) {
        const input = this.#parts[slot]?.input;
        if (!input) continue;
        const file = this.#state[slot]?.candidate?.file;
        input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: file ? [file] : [] } }));
      }
    }

    #perform(message, task) {
      if (this.perform) return this.perform(message, task);
      this.onStatus?.(message);
      return task(undefined);
    }

    async #loadFiles(slot, files, signal) {
      const read = this.read ?? (list => list.map(file => ({ name: file.name, file })));
      const candidates = await read(await files, { slot, signal });
      signal?.throwIfAborted();
      if (!candidates?.length) throw new Error(`Choose a ${slot} image: NIfTI files or a complete DICOM series.`);
      await this.#commit(slot, candidates, 0, signal);
    }

    async #loadTemplate(entry, signal) {
      const file = await (this.fetchTemplate ?? fetchTemplateFile)(entry, { signal, window });
      signal?.throwIfAborted();
      await this.#commit('fixed', [{ name: entry.filename, file, template: entry, brainExtracted: entry.brainExtracted }], 0, signal);
    }

    async #loadExample(example, { fetchFiles, assertCurrent, signal }) {
      const files = await fetchFiles();
      assertCurrent();
      const byRole = Object.fromEntries(example.files.map((asset, index) => [asset.role, { asset, file: files[index] }]));
      const slots = IMAGE_SLOTS.filter(slot => byRole[slot] && !this.#isLocked(slot));
      if (!slots.length) throw new Error(`${example.label} has no fixed or moving image.`);
      // The selector reports a failure itself, so this task rethrows instead of reporting.
      await this.#enqueue(() => this.#perform(`Loading ${example.label}…`, async taskSignal => {
        const loadSignal = taskSignal ? AbortSignal.any([taskSignal, signal]) : signal;
        for (const slot of slots) {
          const { asset, file } = byRole[slot];
          const read = this.read ?? (list => list.map(item => ({ name: item.name, file: item })));
          const candidates = await read([file], { slot, signal: loadSignal });
          assertCurrent();
          if (!candidates?.length) throw new Error(`The example ${slot} image could not be read.`);
          if (asset.brainExtracted !== undefined) candidates[0].brainExtracted = asset.brainExtracted;
          await this.#commit(slot, candidates, 0, loadSignal);
          assertCurrent();
        }
      }).finally(() => {
        this.#refresh();
        this.#report();
      }));
    }

    async #commit(slot, series, index, signal) {
      if (this.#isLocked(slot)) throw new Error('The fixed image is the built-in template.');
      const candidate = series[index];
      const previous = this.#state[slot];
      let image;
      try {
        image = await this.open(slot, candidate, { signal });
        signal?.throwIfAborted();
      } catch (error) {
        await this.#restore(slot, previous);
        throw error;
      }
      this.#state[slot] = {
        candidate,
        series,
        index,
        image: {
          ...image,
          // A template is summarised by its catalogue label, as a locked template is.
          name: candidate.template?.label ?? image?.name,
          brainExtracted: image?.brainExtracted ?? candidate.brainExtracted,
        },
      };
      this.#changed(slot);
    }

    async #restore(slot, previous) {
      try {
        if (previous) await this.open(slot, previous.candidate, {});
        else await this.clear?.(slot);
      } catch { /* The original failure is the one to report. */ }
    }

    async #swap(signal) {
      const { fixed, moving } = this.#state;
      if (!fixed && !moving) return;
      try {
        if (moving) await this.open('fixed', moving.candidate, { signal });
        else await this.clear?.('fixed');
        if (fixed) await this.open('moving', fixed.candidate, { signal });
        else await this.clear?.('moving');
        signal?.throwIfAborted();
      } catch (error) {
        await this.#restore('fixed', fixed);
        await this.#restore('moving', moving);
        throw error;
      }
      this.#state = { fixed: moving, moving: fixed };
      this.#changed('fixed');
    }

    #changed(slot) {
      this.#error = this.#validate();
      this.#refresh();
      this.#report();
      const detail = { slot, fixed: this.#state.fixed, moving: this.#state.moving, ready: this.ready, error: this.#error };
      this.onChange?.(detail);
      this.dispatchEvent(new window.CustomEvent('nd-image-pair-change', { bubbles: true, composed: true, detail }));
    }

    #validate() {
      const fixed = this.#state.fixed?.image;
      const moving = this.#state.moving?.image;
      if (!fixed || !moving) return '';
      if (fixed.dimensionality && moving.dimensionality && fixed.dimensionality !== moving.dimensionality) {
        return `The fixed image is ${fixed.dimensionality}D and the moving image is ${moving.dimensionality}D; choose two ${moving.dimensionality}D images.`;
      }
      return this.validatePair?.(this.#state.fixed, this.#state.moving) || '';
    }

    #hint() {
      const fixed = this.#state.fixed?.image;
      const moving = this.#state.moving?.image;
      if (typeof fixed?.brainExtracted !== 'boolean' || typeof moving?.brainExtracted !== 'boolean') return '';
      if (fixed.brainExtracted === moving.brainExtracted) return '';
      return fixed.brainExtracted
        ? 'The fixed image is brain only; the moving image is not brain extracted.'
        : 'The moving image is brain only; the fixed image is not brain extracted.';
    }

    #refresh() {
      if (!this.#parts.fixed) return;
      const disabled = this.disabled;
      for (const slot of IMAGE_SLOTS) {
        const parts = this.#parts[slot];
        const state = this.#state[slot];
        parts.section.classList.toggle('has-files', Boolean(state));
        parts.info.hidden = !state;
        parts.info.replaceChildren(...(state ? describe(this.ownerDocument, state.image) : []));
        parts.clear.hidden = !state || this.#isLocked(slot);
        parts.clear.disabled = disabled;
        if (this.#isLocked(slot)) continue;
        parts.input.disabled = disabled;
        parts.folder.disabled = disabled;
        const series = state?.series ?? [];
        parts.seriesField.hidden = series.length < 2;
        if (series.length >= 2) {
          if (parts.seriesSource !== series) {
            parts.series.replaceChildren(...series.map((item, index) => new window.Option(item.name, String(index))));
            parts.seriesSource = series;
          }
          parts.series.value = String(state.index);
        }
        parts.series.disabled = disabled;
      }
      const template = this.#parts.fixed.template;
      if (template) {
        const movingDimensionality = this.#state.moving?.image?.dimensionality;
        const mismatch = movingDimensionality && !this.templates.some(entry => entry.dimensionality === movingDimensionality);
        template.value = this.#state.fixed?.candidate?.template?.id ?? '';
        template.disabled = disabled || Boolean(mismatch);
        const hint = this.#parts.fixed.hint;
        hint.hidden = !mismatch;
        hint.textContent = mismatch ? `Templates are ${this.templates[0].dimensionality}D; the moving image is ${movingDimensionality}D.` : '';
      }
      if (this.#parts.swap) this.#parts.swap.disabled = disabled || (!this.#state.fixed && !this.#state.moving);
      this.#example?.setDisabled(disabled);
      const message = this.#error || this.#hint();
      this.#parts.message.hidden = !message;
      this.#parts.message.textContent = message;
      this.#parts.message.classList.toggle('error', Boolean(this.#error));
      this.#parts.message.classList.toggle('warning', !this.#error && Boolean(message));
    }
  }, view);
}

function lockedState(entry) {
  const image = {
    name: entry.label,
    dims: entry.dims,
    spacingMm: entry.spacingMm,
    dimensionality: entry.dimensionality,
    brainExtracted: entry.brainExtracted,
  };
  return { candidate: { name: entry.filename, template: entry }, series: [], index: 0, image, locked: true };
}

function describe(doc, image) {
  const name = element(doc, 'strong', {}, image.name);
  const parts = [];
  if (image.dims?.length) parts.push(image.dims.join('×'));
  if (image.spacingMm?.length) parts.push(`${image.spacingMm.map(formatMm).join('×')} mm`);
  if (image.note) parts.push(image.note);
  return parts.length ? [name, ` · ${parts.join(' · ')}`] : [name];
}

function formatMm(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3)));
}

function element(doc, tag, properties = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (key === 'className' || key === 'htmlFor' || key === 'type' || key === 'id') node[key] = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A catalogue template as a File, checksummed and cached by fetchModel. */
export async function fetchTemplateFile(entry, { signal, window = globalThis, fetch, cache = TEMPLATE_CACHE } = {}) {
  let bytes;
  try {
    bytes = await fetchModel(templateAsset(entry), {
      signal,
      fetch,
      cache,
      requestFailureMessage: `Could not download the ${entry.label} template.`,
    });
  } catch (error) {
    // fetchModel words integrity failures for models; name the template instead.
    if (/^Model (size mismatch|is truncated|SHA-256 mismatch)/.test(error?.message)) {
      throw new Error(`The ${entry.label} template does not match its pinned size and SHA-256.`, { cause: error });
    }
    throw error;
  }
  return new window.File([bytes], entry.filename);
}

export function createImagePair(config = {}, doc = globalThis.document) {
  defineImagePair(doc.defaultView);
  const pair = doc.createElement('nd-image-pair');
  for (const key of ['examples', 'templates', 'lockedFixed', 'slotHelp', 'read', 'open', 'clear', 'validatePair', 'perform', 'onChange', 'onStatus', 'fetchTemplate']) {
    if (config[key] !== undefined) pair[key] = config[key];
  }
  if (config.id) pair.id = config.id;
  return pair;
}
