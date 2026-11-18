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
