# Custom elements

The UI package provides light-DOM custom elements. They use the shared
`imaging-workspace.css` stylesheet and native inputs, labels, buttons, and
selectors. Applications own scientific processing and viewer instances.

Import the stylesheet once. Register the elements used by declarative markup:

```js
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { defineConsole } from '@neurodesk/webapp-components/elements/console';

defineConsole();
```

```html
<nd-console id="technicalLog" collapsed></nd-console>
```

Registration is explicit and repeatable within a window. Pass a window when
working with another document. Importing the module alone does not access the
DOM or register elements, so the package remains importable in Node.

Factories register the element in the supplied document and return the element
itself. All factories and registration functions are exported from `/elements`
and `/ui`; individual `/elements/<name>` entries support selective imports.

| Element | Factory | Inputs and commands | Events |
| --- | --- | --- | --- |
| `nd-console` | `createConsole` | `collapsed`, `label`, `max-lines` attributes; `log`, `clear`, `getText`, `open`, `close` methods | Native disclosure interaction |
| `nd-file-field` | `createFileField` | `text`, `label`, `kind`, `disabled`, `directory`, `input-id` attributes; `input`, `text` properties; `onFiles`, `setText`, `setHasFiles` methods | `nd-files`: `{ files: Promise<File[]> }` |
| `nd-result-list` | `createResultList` | `stageLabels` property; `render(results, stageOrder)` method | `nd-view`, `nd-download`: `{ stage, result }`; `nd-visibility-change`: `{ stage, result, visible, input }` |
| `nd-viewer-toolbar` | `createViewerToolbar` | `options` property before initialization; `setActive`, `control` methods | `nd-view-change`, `nd-overlay-change`, `nd-colormap-change`: `{ value }`; `nd-window-change`: `{ control, value }`; `nd-window-reset`, `nd-download`, `nd-screenshot` |
| `nd-example-selector` | `createExampleSelector` | `examples`, `onLoad`, `onStatus`, `scope` properties; `disabled` attribute; `cancel`, `setDisabled`, `destroy` methods | `nd-example-status`: `{ state, message, error }` |

The file field accepts multiple files by default. `multiple="false"` selects a
single file. `accept` is available for specialized inputs; scan inputs keep it
unset so extensionless DICOM remains selectable. Folder expansion is asynchronous,
so consumers await the `files` promise and handle rejection.

Result lists render a visibility checkbox when a result has a boolean `visible`
property. The app owns that value and supplies updated results to `render`.
Otherwise the result has a View button. Factory callbacks retain the former
`onView`, `onDownload`, and `onVisibilityChange` argument lists. Prefer declarative
`<nd-result-list id="results">` markup for new callers. The factory's `element`
option replaces a legacy placeholder and copies its attributes, but cannot copy
listeners attached to that placeholder.

Toolbar controls have instance-specific IDs. Use `toolbar.control('windowMin')`
instead of a document-wide ID lookup. `WindowControls` accepts the toolbar as its
`root`; its volume callbacks still belong to the app. App-supplied action nodes
and explicitly configured tab IDs retain their identity.

Example selectors keep the existing asynchronous `onLoad(example, context)`
contract. The context supplies `signal`, `fetchFiles`, and `assertCurrent`.
Call `assertCurrent` after asynchronous preparation before committing results.
Set `scope` to the workflow containing replacement uploads; otherwise the
selector uses the nearest imaging workspace, declared `[data-example-scope]`,
form, `#workspace`, or its parent. Use separate scopes for independent workflows. The read-only `uploadScope` property
reports the connected element's resolved scope. The interface audit requires it
to contain a file picker, catching selectors mounted outside their upload workflow.

Elements retain their child nodes across moves and reconnection. Console and
file-field listeners do not accumulate on reconnect. Example downloads survive
synchronous DOM moves but are cancelled when the element remains disconnected
at the next microtask. Explicit `destroy()` cancels immediately and removes the
selector. Configure an example selector before allowing user interaction.

## Migration from builders

Replace `renderConsole`, `renderFileField`, `renderViewerToolbar`, and
`renderExampleSelector` with their `create*` factories. Replace
`new StageResultList(options)` with `createResultList(options)`. These factories
return elements, so append the result directly rather than its former `.root`.
The old builders and `StageResultList` export have been removed.

Keep `renderSidebarSection`, `createInfoDialog`, and standalone `bindFileDrop`
when using native markup. The lower-level `ConsoleOutput` remains available for
apps with existing log markup. No additional framework is required.

## Verification

Run `pnpm --filter @neurodesk/webapp-components test:unit` for DOM and lifecycle
checks. Run `pnpm --filter @neurodesk/webapp-components test:elements:browser`
with Playwright Chromium installed for native keyboard, clipboard, file selection,
instance isolation and cancellation checks on desktop and phone. CI runs the
browser check before building and auditing the composite site.
