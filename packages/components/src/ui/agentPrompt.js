import { createElement } from '../core/dom.js';
import { createFileField } from '../elements/file-field.js';
import { createInfoDialog } from './renderInfoDialog.js';

const TITLE = 'Your AI agent is asking';
const NOTICE = 'An AI agent you started in this browser sent this request. Closing it declines.';

/**
 * The dialogs through which a browser AI agent asks the person at the page for an answer or for files.
 * One prompt shows at a time and the rest wait their turn. Closing a prompt declines it, and an
 * aborted signal closes it, or drops it before it shows: the tools abort a call's signal when the
 * person uses the page, so a question queued behind another is never shown once it is moot.
 *
 * A consent prompt (`confirmFetch`, `confirmFiles`, `confirmResume`) names state the person decides
 * on. Its request may be a function returning the request, which is read when the prompt shows and
 * again when the person presses Allow: when the two differ, the prompt shows the current one and asks
 * again. It resolves to the request the person allowed, or null; the caller applies the answer only
 * while its state is still that request.
 *
 *   const prompts = createAgentPrompts();
 *   await prompts.ask({ question: 'Which series?', options: ['T1', 'T2'] }, { signal });
 *   await prompts.requestFiles({ label: 'One anatomical head image', formats: ['nifti'] }, { signal });
 *   await prompts.confirmFetch({ app: 'Brain Extraction', addresses: ['https://example.org/t1.nii.gz'] }, { signal });
 */
export function createAgentPrompts(doc = globalThis.document) {
  let dialog;
  let queue = Promise.resolve();

  function show(content, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    // The next prompt waits a task, so what the answer to the one before changed is settled when it reads its state.
    const turn = queue.then(() => new Promise(resolve => doc.defaultView.setTimeout(resolve)))
      .then(() => (signal?.aborted ? null : present(content, signal)));
    queue = turn.catch(() => null);
    if (!signal) return turn;
    const aborted = new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
    return Promise.race([turn, aborted]);
  }

  function present(content, signal) {
    return new Promise(resolve => {
      dialog ??= createInfoDialog({ id: 'neurodeskAgentPrompt' }, doc);
      const { root } = dialog;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        root.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        root.close();
        resolve(value);
      };
      // The close event of the previous prompt can arrive after this one opened.
      const onClose = () => {
        if (!root.open) finish(null);
      };
      const onAbort = () => finish(null);
      const render = nodes => dialog.open(TITLE, [createElement('p', { className: 'nd-hint', text: NOTICE, ownerDocument: doc }), ...nodes]);
      render(content(finish, render));
      root.addEventListener('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function button(text, className, onclick) {
    return createElement('button', { type: 'button', className: `nd-btn ${className}`, text, onclick, ownerDocument: doc });
  }

  /**
   * A prompt that names the state `request` gives, read as it shows. Allow resolves to that state
   * only while `request` still gives it; otherwise the prompt shows the current state and asks again.
   */
  function consent(request, body, signal) {
    const current = typeof request === 'function' ? request : () => request;
    return show((finish, render) => {
      const ask = (shown, changed) => {
        const allow = () => {
          let now;
          try {
            now = current();
          } catch {
            return finish(null);
          }
          if (JSON.stringify(now) === JSON.stringify(shown)) finish(shown);
          else render(ask(now, true));
        };
        return [
          ...(changed ? [createElement('p', { className: 'nd-message warning', role: 'status', text: 'This changed since it was shown. Check it again.', ownerDocument: doc })] : []),
          ...body(shown),
          actions(finish, button('Allow', 'nd-btn-primary', allow)),
        ];
      };
      return ask(current(), false);
    }, signal);
  }

  function actions(finish, ...buttons) {
    return createElement('div', { className: 'nd-dialog-actions', ownerDocument: doc }, [
      button('Decline', 'nd-btn-secondary', () => finish(null)),
      ...buttons,
    ]);
  }

  return {
    async ask({ question, options = [], allowText = options.length === 0 }, { signal } = {}) {
      const answer = await show(finish => {
        const nodes = [createElement('p', { text: question, ownerDocument: doc })];
        const choices = options.map(option => button(option, 'nd-btn-secondary', () => finish(option)));
        if (!allowText) return [...nodes, actions(finish, ...choices)];
        const input = createElement('textarea', { id: 'neurodeskAgentAnswer', rows: 3, ownerDocument: doc });
        const send = button('Send answer', 'nd-btn-primary', () => finish(input.value));
        const field = createElement('div', { className: 'nd-field', ownerDocument: doc }, [
          createElement('label', { for: input.id, text: 'Your answer', ownerDocument: doc }),
          input,
        ]);
        return [...nodes, field, actions(finish, ...choices, send)];
      }, signal);
      return answer === null ? { dismissed: true } : { answer };
    },

    /**
     * Asks whether the app may fetch the addresses the agent named. `readsUnder` says each address is
     * the root the app reads under, as a store's metadata and chunks; `replaces` that the file takes
     * the place of the images the viewer shows. Resolves to the request when the person allows it.
     */
    confirmFetch(request, { signal } = {}) {
      return consent(request, ({ app, addresses, readsUnder = false, replaces = false }) => {
        const resolved = addresses.map(address => {
          try {
            return new URL(address, doc.baseURI);
          } catch {
            return null;
          }
        });
        const origins = [...new Set(resolved.filter(Boolean).map(url => url.origin))];
        const one = addresses.length === 1;
        const servers = origins.length === 1 ? `The server at ${origins[0]} sees` : `The servers at ${origins.join(', ')} see`;
        return [
          createElement('p', { text: readsUnder ? `Let ${app} read the data stored under ${one ? 'this address' : 'these addresses'}?` : `Let ${app} load ${one ? 'the file at this address' : 'the files at these addresses'} into the page?`, ownerDocument: doc }),
          createElement('ul', { ownerDocument: doc }, resolved.map((url, index) => createElement('li', { ownerDocument: doc }, [createElement('code', { text: url?.href ?? addresses[index], ownerDocument: doc })]))),
          createElement('p', { text: readsUnder
            ? `${app} reads the addresses under ${one ? 'it' : 'each one'}, such as a store's metadata and chunks. ${servers} every request.`
            : `The page loads only ${one ? 'this address' : 'these addresses'}, and nothing they redirect to. ${servers} the request.`, ownerDocument: doc }),
          ...(replaces ? [createElement('p', { text: 'It replaces the images the viewer shows now.', ownerDocument: doc })] : []),
        ];
      }, signal);
    },

    /** Asks whether the agent may use files the page received, which the app may have refused or replaced since. Resolves to the request when the person allows it. */
    confirmFiles(request, { signal } = {}) {
      return consent(request, ({ app, label, files }) => [
        createElement('p', { text: `Let the agent run ${app} on these files from ${label}?`, ownerDocument: doc }),
        createElement('ul', { ownerDocument: doc }, files.map(file => createElement('li', { text: file.name, ownerDocument: doc }))),
        createElement('p', { text: 'The page received them but may not show them now. Allow only if you mean these files.', ownerDocument: doc }),
      ], signal);
    },

    /**
     * Asks whether the agent may continue after the person used the page, naming exactly what it gets
     * back: `files`, the `{ role, name }` it holds for its next run, and `run`, its latest run as
     * `{ operation, startedAt, inputs }` or null, whose report and outputs are the ones it ended with.
     * A run's input is a file `{ role, name }` or an address `{ role, url }`. Resolves to the request
     * when the person allows it.
     */
    confirmResume(request, { signal } = {}) {
      const list = items => createElement('ul', { ownerDocument: doc }, items.map(item => createElement('li', { text: `${item.role}: ${item.name ?? item.url}`, ownerDocument: doc })));
      return consent(request, ({ app, files = [], run = null }) => [
        createElement('p', { text: `Let the agent continue in ${app}?`, ownerDocument: doc }),
        ...(run ? [
          createElement('p', { text: `It gets the report and outputs of its ${run.operation} run from ${new Date(run.startedAt).toLocaleTimeString()}, on:`, ownerDocument: doc }),
          list(run.inputs),
          createElement('p', { text: 'They are the results that run ended with, even if the page shows others now.', ownerDocument: doc }),
        ] : []),
        ...(files.length ? [
          createElement('p', { text: 'It keeps these files for its next run:', ownerDocument: doc }),
          list(files),
        ] : []),
        createElement('p', { text: 'You used the page since its last step. Decline to make it let go of them.', ownerDocument: doc }),
      ], signal);
    },

    async requestFiles({ label, formats = [], message, minimum = 1, maximum = Infinity, folder = false }, { signal } = {}) {
      return show(finish => {
        const error = createElement('p', { className: 'nd-message error', role: 'alert', hidden: true, ownerDocument: doc });
        const take = async chosen => {
          const files = await chosen;
          if (!folder && (files.length < minimum || files.length > maximum)) {
            error.hidden = false;
            error.textContent = maximum === minimum
              ? `Choose exactly ${minimum} file${minimum === 1 ? '' : 's'}.`
              : `Choose ${minimum} to ${maximum} files.`;
            return;
          }
          finish(files);
        };
        const fields = [createFileField({ text: 'Choose files', kind: 'dataset', multiple: maximum !== 1 || folder }, doc).onFiles(take)];
        if (folder) fields.push(createFileField({ text: 'Choose a folder', kind: 'dataset', directory: true }, doc).onFiles(take));
        return [
          ...(message ? [createElement('p', { text: message, ownerDocument: doc })] : []),
          createElement('p', { ownerDocument: doc }, [
            createElement('strong', { text: label, ownerDocument: doc }),
            ...(formats.length ? [` (${formats.join(', ')})`] : []),
          ]),
          ...fields,
          error,
          actions(finish),
        ];
      }, signal);
    },
  };
}
