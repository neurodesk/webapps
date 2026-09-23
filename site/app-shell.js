import { resolveShellAdapter } from './shell-adapters/index.js';

(() => {
  const shellScript = document.querySelector('script[data-neurodesk-app-shell]');
  if (!shellScript) return;

  const metadata = {
    id: shellScript.dataset.appId,
    title: shellScript.dataset.appTitle,
    description: shellScript.dataset.appDescription,
    version: shellScript.dataset.appVersion,
    measurementId: shellScript.dataset.ga4MeasurementId,
    analyticsHref: shellScript.dataset.analyticsHref,
    moreAppsHref: shellScript.dataset.moreAppsHref,
    sourceHref: shellScript.dataset.sourceHref,
    url: shellScript.dataset.appUrl,
    shell: shellScript.dataset.appShell,
    standaloneHref: new URL(shellScript.dataset.standaloneHref || 'standalone.json', shellScript.src).href,
    componentsHref: new URL(shellScript.dataset.componentsHref || 'shell-adapters/components/', shellScript.src).href,
  };
  let standaloneStylesReady;

  const informationScript = document.querySelector('script[data-neurodesk-app-information]');
  let information = null;
  try { information = informationScript ? JSON.parse(informationScript.textContent) : null; }
  catch (error) { console.warn('Neurodesk app information could not be parsed:', error); }

  const analyticsUrl = new URL(metadata.analyticsHref, document.baseURI);
  import(/* @vite-ignore */ analyticsUrl.href)
    .then(({ initAnalytics }) => initAnalytics(metadata.measurementId))
    .catch((error) => console.warn('Neurodesk page-view analytics could not start:', error));

  const icons = {
    about: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
    cite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h12a2 2 0 0 1 2 2V21H7a2 2 0 0 1-2-2V3.5Z"/><path d="M7 17h12M9 7h6"/></svg>',
    privacy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s8-3.8 8-10V5l-8-3-8 3v6c0 6.2 8 10 8 10Z"/></svg>',
    standalone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    support: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/><path d="m5.6 5.6 3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/></svg>',
    theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    apps: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    ecosystem: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>',
    github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.84a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  };

  function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text) node.textContent = options.text;
    if (options.title) node.title = options.title;
    if (options.href) node.href = options.href;
    if (options.html) node.innerHTML = options.html;
    return node;
  }

  function versionLabel(value) {
    const clean = String(value || '').trim();
    return clean.startsWith('v') ? clean : `v${clean}`;
  }

  function createAction(label, icon, onClick) {
    const button = element('button', {
      className: 'nd-app-bar__action',
      title: label,
      html: `${icons[icon]}<span>${label}</span>`,
    });
    button.type = 'button';
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  function createControlAction(action, label, icon) {
    const button = createAction(label, icon, () => openAppInformation(action));
    button.dataset.neurodeskShellControl = action;
    return button;
  }

  function createLink(label, icon, href, title) {
    const link = element('a', {
      className: 'nd-app-bar__action',
      title,
      href,
      html: `${icons[icon]}<span>${label}</span>`,
    });
    if (/^https?:/i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return link;
  }

  // Facts a maintainer needs before they can reproduce a browser-native imaging
  // report: the exact build, the browser, and the two capabilities that decide
  // whether an app runs at all. The page address keeps only origin and path,
  // because app state in a query or fragment can name a user's own files.
  function supportDetails() {
    const { crossOriginIsolated, devicePixelRatio, innerHeight, innerWidth, location, navigator } = window;
    return [
      ['App', `${metadata.title} (${metadata.id})`],
      ['Version', document.querySelector('.nd-app-bar__version')?.textContent || versionLabel(metadata.version)],
      ['Page', `${location.origin}${location.pathname}`],
      ['Browser', navigator.userAgent],
      ['Window', `${innerWidth}x${innerHeight} at ${devicePixelRatio}x`],
      ['WebGPU', navigator.gpu ? 'available' : 'unavailable'],
      ['Cross-origin isolated', crossOriginIsolated ? 'yes' : 'no'],
      ['CPU threads', String(navigator.hardwareConcurrency ?? 'unknown')],
    ];
  }

  // One prefilled GitHub issue that serves both a problem report and a feature
  // suggestion. The headings are the questions a maintainer would otherwise
  // have to ask in a follow-up comment.
  function supportIssueHref() {
    const repository = metadata.sourceHref.replace(/\/(?:tree|blob)\/.*$/, '');
    const body = [
      `Thank you for helping improve ${metadata.title}. Fill in the sections that apply and delete the rest.`,
      '',
      '## What happened, or what would you like this app to do?',
      '',
      '',
      '## How can we reproduce the problem?',
      '',
      'Leave this out for a feature suggestion.',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## What did you expect instead?',
      '',
      '',
      '## Which images were you working with?',
      '',
      'Modality, resolution, file format and size. Please do not upload identifiable patient data.',
      '',
      '## Browser console output',
      '',
      'Open your browser console, then paste any error messages below.',
      '',
      '```',
      '',
      '```',
      '',
      '## App details',
      '',
      '| Detail | Value |',
      '| --- | --- |',
      ...supportDetails().map(([label, value]) => `| ${label} | ${String(value).replaceAll('|', '\\|')} |`),
      '',
    ].join('\n');
    return `${repository}/issues/new?${new URLSearchParams({ title: `[${metadata.title}] `, body })}`;
  }

  // The href is complete at creation so middle-click and copy-link work. The
  // click rewrite picks up a scientific version the shell synced after the bar.
  function createSupportAction() {
    const link = createLink('Support', 'support', supportIssueHref(), 'Report a problem or suggest a feature on GitHub');
    link.addEventListener('click', () => { link.href = supportIssueHref(); });
    return link;
  }

  function findLegacyControl(action) {
    return document.querySelector(`[data-neurodesk-control="${action}"]`);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  function linkHtml(href, label) {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  // The ecosystem sentence with its project name and domain linked. The domain
  // is linked first so the name replacement cannot touch the generated href.
  function ecosystemHtml() {
    const { ecosystem, ecosystem_name: name, ecosystem_url: url } = information.shared;
    const domain = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    let html = escapeHtml(ecosystem).replace(escapeHtml(domain), linkHtml(url, domain));
    if (name && !html.includes(`>${escapeHtml(name)}<`)) html = html.replace(escapeHtml(name), linkHtml(url, name));
    return html;
  }

  // Shared About block: what runs under the hood, who builds the web app and
  // the ecosystem the app belongs to. Rendered identically for every app.
  function aboutInformationHtml() {
    if (!information) return '';
    const packages = information.packages.map((item) =>
      `<li>${linkHtml(item.url, item.name)} · ${escapeHtml(item.role)}</li>`).join('');
    const builders = information.builders ? `<p>${escapeHtml(information.builders)}</p>` : '';
    return `<section class="nd-app-info" data-neurodesk-app-info="about">`
      + `<h3>Under the hood</h3><ul>${packages}</ul>`
      + `<h3>About this app</h3>${builders}<p>${escapeHtml(information.shared.builder)}</p>`
      + `<p>${ecosystemHtml()}</p>`
      + `</section>`;
  }

  function citationHtml(item) {
    const code = item.code ? `<small>Code: ${linkHtml(item.code, item.code.replace(/^https?:\/\//, ''))}</small>` : '';
    const link = item.doi
      ? linkHtml(`https://doi.org/${item.doi}`, `DOI: ${item.doi}`)
      : item.url ? linkHtml(item.url, item.url.replace(/^https?:\/\//, '')) : '';
    return `<div class="nd-app-citation"><strong>${escapeHtml(item.title)}</strong>${code}<p>${escapeHtml(item.reference)}</p>${link}</div>`;
  }

  // Shared Cite dialog: the web application, every implemented method grouped
  // as in the registry, then the Neurodesk platform paper.
  function citeInformationHtml() {
    if (!information) return '';
    const version = document.querySelector('.nd-app-bar__version')?.textContent || versionLabel(metadata.version);
    const self = citationHtml({
      title: metadata.title,
      reference: `Neurodesk (${new Date().getFullYear()}). ${metadata.title} (${version}) [Web application]. ${metadata.description}`,
      url: metadata.url || new URL('.', document.baseURI).href,
      code: metadata.sourceHref,
    });
    const groups = new Map();
    for (const item of information.citations) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    const methods = [...groups].map(([group, items]) => `<h3>${escapeHtml(group)}</h3>${items.map(citationHtml).join('')}`).join('');
    return `<section class="nd-app-info" data-neurodesk-app-info="cite">`
      + `<div class="nd-app-info__primary">${self}</div>`
      + `<p>${escapeHtml(metadata.title)} implements the methods below. Please cite each paper when you use its results.</p>`
      + methods
      + `<h3>Platform</h3>${citationHtml(information.shared.platform_citation)}`
      + `</section>`;
  }

  function fallbackBodyHtml(kind) {
    const displayedVersion = document.querySelector('.nd-app-bar__version')?.textContent || versionLabel(metadata.version);
    if (kind === 'about') {
      const paragraphs = information?.about?.length ? information.about : [metadata.description];
      return `<p>${paragraphs.map(escapeHtml).join('</p><p>')}</p><p>This page is running ${escapeHtml(displayedVersion)}.</p>${aboutInformationHtml()}`;
    }
    if (kind === 'cite') {
      return citeInformationHtml()
        || `<p>Please cite the scientific software, methods, and models used in your analysis. App-specific citation details are available in the documentation and source repository.</p>`;
    }
    return `<p>Imaging files are processed in your browser unless the app clearly states otherwise. The Neurodesk hosting layer records page views only and sends no custom events. It makes no analytics request when Do Not Track or Global Privacy Control is enabled, and never sends your loaded imaging data to Google Analytics.</p>`;
  }

  function openFallbackDialog(kind) {
    let dialog = document.querySelector(`.nd-app-dialog[data-dialog="${kind}"]`);
    if (!dialog) {
      dialog = element('dialog', { className: 'nd-app-dialog' });
      dialog.dataset.dialog = kind;
      const headings = { about: `About ${metadata.title}`, cite: `Cite ${metadata.title}`, privacy: 'Privacy' };
      const panel = element('div', { className: 'nd-app-dialog__panel' });
      const header = element('div', { className: 'nd-app-dialog__header' });
      const heading = element('h2', { text: headings[kind] });
      const close = element('button', { className: 'nd-app-dialog__close', text: '×', title: 'Close' });
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', () => dialog.close());
      header.append(heading, close);
      const body = element('div', { className: 'nd-app-dialog__body', html: fallbackBodyHtml(kind) });
      const source = createLink('View source on GitHub', 'github', metadata.sourceHref, 'View source on GitHub');
      source.classList.add('nd-app-dialog__source');
      body.append(source);
      panel.append(header, body);
      dialog.append(panel);
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      document.body.append(dialog);
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector('.nd-app-dialog__body')?.scrollTo?.(0, 0);
  }

  const openDialogSelector = 'dialog[open], .modal-overlay.active .modal, .nd-modal-overlay.active .nd-modal, [role="dialog"]:not([hidden])';

  // After an app opens its own About dialog, append the shared block so the
  // packages, builder and ecosystem statements appear in every app.
  function decorateAppDialog(kind, attempt = 0) {
    if (kind !== 'about' || !information) return;
    const dialogs = [...document.querySelectorAll(openDialogSelector)]
      .filter((node) => !node.classList.contains('nd-app-dialog') && node.checkVisibility?.() !== false);
    const dialog = dialogs.at(-1);
    if (!dialog) { if (attempt < 10) requestAnimationFrame(() => decorateAppDialog(kind, attempt + 1)); return; }
    if (dialog.querySelector('[data-neurodesk-app-info="about"]')) return;
    const body = dialog.querySelector('.modal-body, .nd-dialog-body, .nd-modal-body, .dialog-body, [data-dialog-body]') || dialog;
    const section = document.createElement('div');
    section.innerHTML = aboutInformationHtml();
    body.append(section.firstElementChild);
  }

  async function openAppInformation(kind) {
    if (kind === 'standalone') {
      try {
        const response = await fetch(metadata.standaloneHref);
        if (!response.ok) throw new Error(`Standalone catalog: HTTP ${response.status}`);
        const catalog = await response.json();
        const { openStandalone } = await import(/* @vite-ignore */ new URL('ui/renderStandalone.js', metadata.componentsHref).href);
        if (!standaloneStylesReady) {
          const existing = document.querySelector('[data-standalone-styles]');
          const styles = existing || element('link');
          standaloneStylesReady = styles.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
            styles.addEventListener('load', resolve, { once: true });
            styles.addEventListener('error', () => {
              styles.remove();
              standaloneStylesReady = null;
              reject(new Error('Standalone stylesheet could not be loaded'));
            }, { once: true });
          });
          if (!existing) {
            styles.rel = 'stylesheet';
            styles.href = new URL('styles/imaging-workspace.css', metadata.componentsHref).href;
            styles.dataset.standaloneStyles = '';
            document.head.append(styles);
          }
        }
        await standaloneStylesReady;
        openStandalone({ title: metadata.title, app: catalog.apps[metadata.id], suite: catalog.suite, installed: document.documentElement.hasAttribute('data-neurodesk-offline') });
      } catch (error) {
        console.error('Standalone information could not be loaded', error);
        window.alert('Standalone downloads could not be loaded. Please try again.');
      }
      return;
    }
    // Cite is always the shared, registry-driven list so every app cites the
    // same way; About keeps app-owned content and gains the shared block.
    if (kind === 'cite' && information) { openFallbackDialog(kind); return; }
    const legacyControl = findLegacyControl(kind);
    if (legacyControl) { legacyControl.click(); decorateAppDialog(kind); }
    else openFallbackDialog(kind);
  }

  function createBar() {
    const bar = element('div', { className: 'nd-app-bar' });
    bar.dataset.neurodeskTopBar = '';
    const identity = element('div', { className: 'nd-app-bar__identity' });
    identity.append(
      element('strong', { className: 'nd-app-bar__title', text: metadata.title }),
      element('span', { className: 'nd-app-bar__description', text: metadata.description }),
      element('span', { className: 'nd-app-bar__version', text: versionLabel(metadata.version) }),
    );
    const navigation = element('nav', { className: 'nd-app-bar__navigation' });
    navigation.setAttribute('aria-label', 'Application navigation');
    const informationActions = [
      createControlAction('about', 'About', 'about'),
      createControlAction('cite', 'Cite', 'cite'),
    ];
    informationActions.push(createControlAction('standalone', 'Standalone', 'standalone'));
    informationActions.push(createControlAction('privacy', 'Privacy', 'privacy'));
    informationActions.push(createSupportAction());
    navigation.append(
      ...informationActions,
      (() => {
        const toggle = createAction('Light', 'theme');
        toggle.dataset.neurodeskThemeToggle = '';
        toggle.querySelector('span').dataset.neurodeskThemeLabel = '';
        return toggle;
      })(),
      createLink('More Apps', 'apps', metadata.moreAppsHref, 'More Neurodesk web apps'),
      createLink('GitHub', 'github', metadata.sourceHref, 'View this app on GitHub'),
    );
    bar.append(identity, navigation);
    return bar;
  }

  function replaceHeader(header) {
    if (!header || header.querySelector(':scope > .nd-app-bar')) return;
    header.dataset.neurodeskTopBarHost = '';
    header.append(createBar());
  }

  function preserveUtilityControls(header, selector) {
    if (!header || header.dataset.neurodeskUtilitiesMoved !== undefined) return;
    const controls = [...header.querySelectorAll(selector)];
    if (controls.length) {
      const utilityBar = element('div', { className: 'nd-app-utility-bar' });
      utilityBar.setAttribute('aria-label', 'Application tools');
      utilityBar.append(...controls);
      header.after(utilityBar);
    }
    header.dataset.neurodeskUtilitiesMoved = '';
    replaceHeader(header);
  }

  function installBars() {
    const shell = resolveShellAdapter(metadata.shell, document);
    shell.managedLinks.forEach((link) => { link.hidden = true; });
    shell.headers.forEach(replaceHeader);
    if (shell.utilities.length && shell.headers[0]) preserveUtilityControls(shell.headers[0], '[data-neurodesk-utility]');
    shell.overlays.forEach((landing) => {
      if (!landing.querySelector(':scope > .nd-app-bar')) { landing.dataset.neurodeskTopBarOverlay = ''; landing.prepend(createBar()); }
    });

    if (document.querySelector('[data-neurodesk-top-bar-host] > .nd-app-bar')) {
      document.querySelectorAll('body > .nd-app-bar--standalone').forEach((bar) => bar.remove());
    }

    if (!document.querySelector('.nd-app-bar')) {
      const bar = createBar();
      bar.classList.add('nd-app-bar--standalone');
      document.body.prepend(bar);
    }
  }

  function syncOptionalActions() {
    const registered = true;
    document.querySelectorAll('.nd-app-bar__navigation').forEach((navigation) => {
      const existing = navigation.querySelector('[data-neurodesk-shell-control="standalone"]');
      if (!registered && existing) existing.remove();
      if (registered && !existing) {
        const action = createControlAction('standalone', 'Standalone', 'standalone');
        const privacy = navigation.querySelector('[data-neurodesk-shell-control="privacy"]');
        navigation.insertBefore(action, privacy);
      }
    });
  }

  function syncScientificVersion() {
    const candidates = document.querySelectorAll('#appVersion, button[title="View changelog"]');
    const scientificVersion = [...candidates]
      .filter((candidate) => !candidate.closest('.nd-app-bar'))
      .map((candidate) => candidate.textContent.trim())
      .find((value) => /^v?\d+\.\d+(?:\.\d+)?(?:[-+ (].*)?$/.test(value));
    if (!scientificVersion) return;
    document.querySelectorAll('.nd-app-bar__version').forEach((node) => {
      const next = versionLabel(scientificVersion);
      if (node.textContent !== next) node.textContent = next;
    });
  }

  let scheduled = false;
  function refresh() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installBars();
      syncOptionalActions();
      syncScientificVersion();
    });
  }

  installBars();
  syncOptionalActions();
  syncScientificVersion();
  new MutationObserver(refresh).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-neurodesk-control'],
  });
})();
