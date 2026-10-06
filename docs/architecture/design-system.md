# Design system

One stylesheet, one markup vocabulary, shared custom elements and native builders. Every app on the
`imaging-workspace` shell is assembled from the classes defined in
[`packages/components/src/styles/imaging-workspace.css`](../../packages/components/src/styles/imaging-workspace.css)
and the elements and builders exported from `@neurodesk/webapp-components/ui`. QSMbly is the
visual reference; the vocabulary copies its metrics (0.7rem uppercase section
titles, dashed 40px scan picker, 0.8rem controls, 34px viewer toolbar, 120px
collapsed console, 4px progress bar). Apps supply words and science, not CSS.

`test/design-system.test.mjs` enforces this document. Read
[the interface standard](interface-standard.md) for behaviour (what starts
open, what the primary action is called, keyboard and touch rules); this page
covers what things look like and where their styling lives.

## Why apps drifted

Sixteen apps were reviewed on 10 September 2026. The causes, in order of
impact:

1. **The shared package offered chrome, not components.** `mountImagingWorkspace`
   wrapped a sidebar, viewer and status bar but said nothing about what goes
   inside them. `imaging-workspace.css` styled "a button in the sidebar" through
   element and ID selectors (`#processButton`, `#applyBtn`) and left pickers,
   fields, hints, dialogs, consoles and result lists undefined. Every agent
   filled the gap with its own CSS: six different scan pickers, five colour
   sources for the primary button, four disclosure mechanisms.
2. **Two vocabularies with no bridge.** The five inference apps and QSMbly use
   `inference-workspace.css` (`.sidebar-section`, `.btn-primary`,
   `.file-upload-zone`, `.viewer-toolbar`, `.console-container`). Vite apps
   import `imaging-workspace.css`, whose `nd-` classes were near-copies with a
   prefix and nothing for the sidebar body. An agent copying QSMbly's markup
   into a Vite app got unstyled HTML and wrote the CSS again (SYNcro
   re-declared the whole console block; SynthSR hardcoded 44 colours).
3. **The hosted theme chased app markup.** `site/app-theme.css` remaps the
   `--nd-color-*` tokens to the green Neurocontainers palette and then patches
   per-app class names (`.upload-visual`, `.start-hero`, `.modebtn`). Agents
   working in `vite dev` never see the hosted palette, so hardcoded colours
   look fine locally and wrong in production. Colour must flow only through
   tokens; the theme should never need to know an app's class names.
4. **The template was a placeholder.** `pnpm new-app` produced one Run button
   and a "workspace" div, so the first real UI was copied from whichever app
   the agent last touched. The template is now the complete canonical layout.
5. **The audit checked behaviour, not appearance.** `audit:interfaces` verifies
   one app bar, keyboard disclosures and picker attributes, so an app could
   pass with a marketing hero in the viewer and 16px browser-default inputs.
   The design-system test now fails on colour literals, restyled vocabulary,
   free headings, inline styles and hand-written dialogs.
6. **Unreadable sources.** SynthSR and SYNcro were written as single-line
   minified HTML, CSS and JS, which made drift invisible in review.

## The vocabulary

| Region | Markup | Builder |
| --- | --- | --- |
| Section | `<details class="nd-sidebar-section" open><summary class="nd-section-title">Title</summary><div class="nd-section-content">…</div></details>` | `renderSidebarSection()` |
| Nested settings | the same `details` inside a `.nd-section-content` (renders as a small inline disclosure) | |
| Field | `<div class="nd-field"><label for="x">Label <small>unit</small></label><select id="x">…</select><p class="nd-hint">Help</p></div>` | |
| Checkbox | `<label class="nd-check"><input type="checkbox"> Label</label>` | |
| Equal columns | `<div class="nd-row">…</div>` | |
| Scan picker | `<label class="nd-file"><input type="file" data-neurodesk-input="image" multiple><svg…/><span>Drop NIfTI or DICOM files or folder</span></label>` + `<p class="nd-file-info">` | `createFileField()`, `bindFileDrop()` |
| Buttons | `.nd-btn.nd-btn-primary` (one per workspace), `.nd-btn.nd-btn-secondary`, `.nd-btn-sm`, `.nd-btn-icon`, `.nd-btn-danger` | |
| Result rows | `<div class="nd-volume-toggle"><button class="nd-view-btn active">View</button><span class="nd-stage-label">Name</span><button class="nd-edit-btn">Edit</button><button class="nd-download-btn">Download</button></div>` | `createResultList` (Edit only for `editable: true` results) |
| Message | `<p class="nd-message error|warning|success|info">` | |
| Help icon | `<span class="nd-info-icon" tabindex="0" aria-label="…">i<span class="nd-info-tooltip">…</span></span>` | `bindInfoTooltips()`, `renderInfoIcon()` |
| Viewer toolbar | `.nd-viewer-toolbar > .nd-view-tabs > .nd-view-tab` (layout) + `.nd-viewer-actions` (opacity, colormap, window) | `createViewerToolbar({ views, window, overlay, colormap, download, screenshot, actions })` |
| Mask editing | `.nd-mask-editor` (second toolbar row under the viewer toolbar) `> .nd-viewer-label + .nd-tool-group > .nd-tool-btn[aria-pressed]`, a Label `select`, `.nd-brush-control`, Undo/Apply/Cancel `.nd-btn-sm`; `.nd-edit-btn` in result rows | `createMaskEditor({ nv, onApply, onCancel, labelNames })`, `createResultList({ onEdit })`; see [mask editing](mask-editing.md) |
| Viewer | `.nd-viewer-canvas-wrapper > canvas + p.nd-viewer-empty + p.nd-viewer-notice`, then `.nd-viewer-info` | |
| Image comparison | `.nd-compare-grid[data-count] > .nd-compare-panel[aria-current] > button.nd-compare-title[aria-pressed] + canvas`, over the viewer wrapper; two columns, the active panel outlined | |
| Technical log | `.nd-console-container[data-disclosure].collapsed` with header, Copy, Clear | `createConsole()` |
| Resizable log | `.nd-console-resizer[role=separator]` as the console's first child; the height is `--nd-console-height` on the container | `createConsole({ resizable: true })`, `<nd-console resizable>`, `bindConsoleResize()` for legacy `.console-container` markup |
| Analysis and technical logs | `.nd-console-tabs[role=tablist] > .nd-console-tab[role=tab]` in the header, `.nd-console-panels > .nd-console-output[role=tabpanel]` | `createConsole({ channels: [{ id, label }, …] })`, `<nd-console channels="analysis:Analysis,technical:Technical">` |
| Status (the only place for live progress) | `<footer id="status"><span class="nd-status-label">Status</span><span id="statusText" class="nd-status-text">…</span><span class="nd-status-elapsed"></span><progress></progress><button class="nd-btn-cancel" hidden>×</button></footer>` | |
| Dialog | `dialog.nd-dialog` with `.nd-dialog-header`, `.nd-dialog-close`, `.nd-dialog-body`; `.nd-dialog-highlight`, `.nd-citation`, `.nd-command` inside | `createInfoDialog()`, `renderCommand()` |

Sizes are the same on every app: sections 16px padding, controls 30px tall at
0.8rem, hints 0.7rem, toolbar tabs 0.75rem, console 0.7rem monospace. Touch
devices get 44px targets and 16px inputs from the shared media query. Light and
dark come from the hosted theme's tokens; apps never set `color-scheme`.

## Layout rules

- The sidebar is a column of sections. The first section is input (open),
  the second is the task with its primary action (open), later sections are
  output and secondary inputs (collapsed until useful). Nothing else sits in
  the sidebar: About, Cite, Privacy and Standalone are hidden buttons wired
  through `controlsContract`, and the shared app bar shows them.
- The viewer is toolbar, canvas, one-line info bar, collapsed technical log.
  The log opens at 120px. A resizable log grows from its top edge by drag or
  keyboard up to the point where the canvas still has 160px, and keeps its
  size while collapsed. The canvas takes the rest; never give the log a fixed
  larger height in app CSS.
  Before import the canvas shows one sentence in `.nd-viewer-empty`. No hero
  copy, feature chips, logos or eyebrow labels.
- Every result is a row in the Output section with View and Download. Which
  image is displayed is a sidebar decision; the toolbar holds only how it is
  displayed (layout, overlay opacity, window, colormap).
- Status is one line at the bottom: label, message, elapsed time, a 4px
  progress bar and a small × cancel that appears only while running.
- Say things once. A field label plus a short `.nd-hint` when needed; no
  paragraphs, no repeated instructions, no "Image workspace" captions.
  Visible help is at most 90 characters; anything longer is an
  `.nd-info-icon` tooltip beside the label or goes to About.
- One `.nd-btn-primary` per sidebar. Everything else is `.nd-btn-secondary`.
- The app opens on this layout. There is no start page, hero or welcome modal,
  and no static footer below the workspace.
- `ProgressManager` drives the status footer (`begin`, `setProgress`, `end`,
  `reset`), including the elapsed counter and the cancel ×. Apps on the older
  `.app-container` grid place the same `footer#status.nd-imaging-status` as
  the grid's last child; the shared stylesheet spans it across both columns.

## What an app may still own

- Scientific widgets with no shared equivalent (a mask brush, a metrics table).
  Style them with `--nd-*` tokens only, in the app stylesheet, under a class
  prefixed with the app name. The budget is 40 lines and zero colour literals.
- The words: section titles, labels, hints, dialog content in `<template>`
  elements, status messages.
- The science: workers, models, volume processing, provenance.

If a shared class is missing or a metric is wrong, change
`imaging-workspace.css`, add a test in
`packages/components/test/workflow-vocabulary.test.js`, and use the class.
Never patch the look inside an app or in `site/app-theme.css`.

## App information: About and Cite

The words in About and Cite are data, not markup. `registry/app-information.yml`
holds, for every app, the packages that run under the hood, one citation per
implemented method, optional builder credits and optional About paragraphs.
The shared statements live there once:

- Builder: "The web application is developed and hosted by the Neurodesk team …"
- Ecosystem: "This app is part of the lightNIIng ecosystem (lightniing.org), which
  aims to make neuroimaging tools widely available for clinical translation."
  The link belongs in About; it is not repeated in the application bar.
- Platform citation: Renton et al. 2024, Nature Methods (Neurodesk).

The build injects the app's entry as one JSON script and `site/app-shell.js`
renders it. Cite is always the shared dialog: the web application, every
method grouped as in the registry, then the platform paper. About keeps the
app's own dialog when it has one and appends "Under the hood" and "About this
app" to it; apps without an About dialog get the registry paragraphs in the
shared dialog. Apps therefore never write citation markup; a new method is one
YAML entry plus one line in `test/app-information.test.mjs`, which fails when
an implemented method has no paper or an app has no entry.

## Adoption

| App | State |
| --- | --- |
| SynthSR, SYNcro | Rebuilt on the vocabulary; app CSS is empty. |
| App template (`pnpm new-app`) | Canonical example; Documentation links to this executable template. |
| NiiMath | Rebuilt on the vocabulary (28 September 2026): shared picker, layout tabs, status footer, console and information dialog; the app stylesheet is gone. |
| Deface, BrowserQC | Own palette (`--bg`, `--accent`) and `.upload-button` pair. Ratcheted; migrate the picker to `.nd-file` and delete the palette. |
| SurfAnnotate, ZARRo | Specialist sidebars with their own panel styling. Ratcheted; migrate section titles and buttons first. |
| QSMbly and the five inference apps | Already match the reference through `inference-workspace.css`. Their class names map 1:1 (`.sidebar-section` → `.nd-sidebar-section`, `.btn-primary` → `.nd-btn-primary`, `.file-upload-zone` → `.nd-file`, `.viewer-toolbar` → `.nd-viewer-toolbar`, `.console-container` → `.nd-console-container`); migrate when touching them. |
| Easy MP2RAGE | Uses the shared workspace through native ESM components, including file fields, three-plane panels, console, status and result rows. |
| dicompare, MRI2VID | Not on the shell. Out of scope for the vocabulary; the shared app bar is their only common chrome. |

Ratchet values live in `test/design-system.test.mjs` and may only decrease.

## Custom element ownership

Interactive widgets use light-DOM custom elements from the shared package.
Factories return the element itself; append it directly. Keep native details,
buttons, inputs and dialogs. See the [element contract](../../packages/components/docs/components/elements.md)
for registration, events, local control lookup and cleanup.
