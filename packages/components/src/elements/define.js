/** Register in the caller's window so Node imports and separate documents stay independent. */
export function defineElement(name, createClass, view = globalThis.window) {
  if (!view?.customElements) throw new Error(`${name} requires a browser window with custom elements`);
  const existing = view.customElements.get(name);
  if (existing) return existing;
  const Element = createClass(view);
  view.customElements.define(name, Element);
  return Element;
}

export function upgradeProperties(element, names) {
  for (const name of names) {
    if (!Object.hasOwn(element, name)) continue;
    const value = element[name];
    delete element[name];
    element[name] = value;
  }
}
