// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "lcmodel",
  version: packageJson.version,
});
