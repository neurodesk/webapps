// Long conversions run on the page's thread, so they hand it back now and then: a pacer
// yields to the event loop once `budget` milliseconds have passed since the last yield, then
// checks the signal, so cancel clicks and progress updates are handled between chunks.
const now = () => globalThis.performance?.now() ?? Date.now();

// A plain task, queued behind input, rendering and other tasks. scheduler.yield() is not used:
// its continuation outranks them, and in Chromium the page did not paint or take a click until
// the conversion ended. setTimeout(0) is clamped to 4 ms when nested, so a MessageChannel
// message is the browser's task; Node, where a channel would keep the process alive, uses
// setImmediate.
function yieldOnce() {
  if (typeof globalThis.setImmediate === "function") return new Promise((resolve) => globalThis.setImmediate(resolve));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** A function to await between units of work; it yields at most once per `budget` ms. */
export function pacer(signal, budget = 25) {
  let last = now();
  return async () => {
    signal?.throwIfAborted();
    if (now() - last < budget) return;
    await yieldOnce();
    last = now();
    signal?.throwIfAborted();
  };
}
