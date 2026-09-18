const bindings = new WeakMap();

const TOGGLE_SELECTOR = [
  ':scope > .section-title > [data-disclosure-toggle]',
  ':scope > [data-disclosure-toggle]',
  ':scope > .console-header > [data-disclosure-toggle]',
  ':scope > .nd-console-header > [data-disclosure-toggle]',
].join(', ');

/**
 * Bind one class-driven disclosure. The section keeps its `collapsed` and
 * `step-disabled` classes as the source of truth; the binding mirrors them
 * onto aria-expanded, hidden and inert so closed content leaves the tab order
 * without recreating any controls.
 */
export function bindSectionDisclosure(section, root = section.ownerDocument) {
  if (bindings.has(section)) return bindings.get(section).observer;
  const button = section.querySelector(TOGGLE_SELECTOR);
  const panel = section.querySelector(':scope > [data-disclosure-panel]');
  if (!button || !panel) throw new Error('A disclosure needs a toggle button and content panel');
  panel.id ||= `${section.id}-content`;
  button.setAttribute('aria-controls', panel.id);
  const sync = () => {
    const collapsed = section.classList.contains('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed && panel.contains(section.ownerDocument.activeElement)) button.focus();
    panel.hidden = collapsed;
    panel.inert = collapsed || section.classList.contains('step-disabled');
  };
  const toggle = () => {
    if (section.classList.contains('collapsed') && section.dataset.disclosureGroup) {
      for (const other of root.querySelectorAll('[data-disclosure-group]')) {
        if (other !== section && other.dataset.disclosureGroup === section.dataset.disclosureGroup) other.classList.add('collapsed');
      }
    }
    section.classList.toggle('collapsed');
    sync();
  };
  button.addEventListener('click', toggle);
  const observer = new section.ownerDocument.defaultView.MutationObserver(sync);
  observer.observe(section, { attributes: true, attributeFilter: ['class'] });
  bindings.set(section, { observer, button, toggle });
  sync();
  return observer;
}

export function bindSectionDisclosures(root = document) {
  for (const section of root.querySelectorAll('[data-disclosure]')) bindSectionDisclosure(section, root);
}

export function unbindSectionDisclosure(section) {
  const binding = bindings.get(section);
  if (!binding) return;
  binding.observer.disconnect();
  binding.button.removeEventListener('click', binding.toggle);
  bindings.delete(section);
}
