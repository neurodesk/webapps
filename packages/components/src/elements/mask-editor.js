import { createElement } from '../core/dom.js';
import { BRUSH_SIZE, clampBrushSize, createDrawingAdapter, distinctLabels, editedFileName, maskToUint8Nifti } from '../viewer/drawing.js';
import { defineElement } from './define.js';

const IDLE = Object.freeze({ state: 'idle' });
const DEFAULT_BRUSH = 3;
const TOOLS = [
  { id: 'draw', text: 'Draw', key: 'd', title: 'Paint the active label (D)' },
  { id: 'erase', text: 'Erase', key: 'e', title: 'Paint background (E)' },
  { id: 'fill', text: 'Fill', key: 'f', title: 'Outline a region; it fills when you release' },
];

export function defineMaskEditor(view = globalThis.window) {
  return defineElement('nd-mask-editor', createMaskEditorClass, view);
}

function createMaskEditorClass(view) {
  return class NeurodeskMaskEditor extends view.HTMLElement {
    // idle | opening | editing | applying; the toolbar is rendered from it.
    #session = IDLE;
    #options = {};
    #drawing = null;
    #controls = null;
    #owner = null;
    #keyDocument = null;
    #onKey = (event) => this.#handleKey(event);

    connectedCallback() {
      this.classList.add('nd-mask-editor');
      this.setAttribute('role', 'group');
      this.setAttribute('aria-label', 'Mask editing');
      this.#set(this.#session);
    }

    disconnectedCallback() {
      queueMicrotask(() => {
        if (this.isConnected) return;
        this.#keyDocument?.removeEventListener('keydown', this.#onKey);
        this.#keyDocument = null;
        this.#report(this.cancel());
      });
    }

    configure(options) {
      this.#options = { ...options, labelNames: options.labelNames && { ...options.labelNames } };
      this.#drawing = createDrawingAdapter(options.nv);
    }

    get session() { return this.#session; }

    async start(request) {
      if (!this.#drawing) throw new Error('Configure the mask editor with a NiiVue instance first');
      const drawing = this.#drawing;
      const options = this.#options;
      if (this.#owner?.cancelling) await this.#owner.cancelling;
      if (this.#owner) throw new Error(`Cannot start editing ${request.stage} while ${this.#session.stage} is open`);
      const owner = {
        drawing,
        options,
        stage: request.stage,
        cancelled: false,
        committing: false,
        opened: false,
        overlay: null,
        released: null,
        cancelling: null,
        pending: null,
      };
      this.#owner = owner;
      this.#set({ state: 'opening', stage: request.stage });
      owner.pending = Promise.resolve().then(() => this.#open(owner, request));
      return owner.pending;
    }

    async #open(owner, { stage, file, label = stage, overlayIndex = null, colormap = null }) {
      const { drawing, options } = owner;
      try {
        if (owner.cancelled) return false;
        owner.overlay = overlayIndex === null ? null : { index: overlayIndex, opacity: drawing.volumeOpacity(overlayIndex) };
        if (owner.overlay) await drawing.setVolumeOpacity(overlayIndex, 0);
        if (owner.cancelled) return false;
        const mask = await maskToUint8Nifti(file);
        if (owner.cancelled) return false;
        const labelValues = await distinctLabels(mask);
        if (owner.cancelled) return false;
        owner.opened = true;
        owner.opened = await drawing.open(mask);
        if (owner.cancelled) return false;
        if (!owner.opened) throw new Error(`${label} does not share the viewed image's voxel grid`);
        if (colormap) drawing.setColormap(colormap);
        const choices = labelChoices(labelValues, options.labelNames);
        this.#build(label, choices);
        this.#set({ state: 'editing', stage, file, label, labelValues, choices, tool: 'draw', value: choices[0], brush: DEFAULT_BRUSH, overlay: owner.overlay });
        this.#applyTool();
        this.#emit('nd-mask-edit-start', { stage, message: `Editing ${label}. Left-drag paints; Apply keeps the changes.` });
        return true;
      } catch (error) {
        if (!owner.cancelled) {
          try {
            await this.#release(owner);
          } finally {
            this.#finish(owner);
          }
        }
        throw error;
      }
    }

    async apply() {
      const session = this.#session;
      if (session.state !== 'editing') return null;
      const owner = this.#owner;
      this.#set({ state: 'applying', stage: session.stage });
      owner.pending = Promise.resolve().then(() => this.#apply(owner, session));
      return owner.pending;
    }

    async #apply(owner, session) {
      try {
        if (owner.cancelled) return null;
        const name = editedFileName(session.file.name);
        const bytes = await owner.drawing.export();
        if (owner.cancelled) return null;
        const contents = name.toLowerCase().endsWith('.gz') ? await gzip(bytes) : bytes;
        if (owner.cancelled) return null;
        const edited = new File([contents], name, { type: 'application/octet-stream' });
        await this.#release(owner);
        if (owner.cancelled) return null;
        this.#emit('nd-mask-edit-apply', { stage: session.stage });
        if (owner.cancelled) return null;
        owner.committing = true;
        await owner.options.onApply?.(session.stage, edited, { original: session.file });
        return edited;
      } catch (error) {
        if (!owner.cancelled && !owner.released) this.#set(session);
        throw error;
      } finally {
        if (owner.released && !owner.cancelled) this.#finish(owner);
      }
    }

    async cancel() {
      const owner = this.#owner;
      if (!owner) return;
      if (owner.cancelling) return owner.cancelling;
      owner.cancelled = true;
      if (this.#session.state === 'editing') this.#set({ state: 'applying', stage: owner.stage });
      owner.cancelling = Promise.resolve().then(async () => {
        try {
          await owner.pending.catch(() => {});
          await this.#release(owner);
          if (!owner.committing) {
            this.#emit('nd-mask-edit-cancel', { stage: owner.stage });
            await owner.options.onCancel?.(owner.stage);
          }
        } finally {
          this.#finish(owner);
        }
      });
      return owner.cancelling;
    }

    #release(owner) {
      owner.released ??= Promise.resolve().then(async () => {
        try {
          if (owner.opened) owner.drawing.close();
        } finally {
          if (owner.overlay) await owner.drawing.setVolumeOpacity(owner.overlay.index, owner.overlay.opacity);
        }
      });
      return owner.released;
    }

    #finish(owner) {
      if (this.#owner !== owner) return;
      this.#owner = null;
      this.#set(IDLE);
    }

    #set(session) {
      this.#session = session;
      this.#keyDocument?.removeEventListener('keydown', this.#onKey);
      this.#keyDocument = null;
      if (this.isConnected && session.state === 'editing') {
        this.#keyDocument = this.ownerDocument;
        this.#keyDocument.addEventListener('keydown', this.#onKey);
      }
      this.#sync();
    }

    #update(change) {
      if (this.#session.state !== 'editing') return;
      this.#session = { ...this.#session, ...change };
      this.#applyTool();
      this.#sync();
    }

    #applyTool() {
      const { tool, value, brush } = this.#session;
      this.#owner.drawing.setTool({ tool, label: value, brushSize: brush });
    }

    #build(label, choices) {
      const doc = this.ownerDocument;
      const names = this.#owner.options.labelNames || {};
      const tools = TOOLS.map(tool => createElement('button', {
        className: 'nd-tool-btn',
        type: 'button',
        text: tool.text,
        title: tool.title,
        dataset: { tool: tool.id },
        ownerDocument: doc,
        onclick: () => this.#update({ tool: tool.id }),
      }));
      const labelSelect = choices.length > 1 || Object.keys(names).length
        ? createElement('select', { ownerDocument: doc, onchange: (event) => this.#update({ value: Number(event.currentTarget.value) }) },
          choices.map(value => createElement('option', { value, text: names[value] ? `${value} — ${names[value]}` : String(value), ownerDocument: doc })))
        : null;
      const brush = createElement('input', {
        type: 'range',
        min: BRUSH_SIZE.min,
        max: BRUSH_SIZE.max,
        step: 1,
        ownerDocument: doc,
        oninput: (event) => this.#update({ brush: clampBrushSize(event.currentTarget.value) }),
      });
      const brushValue = createElement('span', { ownerDocument: doc });
      const action = (text, onclick, title) => createElement('button', { className: 'nd-btn nd-btn-sm', type: 'button', text, title, ownerDocument: doc, onclick });
      const undo = action('Undo', () => this.#owner.drawing.undo(), 'Undo the last stroke (Ctrl+Z)');
      const apply = action('Apply', () => this.#report(this.apply()), 'Keep the edits and replace the result');
      const cancel = action('Cancel', () => this.#report(this.cancel()), 'Discard the edits');
      this.replaceChildren(...[
        createElement('span', { className: 'nd-viewer-label', text: `Editing ${label}`, ownerDocument: doc }),
        createElement('div', { className: 'nd-tool-group', role: 'group', 'aria-label': 'Edit tool', ownerDocument: doc }, tools),
        labelSelect ? createElement('label', { ownerDocument: doc }, ['Label', labelSelect]) : null,
        createElement('label', { className: 'nd-brush-control', ownerDocument: doc }, ['Brush', brush, brushValue]),
        undo,
        apply,
        cancel,
      ].filter(Boolean));
      this.#controls = { tools, labelSelect, brush, brushValue, buttons: [undo, apply, cancel] };
    }

    #sync() {
      const session = this.#session;
      this.hidden = session.state !== 'editing' && session.state !== 'applying';
      if (this.hidden || !this.#controls) return;
      const busy = session.state === 'applying';
      const { tools, labelSelect, brush, brushValue, buttons } = this.#controls;
      for (const control of [...tools, labelSelect, brush, ...buttons]) {
        if (control) control.disabled = busy;
      }
      if (busy) return;
      for (const button of tools) {
        const active = button.dataset.tool === session.tool;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
      if (labelSelect) labelSelect.value = String(session.value);
      brush.value = String(session.brush);
      brushValue.textContent = String(session.brush);
    }

    #handleKey(event) {
      if (this.#session.state !== 'editing') return;
      if (event.target?.closest?.('input, select, textarea, [contenteditable]')) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.#owner.drawing.undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const tool = TOOLS.find(item => item.key === key);
      if (tool) this.#update({ tool: tool.id });
      else if (key === '[') this.#update({ brush: clampBrushSize(this.#session.brush - 1) });
      else if (key === ']') this.#update({ brush: clampBrushSize(this.#session.brush + 1) });
      else return;
      event.preventDefault();
    }

    // A button has no caller to reject to; the app hears about failures instead.
    #report(promise) {
      const stage = this.#session.stage;
      const options = this.#owner?.options ?? this.#options;
      promise.catch((error) => {
        this.#emit('nd-mask-edit-error', { stage, error });
        options.onError?.(stage, error);
      });
    }

    #emit(name, detail) {
      this.dispatchEvent(new view.CustomEvent(name, { detail, bubbles: true, composed: true }));
    }
  };
}

// Values present in the mask plus any named label, so a missing structure can still be painted.
function labelChoices(present, names = {}) {
  const named = Object.keys(names).map(Number).filter(value => Number.isInteger(value) && value > 0 && value < 256);
  const values = [...new Set([...present, ...named])].sort((a, b) => a - b);
  return values.length ? values : [1];
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function createMaskEditor({ nv, onApply, onCancel, onError, labelNames, doc = globalThis.document } = {}) {
  defineMaskEditor(doc.defaultView);
  const element = doc.createElement('nd-mask-editor');
  element.configure({ nv, onApply, onCancel, onError, labelNames });
  element.hidden = true;
  return element;
}
