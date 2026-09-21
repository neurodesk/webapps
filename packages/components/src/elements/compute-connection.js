import { defineElement, upgradeProperties } from './define.js';
import { createComputeClient, describeConnectionError, normalizeBaseUrl } from '../compute/client.js';

let nextId = 0;

/**
 * `nd-compute-connection`: the sidebar panel through which a webapp names the
 * compute server that runs its method. Built from the shared field, row,
 * button and message vocabulary only. Remembers the address and token in
 * localStorage under `storage-key`, reads a `?token=` query parameter once
 * (the server prints such a link when it serves the app itself), and probes
 * the page's own origin so an app served by the compute server connects to it
 * without typing.
 */
export function defineComputeConnection(view = globalThis.window) {
  return defineElement('nd-compute-connection', window => class extends window.HTMLElement {
    static observedAttributes = ['disabled'];
    #address;
    #token;
    #connect;
    #disconnect;
    #message;
    #detail;
    #client = null;
    #info = null;
    #state = 'idle';
    #controller = null;
    #createClient = createComputeClient;
    #autodetect = true;
    #fetch = null;

    connectedCallback() {
      upgradeProperties(this, ['disabled']);
      this.#initialize();
      this.#connect.addEventListener('click', this.#onConnect);
      this.#disconnect.addEventListener('click', this.#onDisconnect);
      this.#restore();
    }

    disconnectedCallback() {
      this.#connect?.removeEventListener('click', this.#onConnect);
      this.#disconnect?.removeEventListener('click', this.#onDisconnect);
      this.#controller?.abort();
    }

    attributeChangedCallback() {
      if (this.#address) this.#sync();
    }

    configure({ createClient, autodetect, fetch } = {}) {
      if (createClient) this.#createClient = createClient;
      if (autodetect !== undefined) this.#autodetect = Boolean(autodetect);
      if (fetch) this.#fetch = fetch;
      return this;
    }

    get disabled() {
      return this.hasAttribute('disabled');
    }

    set disabled(value) {
      this.toggleAttribute('disabled', Boolean(value));
    }

    get state() {
      return this.#state;
    }

    get client() {
      return this.#state === 'connected' || this.#state === 'simulated' ? this.#client : null;
    }

    get info() {
      return this.#info;
    }

    get address() {
      this.#initialize();
      return this.#address.value;
    }

    set address(value) {
      this.#initialize();
      this.#address.value = value ?? '';
    }

    get token() {
      this.#initialize();
      return this.#token.value;
    }

    set token(value) {
      this.#initialize();
      this.#token.value = value ?? '';
    }

    get addressInput() {
      this.#initialize();
      return this.#address;
    }

    get tokenInput() {
      this.#initialize();
      return this.#token;
    }

    get message() {
      this.#initialize();
      return this.#message;
    }

    /** Probe the page's own origin; adopt it when a compute server answers. */
    async detect() {
      if (!this.#autodetect) return false;
      const origin = this.ownerDocument.defaultView?.location?.origin;
      if (!origin || !/^https?:/.test(origin) || this.#address.value) return false;
      try {
        const client = this.#createClient({ baseUrl: origin, fetch: this.#fetch || undefined });
        const info = await client.info();
        if (info?.service !== 'neurodesk-compute') return false;
        this.#address.value = origin;
        this.#persist();
        this.#show('info', `This page is served by a compute server at ${new URL(origin).host}. Enter its access token to connect.`);
        return true;
      } catch {
        return false;
      }
    }

    async connect() {
      this.#initialize();
      this.#controller?.abort();
      const controller = new AbortController();
      this.#controller = controller;
      let baseUrl = '';
      try {
        baseUrl = normalizeBaseUrl(this.#address.value);
      } catch (error) {
        this.#set('error', describeConnectionError(error).message);
        return null;
      }
      this.#address.value = baseUrl;
      this.#set('connecting', `Connecting to ${new URL(baseUrl).host}…`);
      const client = this.#createClient({ baseUrl, token: this.#token.value.trim(), fetch: this.#fetch || undefined });
      try {
        const info = await client.info({ signal: controller.signal });
        if (controller.signal.aborted) return null;
        if (info?.service !== 'neurodesk-compute') throw new Error(`${baseUrl} is not a Neurodesk compute server`);
        if (!Array.isArray(info.tools)) {
          this.#set('error', this.#token.value.trim()
            ? 'The server rejected the access token. Copy the token printed when the server started.'
            : 'The server needs an access token. Copy the token printed when the server started.');
          return null;
        }
        this.#client = client;
        this.#info = info;
        this.#persist();
        this.#set(info.simulated ? 'simulated' : 'connected', this.#describe(info));
        return client;
      } catch (error) {
        if (controller.signal.aborted) return null;
        const pageOrigin = this.ownerDocument.defaultView?.location?.origin || '';
        this.#set('error', describeConnectionError(error, { pageOrigin, baseUrl }).message);
        return null;
      }
    }

    disconnect() {
      this.#controller?.abort();
      this.#client = null;
      this.#info = null;
      this.#set('idle', 'Not connected. Reconstruction runs on the compute server you name here.');
    }

    setDisabled(value) {
      this.disabled = value;
    }

    #describe(info) {
      const tool = info.tools?.[0];
      const gpu = info.gpu?.available ? (info.gpu.name || 'GPU available') : 'no GPU visible';
      const parts = [`Connected to ${new URL(this.#client.baseUrl).host}`];
      if (tool) parts.push(`${tool.id} ${tool.version}`);
      parts.push(`${info.runner || 'unknown runner'}, ${gpu}`);
      const text = parts.join(' · ');
      return info.simulated ? `${text}. Simulated mode: results are placeholders, not reconstructions.` : text;
    }

    #restore() {
      const location = this.ownerDocument.defaultView?.location;
      const storage = this.#storage();
      const key = this.getAttribute('storage-key') || 'nd-compute-connection';
      try {
        const saved = storage ? JSON.parse(storage.getItem(key) || 'null') : null;
        if (saved?.address) this.#address.value = saved.address;
        if (saved?.token) this.#token.value = saved.token;
      } catch {
        storage?.removeItem(key);
      }
      if (location?.search) {
        const params = new URLSearchParams(location.search);
        const token = params.get('token');
        if (token) {
          this.#token.value = token;
          if (!this.#address.value) this.#address.value = location.origin;
          params.delete('token');
          const query = params.toString();
          this.ownerDocument.defaultView.history?.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
          this.#persist();
        }
      }
      if (!this.#address.value) void this.detect();
    }

    #persist() {
      const storage = this.#storage();
      if (!storage) return;
      const key = this.getAttribute('storage-key') || 'nd-compute-connection';
      storage.setItem(key, JSON.stringify({ address: this.#address.value, token: this.#token.value }));
    }

    #storage() {
      try {
        return this.ownerDocument.defaultView?.localStorage || null;
      } catch {
        return null;
      }
    }

    #set(state, message) {
      this.#state = state;
      this.dataset.state = state;
      const tone = { connected: 'success', simulated: 'warning', error: 'error', connecting: 'info', idle: '', info: 'info' }[state] ?? '';
      this.#show(tone, message);
      this.#sync();
      this.dispatchEvent(new window.CustomEvent('nd-compute-change', {
        bubbles: true,
        composed: true,
        detail: { state, client: this.client, info: this.#info },
      }));
    }

    #show(tone, message) {
      this.#message.className = `nd-message${tone ? ` ${tone}` : ''}`;
      this.#message.textContent = message;
    }

    #sync() {
      const busy = this.#state === 'connecting';
      const connected = this.#state === 'connected' || this.#state === 'simulated';
      this.#address.disabled = this.disabled || busy || connected;
      this.#token.disabled = this.disabled || busy || connected;
      this.#connect.disabled = this.disabled || busy;
      this.#connect.hidden = connected;
      this.#disconnect.hidden = !connected;
      this.#disconnect.disabled = this.disabled;
    }

    #initialize() {
      if (this.#address) return;
      const doc = this.ownerDocument;
      const id = `nd-compute-${++nextId}`;
      const field = (label, input, hint) => {
        const wrapper = doc.createElement('div');
        wrapper.className = 'nd-field';
        const text = doc.createElement('label');
        text.htmlFor = input.id;
        text.textContent = label;
        wrapper.append(text, input);
        if (hint) {
          const help = doc.createElement('p');
          help.className = 'nd-hint';
          help.textContent = hint;
          wrapper.append(help);
        }
        return wrapper;
      };
      this.#address = doc.createElement('input');
      this.#address.type = 'text';
      this.#address.id = `${id}-address`;
      this.#address.placeholder = 'https://compute.clinic.local:8765';
      this.#address.autocomplete = 'url';
      this.#address.spellcheck = false;
      this.#token = doc.createElement('input');
      this.#token.type = 'password';
      this.#token.id = `${id}-token`;
      this.#token.autocomplete = 'off';
      this.#token.placeholder = 'Token printed by neurodesk-compute';
      this.#connect = doc.createElement('button');
      this.#connect.type = 'button';
      this.#connect.className = 'nd-btn nd-btn-secondary';
      this.#connect.textContent = 'Connect';
      this.#disconnect = doc.createElement('button');
      this.#disconnect.type = 'button';
      this.#disconnect.className = 'nd-btn nd-btn-secondary';
      this.#disconnect.textContent = 'Disconnect';
      this.#disconnect.hidden = true;
      const row = doc.createElement('div');
      row.className = 'nd-row';
      row.append(this.#connect, this.#disconnect);
      this.#message = doc.createElement('p');
      this.#message.className = 'nd-message';
      this.#message.setAttribute('role', 'status');
      this.#message.textContent = 'Not connected. Reconstruction runs on the compute server you name here.';
      this.#detail = doc.createElement('p');
      this.#detail.className = 'nd-hint';
      this.#detail.hidden = true;
      this.append(
        field('Server address', this.#address, 'The address printed when neurodesk-compute starts, for example https://192.168.1.20:8765.'),
        field('Access token', this.#token),
        row,
        this.#message,
        this.#detail,
      );
      this.dataset.state = this.#state;
      this.#sync();
      this.#address.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.connect();
        }
      });
      this.#token.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.connect();
        }
      });
    }

    #onConnect = () => {
      void this.connect();
    };

    #onDisconnect = () => {
      this.disconnect();
    };
  }, view);
}

export function createComputeConnection(config = {}, doc = globalThis.document) {
  defineComputeConnection(doc.defaultView);
  const element = doc.createElement('nd-compute-connection');
  if (config.id) element.id = config.id;
  if (config.storageKey) element.setAttribute('storage-key', config.storageKey);
  element.configure(config);
  if (config.disabled) element.disabled = true;
  return element;
}
