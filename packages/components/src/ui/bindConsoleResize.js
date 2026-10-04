const bindings = new WeakMap();

/** QSMbly's open console height; also the smallest size a user can drag to. */
export const CONSOLE_MIN_HEIGHT = 120;
/** Height the viewer keeps however far the console is enlarged. */
export const CONSOLE_VIEWER_RESERVE = 160;

const STEP = 24;
const PAGE = 96;
const UNMEASURED_MAX = CONSOLE_MIN_HEIGHT * 4;

/**
 * Let the user enlarge an open console (`.nd-console-container` or the legacy
 * `.console-container`). A separator is inserted as the container's first child:
 * drag it, or focus it and use the arrow keys, Page Up/Down, Home and End;
 * double-click restores the default. The height lives in `--nd-console-height`
 * on the container, so it survives collapse and reopen, and the viewer above
 * (the flexible sibling) takes whatever space is left, never less than `reserve`.
 */
export function bindConsoleResize(container, options = {}) {
  if (bindings.has(container)) return bindings.get(container);
  const doc = container.ownerDocument;
  const min = options.min ?? CONSOLE_MIN_HEIGHT;
  const reserve = options.reserve ?? CONSOLE_VIEWER_RESERVE;
  const handle = doc.createElement('div');
  handle.className = 'nd-console-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-label', options.label || 'Resize log');
  handle.setAttribute('title', 'Drag, or use the arrow keys, to resize the log');
  handle.setAttribute('data-console-resizer', '');
  const panel = container.querySelector(':scope > [data-disclosure-panel]');
  if (panel?.id) handle.setAttribute('aria-controls', panel.id);
  container.prepend(handle);
  container.setAttribute('data-console-resizable', '');

  const measured = () => container.getBoundingClientRect?.().height || 0;
  const stored = () => parseFloat(container.style.getPropertyValue('--nd-console-height')) || 0;
  const getHeight = () => stored() || measured() || min;

  // The console may grow until its tallest sibling (the viewer canvas) is down to `reserve`.
  const getMax = () => {
    if (options.max != null) return Math.max(min, options.max);
    const own = measured();
    let viewer = 0;
    for (const sibling of container.parentElement?.children || []) {
      if (sibling !== container) viewer = Math.max(viewer, sibling.getBoundingClientRect?.().height || 0);
    }
    if (!own || !viewer) return UNMEASURED_MAX;
    return Math.max(min, Math.floor(own + viewer - reserve));
  };

  const describe = (height, max) => {
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(height));
    handle.setAttribute('aria-valuetext', `${height} pixels`);
  };

  const setHeight = (value) => {
    const max = getMax();
    const height = Math.round(Math.min(max, Math.max(min, Number(value) || min)));
    const changed = height !== stored();
    container.style.setProperty('--nd-console-height', `${height}px`);
    describe(height, max);
    if (changed) {
      const { CustomEvent } = doc.defaultView;
      container.dispatchEvent(new CustomEvent('nd-console-resize', { bubbles: true, detail: { height } }));
    }
    return height;
  };

  const reset = () => {
    container.style.removeProperty('--nd-console-height');
    describe(min, getMax());
  };

  const onKeyDown = (event) => {
    const current = getHeight();
    const targets = {
      ArrowUp: current + STEP,
      ArrowDown: current - STEP,
      PageUp: current + PAGE,
      PageDown: current - PAGE,
      Home: min,
      End: getMax(),
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    setHeight(targets[event.key]);
  };

  const onPointerDown = (event) => {
    if (event.button) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = getHeight();
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add('dragging');
    const move = (moveEvent) => setHeight(startHeight + startY - moveEvent.clientY);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.classList.remove('dragging');
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  handle.addEventListener('keydown', onKeyDown);
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('dblclick', reset);
  describe(getHeight(), getMax());

  const binding = {
    handle,
    getHeight,
    getMax,
    setHeight,
    reset,
    destroy() {
      handle.remove();
      container.removeAttribute('data-console-resizable');
      bindings.delete(container);
    },
  };
  bindings.set(container, binding);
  return binding;
}

export function unbindConsoleResize(container) {
  bindings.get(container)?.destroy();
}
