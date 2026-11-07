// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "samsrf",
  title: automation.title,
  version: packageJson.version,
});
