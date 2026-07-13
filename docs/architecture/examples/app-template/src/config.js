// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "APP_NAME",
  version: "0.0.0",
  ga4MeasurementId: "", // filled per app from registry/apps.yml
});
