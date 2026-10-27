// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };

export const APP = Object.freeze({
  id: "APP_NAME",
  title: automation.title,
  version: "0.0.0",
});
