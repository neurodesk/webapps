// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from '../automation.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };

export const UPSTREAM_REVISION = '51a90203f497cea6b3cf01e34bd113f8c2a6292c';
export const BRAINCHOMP_LIB_REVISION = '95c8b9bd186f0fcffabb797e1fe770c26659750e';
export const DEFAULT_OPENING_RADIUS = 4;

export const APP = Object.freeze({
  id: 'brainchomp',
  title: automation.title,
  version: packageJson.version,
});
