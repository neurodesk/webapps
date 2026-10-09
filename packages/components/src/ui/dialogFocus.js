/**
 * Focus management for class-toggled overlay dialogs (ModalManager's `.modal-overlay`).
 * Ported from QSMbly (astewartau/qsmbly#139).
 *
 * openDialog() shows the overlay (the `active` class by default), moves focus into it and
 * remembers what had focus before. While it is the topmost open dialog, Tab and Shift+Tab cycle inside it and
 * Escape calls its onEscape callback. closeDialog() hides it and returns focus to the opener.
 * Dialogs can stack (the command preview opens over pipeline settings); only the top one traps.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Open dialogs, bottom to top: { overlay, opener, onEscape }. */
const stack = [];
/** Documents with the keydown listener installed. */
const listening = new WeakSet();

function documentOf(node) {
  return node?.ownerDocument || globalThis.document;
}

function isShown(el, root) {
  const view = documentOf(el)?.defaultView || globalThis;
  for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
    if (node.hidden) return false;
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * The elements Tab can reach inside `root`, in DOM order. Like the browser, an unchecked radio
 * is skipped when another radio in its group is checked.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function getFocusable(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.type === 'radio' && !el.checked && el.name) {
      const radios = [...root.querySelectorAll('input[type="radio"]')];
      if (radios.some((r) => r.name === el.name && r.checked)) return false;
    }
    return isShown(el, root);
  });
}

function topEntry() {
  return stack[stack.length - 1];
}

function focusInto(overlay) {
  const target = overlay.querySelector('[autofocus]') || getFocusable(overlay)[0];
  if (target) {
    target.focus();
    return;
  }
  const dialog = overlay.querySelector('[role="dialog"]') || overlay;
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  dialog.focus();
}

function onKeydown(e) {
  const entry = topEntry();
  if (!entry) return;

  if (e.key === 'Escape') {
    if (e.defaultPrevented || !entry.onEscape) return;
    e.preventDefault();
    entry.onEscape();
    return;
  }

  if (e.key !== 'Tab') return;
  const focusable = getFocusable(entry.overlay);
  const active = documentOf(entry.overlay).activeElement;
  if (focusable.length === 0) {
    e.preventDefault();
    focusInto(entry.overlay);
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const outside = !entry.overlay.contains(active);
  if (e.shiftKey && (outside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (outside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Show a dialog overlay and move focus into it. Calling it again for an open dialog is a no-op.
 * @param {HTMLElement} overlay - The `.modal-overlay` element
 * @param {Object} [opts]
 * @param {() => void} [opts.onEscape] - Called when Escape is pressed while this dialog is on top;
 *   it should close the dialog the same way the close button does.
 * @param {string} [opts.activeClass='active'] - The class that shows the overlay
 */
export function openDialog(overlay, { onEscape, activeClass = 'active' } = {}) {
  if (!overlay) return;
  overlay.classList.add(activeClass);
  if (stack.some((entry) => entry.overlay === overlay)) return;

  const doc = documentOf(overlay);
  if (!listening.has(doc)) {
    doc.addEventListener('keydown', onKeydown);
    listening.add(doc);
  }
  stack.push({ overlay, opener: doc.activeElement, onEscape });
  focusInto(overlay);
}

/**
 * Hide a dialog overlay and, if focus was inside it, return focus to the element that opened it.
 * @param {HTMLElement} overlay
 * @param {Object} [opts]
 * @param {string} [opts.activeClass='active'] - The class that shows the overlay
 */
export function closeDialog(overlay, { activeClass = 'active' } = {}) {
  if (!overlay) return;
  overlay.classList.remove(activeClass);
  const index = stack.findIndex((entry) => entry.overlay === overlay);
  if (index === -1) return;
  const [{ opener }] = stack.splice(index, 1);

  const doc = documentOf(overlay);
  const active = doc.activeElement;
  const focusWasInside = !active || active === doc.body || overlay.contains(active);
  // The opener may have been hidden meanwhile; focusing it would strand focus on an invisible element.
  if (focusWasInside && opener?.isConnected && opener !== doc.body
      && typeof opener.focus === 'function' && isShown(opener, doc.body)) {
    opener.focus();
  }
}
