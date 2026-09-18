import { filesFromDataTransferItems } from '../file-io/detectFiles.js';

/**
 * Make any element a drop target. `handler` receives a promise of File[]
 * with dropped folders expanded, so DICOM directories arrive as one series.
 */
export function bindFileDrop(target, handler, doc = globalThis.document, isDisabled = () => false) {
  const state = { handler, destroy };
  function dragover(event) {
    event.preventDefault();
    if (!isDisabled()) target.classList.add('dragover');
  }
  function dragleave() {
    target.classList.remove('dragover');
  }
  function drop(event) {
    event.preventDefault();
    target.classList.remove('dragover');
    if (isDisabled() || !state.handler) return;
    const transfer = event.dataTransfer;
    const files = transfer?.items?.length
      ? filesFromDataTransferItems(transfer.items)
      : Promise.resolve(Array.from(transfer?.files || []));
    state.handler(files);
  }
  function destroy() {
    target.removeEventListener('dragover', dragover);
    target.removeEventListener('dragleave', dragleave);
    target.removeEventListener('drop', drop);
    dragleave();
  }
  target.addEventListener('dragover', dragover);
  target.addEventListener('dragleave', dragleave);
  target.addEventListener('drop', drop);
  return state;
}
