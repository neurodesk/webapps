import { NiiVue, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { mountFreeBrowse } from 'freebrowse';
import freebrowseStyles from 'freebrowse/style.css?inline';
import workspaceStyles from '@neurodesk/webapp-components/styles/imaging-workspace.css?inline';

export function mountViewer(element, options) {
  const shadow = element.shadowRoot || element.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const style = document.createElement('style');
  style.textContent = `${freebrowseStyles}\n${workspaceStyles}`;
  const container = document.createElement('div');
  container.className = 'nd-freebrowse';
  shadow.append(style, container);
  let destroyed = false;
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => reject(new Error('FreeBrowse could not initialize its canvas. Reload the page to retry.')), 30_000);
  void ready.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  // FreeBrowse owns attachment but does not expose its asynchronous completion.
  class EmbeddedNiiVue extends NiiVue {
    async attachToCanvas(canvas, ...args) {
      if (destroyed) return this;
      canvas.id = 'gl1';
      canvas.setAttribute('aria-label', 'Brain image and cortical surface viewer');
      try {
        const result = await super.attachToCanvas(canvas, ...args);
        if (destroyed) this.destroy();
        else resolve(this);
        return result;
      } catch (error) {
        reject(error);
        return this;
      }
    }
  }
  const nv = new EmbeddedNiiVue(options);
  nv.sliceType = SLICE_TYPE.MULTIPLANAR;
  nv.showRender = SHOW_RENDER.ALWAYS;
  const handle = mountFreeBrowse(container, {
    nv,
    backend: null,
    persist: false,
    readUrlParams: false,
    dragDrop: false,
    sidebar: false,
    footer: false,
  });
  const syncHost = () => {
    const root = container.querySelector('.freebrowse-root');
    const dark = document.documentElement.dataset.neurodeskTheme !== 'light';
    if (root && root.classList.contains('dark') !== dark) root.classList.toggle('dark', dark);
    for (const [tab, label] of [['sceneDetails', 'Volumes'], ['surfaceDetails', 'Surfaces'], ['drawing', 'Drawing']]) {
      container.querySelector(`[role="tab"][id$="-trigger-${tab}"]`)?.setAttribute('aria-label', label);
    }
    for (const button of container.querySelectorAll('button:has(svg.lucide-eye), button:has(svg.lucide-eye-off)')) {
      button.setAttribute('aria-label', 'Toggle visibility');
    }
    const inputs = container.querySelectorAll('input[type="file"]');
    inputs.forEach((input, index) => {
      input.dataset.neurodeskInput = index === 0 ? 'image' : 'surface';
    });
  };
  const observer = new MutationObserver(syncHost);
  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-neurodesk-theme'] });
  return {
    nv,
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      reject(new Error('FreeBrowse viewer was closed before initialization completed.'));
      clearTimeout(timeout);
      observer.disconnect();
      handle.destroy();
      nv.destroy();
    },
  };
}
