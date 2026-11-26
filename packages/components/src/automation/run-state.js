async function describeFile(file, signal) {
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  return {
    filename: file.name,
    bytes: file.size,
    sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
  };
}

export function createRunState({ app, appVersion, statusElement = document.getElementById('statusText') }) {
  if (!statusElement) throw new Error('Missing status element for run state');
  const targetStatus = statusElement;
  const doc = targetStatus.ownerDocument;
  let script = doc.getElementById('neurodesk-run');
  if (!script) {
    const created = doc.createElement('script');
    created.type = 'application/json';
    created.id = 'neurodesk-run';
    doc.body.append(created);
    script = created;
  }
  const runScript = script;
  let active;
  let snapshot = { schemaVersion: 1, app, appVersion, runId: null, state: 'idle', message: '' };
  function publish(next) {
    snapshot = next;
    targetStatus.dataset.neurodeskState = next.state;
    targetStatus.dataset.neurodeskRunId = next.runId ?? '';
    runScript.textContent = JSON.stringify(next);
  }
  publish(snapshot);

  function begin(state, { inputs = {}, parameters = {} } = {}) {
    if (!['loading', 'running'].includes(state)) throw new Error(`Invalid starting state: ${state}`);
    active?.controller.abort();
    const token = { controller: new AbortController(), terminal: false, completing: false };
    active = token;
    const runId = crypto.randomUUID();
    const context = { inputs: { ...inputs }, parameters: structuredClone(parameters) };
    publish({ schemaVersion: 1, app, appVersion, runId, state, message: '' });
    const current = () => active === token && !token.terminal && !token.controller.signal.aborted;
    function finish(state, message, report) {
      if (!current()) return false;
      token.terminal = true;
      if (state === 'failed') token.controller.abort();
      publish({ schemaVersion: 1, app, appVersion, runId, state, message, ...(report && { report }) });
      return true;
    }
    return {
      get current() { return current(); },
      signal: token.controller.signal,
      ready(message = 'Ready') {
        if (state !== 'loading') throw new Error('Only loading can become ready');
        return finish('ready', message);
      },
      /** @param {{ message?: string, value?: number }} [update] */
      progress({ message = snapshot.message, value } = {}) {
        if (!current()) return false;
        publish({ ...snapshot, message, ...(value === undefined ? {} : { progress: value }) });
        return true;
      },
      fail(error) {
        return finish('failed', error?.message ?? String(error));
      },
      async succeed({ artifacts, provenance = {}, measurements }) {
        if (state !== 'running') throw new Error('Only processing can succeed');
        if (!current() || token.completing) return false;
        token.completing = true;
        try {
          const inputRecords = {};
          const artifactRecords = {};
          for (const [role, file] of Object.entries(context.inputs)) {
            inputRecords[role] = await describeFile(file, token.controller.signal);
          }
          for (const [role, { file, ...metadata }] of Object.entries(artifacts)) {
            if (!file.size) throw new Error(`The ${role} output is empty`);
            artifactRecords[role] = {
              ...metadata,
              ...await describeFile(file, token.controller.signal),
              mediaType: metadata.mediaType || file.type || 'application/octet-stream',
            };
          }
          const report = {
            schemaVersion: 1,
            app,
            appVersion,
            runId,
            status: 'succeeded',
            inputs: inputRecords,
            parameters: context.parameters,
            provenance: structuredClone(provenance),
            artifacts: artifactRecords,
            ...(measurements && { measurements: structuredClone(measurements) }),
          };
          return finish('succeeded', 'Results ready', report);
        } catch (error) {
          if (!current()) return false;
          finish('failed', error.message || String(error));
          throw error;
        }
      },
    };
  }
  return {
    begin,
    snapshot: () => structuredClone(snapshot),
    message(message) {
      if (snapshot.state === 'failed') return;
      publish({ ...snapshot, message });
    },
    fail(error) {
      const running = active && !active.terminal;
      if (running) {
        active.terminal = true;
        active.controller.abort();
      }
      publish({ schemaVersion: 1, app, appVersion, runId: running ? snapshot.runId : crypto.randomUUID(), state: 'failed', message: error?.message ?? String(error) });
    },
    cancel(message = 'Cancelled') {
      if (!active || active.terminal) return false;
      active.terminal = true;
      active.controller.abort();
      publish({ schemaVersion: 1, app, appVersion, runId: snapshot.runId, state: 'cancelled', message });
      return true;
    },
  };
}
