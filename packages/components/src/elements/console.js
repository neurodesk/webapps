import { createElement } from '../core/dom.js';
import { ConsoleOutput } from '../ui/ConsoleOutput.js';
import { bindSectionDisclosure, unbindSectionDisclosure } from '../ui/bindSectionDisclosures.js';
import { bindConsoleResize, unbindConsoleResize } from '../ui/bindConsoleResize.js';
import { defineElement, upgradeProperties } from './define.js';

let nextId = 0;

/** `"analysis:Analysis,technical:Technical"`, `['analysis']` or `[{ id, label }]` become `[{ id, label }]`. */
function normalizeChannels(value) {
  const entries = typeof value === 'string' ? value.split(',') : value || [];
  return entries.map((entry) => {
    if (typeof entry !== 'string') return { id: String(entry.id), label: entry.label || String(entry.id) };
    const [id, label] = entry.split(':').map((part) => part.trim());
    return { id, label: label || `${id.charAt(0).toUpperCase()}${id.slice(1)}` };
  }).filter((channel) => channel.id);
}

export function defineConsole(view) {
  return defineElement('nd-console', createConsoleClass, view);
}

function createConsoleClass(view) {
  return class NeurodeskConsole extends view.HTMLElement {
    static observedAttributes = ['collapsed', 'label', 'max-lines', 'resizable'];

    #panel;
    #channels = new Map();
    #active;
    #tabs;
    #title;
    #observer;
    #copyTimer;
    #copyGeneration = 0;

    connectedCallback() {
      this.initialize();
      upgradeProperties(this, ['collapsed', 'resizable']);
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
      if (!this.#panel) return;
      if (name === 'collapsed') this.classList.toggle('collapsed', this.collapsed);
      if (name === 'label') this.#title.textContent = this.getAttribute('label') || this.#defaultLabel();
      if (name === 'max-lines') {
        for (const channel of this.#channels.values()) channel.console.maxLines = this.#maxLines();
      }
      if (name === 'resizable') this.#syncResizable();
    }

    get collapsed() { return this.hasAttribute('collapsed'); }
    set collapsed(value) {
      this.toggleAttribute('collapsed', Boolean(value));
      this.classList.toggle('collapsed', Boolean(value));
    }
    get resizable() { return this.hasAttribute('resizable'); }
    set resizable(value) { this.toggleAttribute('resizable', Boolean(value)); }
    /** The visible log: the only one, or the selected channel's. */
    get output() { this.initialize(); return this.#channels.get(this.#active).output; }
    get console() { this.initialize(); return this.#channels.get(this.#active).console; }
    get channels() { this.initialize(); return [...this.#channels.keys()]; }
    get activeChannel() { this.initialize(); return this.#active; }

    #maxLines() {
      const value = Number(this.getAttribute('max-lines'));
      return Number.isInteger(value) && value > 0 ? value : 1000;
    }

    #defaultLabel() { return this.#channels.size > 1 ? 'Log' : 'Technical log'; }

    #syncResizable() {
      if (this.resizable) bindConsoleResize(this);
      else unbindConsoleResize(this);
    }

    #entry(channel) {
      const entry = this.#channels.get(channel ?? this.#active);
      if (!entry) throw new Error(`Unknown console channel: ${channel}`);
      return entry;
    }

    initialize(config = {}) {
      if (this.#panel) return;
      const doc = this.ownerDocument;
      this.id ||= config.id || `nd-console-${++nextId}`;
      if (config.title) this.setAttribute('label', config.title);
      if (config.maxLines != null) this.setAttribute('max-lines', String(config.maxLines));
      if (config.collapsed !== undefined) this.toggleAttribute('collapsed', config.collapsed);
      if (config.resizable !== undefined) this.toggleAttribute('resizable', Boolean(config.resizable));
      this.classList.add('nd-console-container');
      this.classList.toggle('collapsed', this.collapsed);
      this.setAttribute('data-disclosure', '');
      const declared = normalizeChannels(config.channels ?? this.getAttribute('channels'));
      const mirrorToConsole = config.mirrorToConsole ?? false;
      const addChannel = (channel, outputId) => {
        const output = createElement('div', {
          className: 'nd-console-output', id: outputId,
          'aria-label': config.outputLabel || 'Processing log', ownerDocument: doc,
        });
        const log = new ConsoleOutput({ element: output, mirrorToConsole, maxLines: this.#maxLines() });
        this.#channels.set(channel.id, { ...channel, output, console: log });
        return output;
      };
      if (declared.length > 1) {
        // One log per channel behind tabs; the disclosure panel wraps them so collapsing hides all.
        this.#panel = createElement('div', {
          className: 'nd-console-panels', id: `${this.id}Panels`, 'data-disclosure-panel': '', ownerDocument: doc,
        });
        this.#tabs = createElement('div', { className: 'nd-console-tabs', role: 'tablist', ownerDocument: doc });
        for (const channel of declared) {
          const output = addChannel(channel, `${this.id}Output-${channel.id}`);
          const tab = createElement('button', {
            type: 'button', className: 'nd-console-tab', id: `${this.id}Tab-${channel.id}`, role: 'tab',
            'aria-controls': output.id, 'data-console-channel': channel.id, text: channel.label, ownerDocument: doc,
          });
          tab.addEventListener('click', () => {
            this.selectChannel(channel.id);
            this.open();
          });
          output.setAttribute('role', 'tabpanel');
          output.setAttribute('aria-label', `${channel.label} log`);
          output.setAttribute('data-console-channel', channel.id);
          this.#channels.get(channel.id).tab = tab;
          this.#tabs.append(tab);
          this.#panel.append(output);
        }
        this.#tabs.addEventListener('keydown', (event) => this.#onTabKey(event));
      } else {
        const channel = declared[0] || { id: 'log', label: 'Technical log' };
        this.#panel = addChannel(channel, config.outputId || `${this.id}Output`);
        this.#panel.setAttribute('data-disclosure-panel', '');
      }
      this.#title = createElement('button', {
        type: 'button', className: 'nd-console-title', 'data-disclosure-toggle': '',
        text: this.getAttribute('label') || this.#defaultLabel(), ownerDocument: doc,
      });
      this.#tabs?.setAttribute('aria-label', 'Log type');
      const actions = createElement('div', { className: 'nd-console-actions', ownerDocument: doc });
      const header = createElement('div', { className: 'nd-console-header', ownerDocument: doc });
      header.append(...[this.#title, this.#tabs, actions].filter(Boolean));
      this.append(header, this.#panel);
      this.selectChannel(this.#channels.has(config.channel) ? config.channel : this.#channels.keys().next().value);
      if (config.copy !== false) {
        const button = createElement('button', {
          id: config.copyId || `${this.id}Copy`, type: 'button', className: 'nd-console-clear',
          text: 'Copy', 'data-console-copy': '', ownerDocument: doc,
        });
        button.addEventListener('click', async () => {
          const generation = ++this.#copyGeneration;
          const copied = await this.console.copyToClipboard().catch(() => false);
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
      this.#title.setAttribute('aria-controls', this.#panel.id);
      this.#title.setAttribute('aria-expanded', String(!this.collapsed));
      this.#panel.hidden = this.collapsed;
      this.#panel.inert = this.collapsed;
      this.#syncResizable();
    }

    #onTabKey(event) {
      const ids = this.channels;
      const index = ids.indexOf(event.target.getAttribute?.('data-console-channel'));
      const next = {
        ArrowRight: (index + 1) % ids.length,
        ArrowLeft: (index - 1 + ids.length) % ids.length,
        Home: 0,
        End: ids.length - 1,
      }[event.key];
      if (index < 0 || next === undefined) return;
      event.preventDefault();
      this.selectChannel(ids[next]);
      this.#channels.get(ids[next]).tab.focus();
    }

    /** Show one channel's log; Copy and Clear then act on it. */
    selectChannel(id) {
      this.initialize();
      this.#entry(id);
      const changed = this.#active !== undefined && this.#active !== id;
      this.#active = id;
      if (this.#channels.size > 1) {
        for (const [channelId, { tab, output }] of this.#channels) {
          const selected = channelId === id;
          tab.setAttribute('aria-selected', String(selected));
          tab.classList.toggle('active', selected);
          tab.tabIndex = selected ? 0 : -1;
          output.hidden = !selected;
        }
        const { output } = this.#channels.get(id);
        output.scrollTop = output.scrollHeight;
      }
      if (changed) {
        const { CustomEvent } = this.ownerDocument.defaultView;
        this.dispatchEvent(new CustomEvent('nd-console-channel', { bubbles: true, detail: { channel: id } }));
      }
    }

    open() { this.collapsed = false; }
    close() { this.collapsed = true; }
    /** Without `channel` the entry goes to the first channel. An error opens the log on its channel. */
    log(message, level, channel) {
      this.initialize();
      const entry = this.#entry(channel ?? this.channels[0]);
      if (level === 'error') {
        this.selectChannel(entry.id);
        this.open();
      }
      entry.console.log(message, level);
    }
    /** The `ConsoleOutput` behind one channel. */
    channel(id) { this.initialize(); return this.#entry(id).console; }
    clear(channel) { this.initialize(); this.#entry(channel).console.clear(); }
    getText(channel) { this.initialize(); return this.#entry(channel).console.getText(); }
  };
}

export function createConsole(config = {}, doc = globalThis.document) {
  defineConsole(doc.defaultView);
  const element = doc.createElement('nd-console');
  element.initialize({ ...config, collapsed: config.collapsed !== false });
  return element;
}
