import { createElement } from '../core/dom.js';

export function renderSidebarSection(config = {}, doc = globalThis.document) {
  const root = createElement('section', {
    className: `nd-sidebar-section ${config.collapsed ? 'collapsed' : ''} ${config.disabled ? 'nd-step-disabled' : ''}`.trim(),
    id: config.id,
    ownerDocument: doc
  });
  const title = createElement('h2', { className: 'nd-section-title', text: config.title || '', ownerDocument: doc });
  const content = createElement('div', { className: 'nd-section-content', ownerDocument: doc });
  if (config.content?.nodeType) content.appendChild(config.content);
  else if (Array.isArray(config.content)) content.append(...config.content.filter(Boolean));
  else if (config.content) content.textContent = String(config.content);
  title.addEventListener('click', () => root.classList.toggle('collapsed'));
  root.append(title, content);
  return {
    root,
    title,
    content,
    setDisabled(disabled) {
      root.classList.toggle('nd-step-disabled', Boolean(disabled));
    },
    setBadge(text, className = '') {
      let badge = title.querySelector('.nd-step-badge');
      if (!badge) {
        badge = createElement('span', { className: 'nd-step-badge', ownerDocument: doc });
        title.appendChild(badge);
      }
      badge.className = `nd-step-badge ${className}`.trim();
      badge.textContent = text || '';
    }
  };
}
