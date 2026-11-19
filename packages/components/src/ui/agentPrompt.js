import { createElement } from '../core/dom.js';
import { createFileField } from '../elements/file-field.js';
import { createInfoDialog } from './renderInfoDialog.js';

const TITLE = 'Your AI agent is asking';
const NOTICE = 'An AI agent you started in this browser sent this request. Closing it declines.';

/**
 * The dialogs through which a browser AI agent asks the person at the page for an answer or for files.
 * One prompt shows at a time and the rest wait their turn. Closing a prompt declines it, and an
 * aborted signal closes it, or drops it before it shows.
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
    const turn = queue.then(() => (signal?.aborted ? null : present(content, signal)));
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
      const notice = createElement('p', { className: 'nd-hint', text: NOTICE, ownerDocument: doc });
      dialog.open(TITLE, [notice, ...content(finish)]);
      root.addEventListener('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function button(text, className, onclick) {
    return createElement('button', { type: 'button', className: `nd-btn ${className}`, text, onclick, ownerDocument: doc });
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
     * the root the app reads under, as a store's metadata and chunks. Resolves true only when the person allows it.
     */
    async confirmFetch({ app, addresses, readsUnder = false }, { signal } = {}) {
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
      const answer = await show(finish => [
        createElement('p', { text: readsUnder ? `Let ${app} read the data stored under ${one ? 'this address' : 'these addresses'}?` : `Let ${app} load ${one ? 'the file at this address' : 'the files at these addresses'} into the page?`, ownerDocument: doc }),
        createElement('ul', { ownerDocument: doc }, resolved.map((url, index) => createElement('li', { ownerDocument: doc }, [createElement('code', { text: url?.href ?? addresses[index], ownerDocument: doc })]))),
        createElement('p', { text: readsUnder
          ? `${app} reads the addresses under ${one ? 'it' : 'each one'}, such as a store's metadata and chunks. ${servers} every request.`
          : `The page loads only ${one ? 'this address' : 'these addresses'}, and nothing they redirect to. ${servers} the request.`, ownerDocument: doc }),
        actions(finish, button('Allow', 'nd-btn-primary', () => finish(true))),
      ], signal);
      return answer === true;
    },

    /** Asks whether the agent may use files the page received, which the app may have refused or replaced since. Resolves true only when the person allows it. */
    async confirmFiles({ app, label, files }, { signal } = {}) {
      const answer = await show(finish => [
        createElement('p', { text: `Let the agent run ${app} on these files from ${label}?`, ownerDocument: doc }),
        createElement('ul', { ownerDocument: doc }, files.map(file => createElement('li', { text: file.name, ownerDocument: doc }))),
        createElement('p', { text: 'The page received them but may not show them now. Allow only if you mean these files.', ownerDocument: doc }),
        actions(finish, button('Allow', 'nd-btn-primary', () => finish(true))),
      ], signal);
      return answer === true;
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
