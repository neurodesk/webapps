// The CLI regression runs its real reporting/cleanup code, with no browser, HTTP listener or kernel.
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "node:http") return { url: new URL("./http.mjs", import.meta.url).href, shortCircuit: true };
  if (specifier === "@playwright/test") return { url: new URL("./playwright.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const timeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 1), ...args);
// The cancel mode's 600-second fallback must also advance without a real browser process.
if (process.env.HMC_BROWSER_TEST_CASE.startsWith("cancel")) {
  let clock = Date.now();
  Date.now = () => (clock += 1000000);
}
