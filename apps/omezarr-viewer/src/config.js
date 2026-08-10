// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: 'omezarr-viewer',
  version: '0.1.1',
});
