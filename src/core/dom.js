export function resolveElement(target, fallbackDocument = globalThis.document) {
  if (!target && fallbackDocument) return fallbackDocument.body;
  if (typeof target === 'string') {
    const element = fallbackDocument?.querySelector(target);
    if (!element) throw new Error(`Element not found: ${target}`);
    return element;
  }
  if (target?.nodeType === 1 || target?.nodeType === 9 || target?.nodeType === 11) return target;
  throw new Error('Expected a DOM element or selector');
}

export function createElement(tag, props = {}, children = []) {
  const doc = props.ownerDocument || globalThis.document;
  if (!doc) throw new Error('createElement requires a document');
  const element = doc.createElement(tag);
  const { className, dataset, style, text, html, ownerDocument, ...attrs } = props;

  if (className) element.className = className;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      if (value != null) element.dataset[key] = String(value);
    }
  }
  if (style) Object.assign(element.style, style);
  if (text != null) element.textContent = String(text);
  if (html != null) element.innerHTML = String(html);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }

  appendChildren(element, children);
  return element;
}

export function appendChildren(parent, children = []) {
  const doc = parent.ownerDocument || globalThis.document;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child?.nodeType) {
      parent.appendChild(child);
    } else {
      parent.appendChild(doc.createTextNode(String(child)));
    }
  }
  return parent;
}

export function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

export function setHidden(element, hidden = true) {
  if (!element) return;
  element.classList.toggle('hidden', Boolean(hidden));
  element.hidden = Boolean(hidden);
}
