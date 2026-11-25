// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import {
  BRAINCHOMP_LIB_REVISION,
  DEFAULT_OPENING_RADIUS,
  UPSTREAM_REVISION,
} from '@neurodesk/brainchomp';
import automation from '../automation.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };

export { BRAINCHOMP_LIB_REVISION, DEFAULT_OPENING_RADIUS, UPSTREAM_REVISION };

export const APP = Object.freeze({
  id: 'brainchomp',
  title: automation.title,
  version: packageJson.version,
});
