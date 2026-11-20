// A page opened with a handoff from another app notes where change listeners are bound, so the
// shell's receiver (handoff/receive.js) puts the files on an input only once its app handles
// them. It lives here because this is the one classic script on every page: it runs while the
// page is parsed, before any module, the app's own included.
(() => {
  if (!/[#&]handoff=/.test(window.location.hash)) return;
  const bound = new WeakSet();
  window[Symbol.for('neurodesk.changeListeners')] = bound;
  const add = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    // The shell's own page drop listens in the capture phase; an app's handler does not.
    if (type === 'change' && listener && !(options === true || options?.capture)) bound.add(this);
    return add.call(this, type, listener, options);
  };
})();

// The WebMCP tools (webmcp/tool-inputs.js) must see each action of the person before any listener of
// the page or the shell can stop it. A capture listener on window that is added first runs first, so
// this one hands every such event to the tools, which add their handler to the set when they start.
// The types are tool-inputs.js's INTERACTIONS, which the components tests hold equal.
(() => {
  if (!(document.modelContext ?? navigator.modelContext)) return;
  const handlers = new Set();
  const types = ['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'paste', 'dragenter', 'dragover', 'drop'];
  for (const type of types) {
    window.addEventListener(type, (event) => {
      for (const handler of handlers) handler(event);
    }, true);
  }
  handlers.types = types;
  window[Symbol.for('neurodesk.personInput')] = handlers;
})();

(() => {
  const storageKey = 'neurodesk-theme';
  const root = document.documentElement;

  function storedTheme() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  }

  function syncToggles() {
    const current = root.dataset.neurodeskTheme === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    for (const toggle of document.querySelectorAll('[data-neurodesk-theme-toggle]')) {
      toggle.dataset.neurodeskThemeNext = next;
      toggle.title = `Use ${next} theme`;
      toggle.setAttribute('aria-label', `Use ${next} theme`);
      toggle.setAttribute('aria-pressed', String(current === 'light'));
      const label = toggle.querySelector('[data-neurodesk-theme-label]');
      const nextLabel = next === 'light' ? 'Light' : 'Dark';
      if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
    }
  }

  function applyTheme(theme, { persist = true } = {}) {
    const next = theme === 'light' ? 'light' : 'dark';
    root.dataset.neurodeskTheme = next;
    root.style.colorScheme = next;
    if (persist) {
      try {
        localStorage.setItem(storageKey, next);
      } catch { /* Private browsing can block persistence; the selected in-memory theme still applies. */ }
    }
    syncToggles();
    window.dispatchEvent(new CustomEvent('neurodesk-theme-change', { detail: { theme: next } }));
    return next;
  }

  window.NeurodeskTheme = {
    get: () => root.dataset.neurodeskTheme === 'light' ? 'light' : 'dark',
    set: (theme) => applyTheme(theme),
    toggle: () => applyTheme(root.dataset.neurodeskTheme === 'dark' ? 'light' : 'dark'),
  };

  applyTheme(storedTheme() || root.dataset.neurodeskTheme || 'dark', { persist: false });

  document.addEventListener('click', (event) => {
    const toggle = event.target instanceof Element
      ? event.target.closest('[data-neurodesk-theme-toggle]')
      : null;
    if (!toggle) return;
    window.NeurodeskTheme.toggle();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncToggles);
  else syncToggles();

  new MutationObserver((mutations) => {
    const addedToggle = mutations.some(({ addedNodes }) => [...addedNodes].some((node) => (
      node instanceof Element
      && (node.matches('[data-neurodesk-theme-toggle]')
        || node.querySelector('[data-neurodesk-theme-toggle]'))
    )));
    if (addedToggle) syncToggles();
  }).observe(root, { childList: true, subtree: true });

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey && (event.newValue === 'light' || event.newValue === 'dark')) {
      applyTheme(event.newValue, { persist: false });
    }
  });
})();
