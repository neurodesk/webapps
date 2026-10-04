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
    #pending = null;
    #onKey = (event) => this.#handleKey(event);

    connectedCallback() {
      this.classList.add('nd-mask-editor');
      this.setAttribute('role', 'group');
      this.setAttribute('aria-label', 'Mask editing');
      this.#sync();
    }

    configure(options) {
      this.#options = options;
      this.#drawing = createDrawingAdapter(options.nv);
    }

    get session() { return this.#session; }

    // Starts run one after another, so a session cancelled while its mask loads has
    // closed its drawing and restored its overlay before the next one touches NiiVue.
    async start(request) {
      if (!this.#drawing) throw new Error('Configure the mask editor with a NiiVue instance first');
      await this.#pending?.catch(() => {});
      const run = this.#open(request);
      this.#pending = run;
      try {
        return await run;
      } finally {
        if (this.#pending === run) this.#pending = null;
      }
    }

    async #open({ stage, file, label = stage, overlayIndex = null, colormap = null }) {
      if (this.#session.state !== 'idle') throw new Error(`Cannot start editing ${stage} while ${this.#session.stage} is open`);
      const opening = { state: 'opening', stage };
      this.#set(opening);
      const overlay = overlayIndex === null ? null : { index: overlayIndex, opacity: this.#drawing.volumeOpacity(overlayIndex) };
      let opened = false;
      try {
        if (overlay) await this.#drawing.setVolumeOpacity(overlay.index, 0);
        const mask = await maskToUint8Nifti(file);
        const labelValues = await distinctLabels(mask);
        opened = await this.#drawing.open(mask);
        if (!opened) throw new Error(`${label} does not share the viewed image's voxel grid`);
        if (this.#session !== opening) {
          await this.#release(overlay);
          return false;
        }
        if (colormap) this.#drawing.setColormap(colormap);
        const choices = labelChoices(labelValues, this.#options.labelNames);
        this.#build(label, choices);
        this.#set({ state: 'editing', stage, file, label, labelValues, choices, tool: 'draw', value: choices[0], brush: DEFAULT_BRUSH, overlay });
        this.#applyTool();
      } catch (error) {
        if (opened) this.#drawing.close();
        if (overlay) await this.#drawing.setVolumeOpacity(overlay.index, overlay.opacity);
        if (this.#session === opening) this.#set(IDLE);
        throw error;
      }
      this.#emit('nd-mask-edit-start', { stage, message: `Editing ${label}. Left-drag paints; Apply keeps the changes.` });
      return true;
    }

    async apply() {
      const session = this.#session;
      if (session.state !== 'editing') return null;
      this.#set({ state: 'applying', stage: session.stage });
      let edited;
      try {
        const name = editedFileName(session.file.name);
        const bytes = await this.#drawing.export();
        edited = new File([name.toLowerCase().endsWith('.gz') ? await gzip(bytes) : bytes], name, { type: 'application/octet-stream' });
      } catch (error) {
        this.#set(session);
        throw error;
      }
      await this.#release(session.overlay);
      this.#emit('nd-mask-edit-apply', { stage: session.stage });
      await this.#options.onApply?.(session.stage, edited, { original: session.file });
      return edited;
    }

    async cancel() {
      const session = this.#session;
      if (session.state === 'opening') {
        this.#set(IDLE);
        return;
      }
      if (session.state !== 'editing') return;
      await this.#release(session.overlay);
      this.#emit('nd-mask-edit-cancel', { stage: session.stage });
      this.#options.onCancel?.(session.stage);
    }

    async #release(overlay) {
      this.#drawing.close();
      this.#set(IDLE);
      if (overlay) await this.#drawing.setVolumeOpacity(overlay.index, overlay.opacity);
    }

    #set(session) {
      const wasActive = this.#session.state === 'editing' || this.#session.state === 'applying';
      this.#session = session;
      const active = session.state === 'editing' || session.state === 'applying';
      const doc = this.ownerDocument;
      if (active && !wasActive) doc.addEventListener('keydown', this.#onKey);
      if (!active && wasActive) doc.removeEventListener('keydown', this.#onKey);
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
      this.#drawing.setTool({ tool, label: value, brushSize: brush });
    }

    #build(label, choices) {
      const doc = this.ownerDocument;
      const names = this.#options.labelNames || {};
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
      const undo = action('Undo', () => this.#drawing.undo(), 'Undo the last stroke (Ctrl+Z)');
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
        this.#drawing.undo();
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
      promise.catch((error) => {
        this.#emit('nd-mask-edit-error', { stage, error });
        this.#options.onError?.(stage, error);
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
