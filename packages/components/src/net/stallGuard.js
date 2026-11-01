// fetch has no timeout of its own: a host that accepts the connection and then goes silent
// leaves a download pending for ever. The guard aborts after STALL_TIMEOUT ms without
// activity (the headers, then each body chunk), not after a total deadline, since large
// models legitimately take minutes to arrive.
export const STALL_TIMEOUT = 30_000;

/**
 * An AbortSignal that follows `parent` and also aborts, with a TimeoutError, after
 * `timeout` ms without a `touch()`. `stop()` ends the watch; the signal keeps following
 * `parent`, so a response body bound to it is still cancelled by the caller's abort.
 * A null timeout returns `parent` unguarded.
 */
export function stallGuard(parent, timeout = STALL_TIMEOUT) {
  if (!timeout || !Number.isFinite(timeout)) return { signal: parent, touch() {}, stop() {} };
  const controller = new AbortController();
  const follow = () => controller.abort(parent.reason);
  if (parent?.aborted) follow();
  else parent?.addEventListener('abort', follow, { once: true });
  let timer;
  const stall = () => controller.abort(new DOMException(`no data for ${Math.round(timeout / 1000)} s`, 'TimeoutError'));
  const touch = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) timer = setTimeout(stall, timeout);
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    stop: () => clearTimeout(timer),
  };
}
