let nextId = 0;

export function renderExampleSelector({ examples, onLoad, onStatus = () => {} }, doc = globalThis.document) {
  const root = doc.createElement('div');
  root.className = 'nd-field';
  root.dataset.neurodeskExamples = '';
  root.dataset.exampleState = 'idle';
  const label = doc.createElement('label');
  const select = doc.createElement('select');
  select.id = `nd-example-${++nextId}`;
  select.dataset.neurodeskExample = '';
  label.htmlFor = select.id;
  label.textContent = 'Example';
  const placeholder = doc.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose an example…';
  select.append(placeholder);
  for (const example of examples) {
    const option = doc.createElement('option');
    option.value = example.id;
    option.textContent = example.label;
    select.append(option);
  }
  const message = doc.createElement('p');
  message.className = 'nd-hint';
  message.id = `${select.id}-status`;
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  select.setAttribute('aria-describedby', message.id);
  const cancelButton = doc.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'nd-btn nd-btn-secondary nd-btn-sm';
  cancelButton.textContent = 'Cancel example download';
  cancelButton.hidden = true;
  root.append(label, select, message, cancelButton);
  let active = null;
  let disabled = false;
  let destroyed = false;

  function status(state, text, error = false) {
    root.dataset.exampleState = state;
    message.textContent = text;
    onStatus(text, error);
  }

  function refresh() {
    select.disabled = disabled || active !== null || destroyed;
    cancelButton.hidden = active === null;
    root.setAttribute('aria-busy', String(active !== null));
  }

  function cancel() {
    if (!active) return;
    const job = active;
    active = null;
    job.abort();
    select.value = '';
    delete root.dataset.exampleId;
    refresh();
    status('cancelled', 'Example loading cancelled. Choose an example to retry.');
  }

  async function load() {
    const example = examples.find(item => item.id === select.value);
    if (!example || disabled || destroyed) return;
    cancel();
    const controller = new AbortController();
    active = controller;
    delete root.dataset.exampleId;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (active !== controller || destroyed) throw new DOMException('Example loading cancelled', 'AbortError');
    };
    refresh();
    status('loading', `Loading ${example.label}…`);
    try {
      await onLoad(example, {
        signal: controller.signal,
        assertCurrent,
        async fetchFiles() {
          const files = await Promise.all(example.files.map(async asset => {
            assertCurrent();
            const response = await fetch(asset.url, { signal: controller.signal });
            if (!response.ok) throw new Error(`Could not download ${asset.name} (HTTP ${response.status}).`);
            const bytes = await response.arrayBuffer();
            assertCurrent();
            if (asset.sha256) {
              const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
              const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
              if (actual !== asset.sha256) throw new Error(`The checksum for ${asset.name} did not match.`);
            }
            assertCurrent();
            return new File([bytes], asset.name);
          }));
          assertCurrent();
          return files;
        },
      });
      assertCurrent();
      root.dataset.exampleId = example.id;
      status('ready', `${example.description} ${example.expectedResult}`);
    } catch (error) {
      if (active === controller && !controller.signal.aborted) {
        controller.abort();
        status('error', `${error.message} Choose the example again to retry.`, true);
      }
    } finally {
      if (active === controller) {
        active = null;
        select.value = '';
        refresh();
      }
    }
  }

  // Capture replacement inputs before an app's import handler can commit them.
  const replaced = event => {
    if (event.type !== 'drop' && !event.target?.matches('input[type="file"]')) return;
    if (active) cancel();
    else {
      delete root.dataset.exampleId;
      root.dataset.exampleState = 'idle';
      message.textContent = '';
    }
  };
  doc.addEventListener('change', replaced, true);
  doc.addEventListener('drop', replaced, true);
  select.addEventListener('change', load);
  cancelButton.addEventListener('click', cancel);
  return {
    root,
    select,
    cancel,
    setDisabled(value) {
      disabled = value;
      refresh();
    },
    destroy() {
      cancel();
      destroyed = true;
      doc.removeEventListener('change', replaced, true);
      doc.removeEventListener('drop', replaced, true);
      select.removeEventListener('change', load);
      cancelButton.removeEventListener('click', cancel);
      root.remove();
    },
  };
}
