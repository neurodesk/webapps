const events = new Set(['listening', 'close', 'error', 'clientError', 'socket-close', 'socket-error', 'request', 'response-finish', 'response-close', 'stream-error']);

export function diagnosticLines(write, limit = 8192) {
  let pending = '';
  let dropping = false;
  return chunk => {
    for (const character of String(chunk)) {
      if (character !== '\n') {
        if (!dropping) pending += character;
        if (pending.length > limit) { pending = ''; dropping = true; }
        continue;
      }
      if (!dropping) {
        try {
          const value = JSON.parse(pending);
          if (value?.diagnostic === 'offline-server' && events.has(value.event) && typeof value.time === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.time)) {
            const record = { time: value.time, diagnostic: 'offline-server', event: value.event };
            if (typeof value.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(value.code)) record.code = value.code;
            if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) record.status = value.status;
            for (const key of ['finished', 'destroyed', 'hadError']) if (typeof value[key] === 'boolean') record[key] = value[key];
            write(record);
          }
        } catch { /* Non-diagnostic output is deliberately omitted. */ }
      }
      pending = ''; dropping = false;
    }
  };
}

export async function failureSnapshot(evaluate, timeout = 2000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(evaluate),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeout); }),
    ]);
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}
