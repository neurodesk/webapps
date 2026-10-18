import assert from 'node:assert/strict';
import test from 'node:test';
import { LockfileAnalysisError, lockfileImpact } from '../scripts/lib/lockfile-impact.mjs';

// Which workspace importers a pnpm-lock.yaml change affects decides which apps
// CI tests. Missing an importer skips the tests that would catch a broken
// dependency; anything the analysis cannot classify must throw so the planner
// falls back to the whole catalog.
const dep = (version) => ({ specifier: version, version });
const link = (target) => ({ specifier: 'workspace:*', version: `link:${target}` });
function lockfile({ importers, snapshots }) {
  const packages = Object.fromEntries(Object.keys(snapshots).map((key) => [key.replace(/\(.*$/, ''), { resolution: { integrity: `sha512-${key}` } }]));
  return { lockfileVersion: '9.0', settings: { autoInstallPeers: true }, importers, packages, snapshots };
}
const baseLock = lockfile({
  importers: {
    '.': { devDependencies: { eslint: dep('9.0.0'), '@neurodesk/code-quality': link('scripts/quality') } },
    'apps/niimath': { dependencies: { '@niivue/niivue': dep('1.0.0'), '@neurodesk/webapp-components': link('../../packages/components') } },
    'apps/lcmodel': { dependencies: { '@neurodesk/lcmodel': link('../../packages/lcmodel') } },
    'packages/components': {},
    'packages/lcmodel': { dependencies: { fflate: dep('0.8.0') } },
    'scripts/quality': { devDependencies: { knip: dep('5.0.0') } },
  },
  snapshots: {
    '@niivue/niivue@1.0.0': { dependencies: { pako: '2.1.0' } },
    'pako@2.1.0': {},
    'eslint@9.0.0': {},
    'fflate@0.8.0': {},
    'knip@5.0.0': {},
  },
});
function changeLock(edit, lock = baseLock) {
  const after = structuredClone(lock);
  edit(after);
  return after;
}
// Adds a resolved package to a lockfile.
function resolve(lock, key) {
  lock.snapshots[key] = {};
  lock.packages[key] = { resolution: { integrity: `sha512-${key}` } };
}
const impact = (after, before = baseLock) => lockfileImpact({ before: JSON.stringify(before), after: JSON.stringify(after) });
const affected = (after, before) => Object.fromEntries(impact(after, before));

test('independent root tools retain validation and every non-root dependency closure', () => {
  const before = changeLock(lock => {
    lock.importers['.'].devDependencies.knip = dep('5.0.0');
    lock.snapshots['knip@5.0.0'] = { dependencies: { pako: '2.1.0' } };
  });
  const options = { independentRootDevDependencies: ['knip'] };
  const narrowed = (after) => lockfileImpact({ before: JSON.stringify(before), after: JSON.stringify(after) }, options);
  const upgraded = changeLock(lock => {
    lock.importers['.'].devDependencies.knip = dep('6.0.0');
    resolve(lock, 'knip@6.0.0');
  }, before);
  assert.deepEqual([...narrowed(upgraded).keys()], []);
  assert.ok(impact(upgraded, before).has('.'), 'the default analysis remains conservative');
  const removed = changeLock(lock => { delete lock.importers['.'].devDependencies.knip; }, before);
  assert.deepEqual([...narrowed(removed).keys()], []);
  const shared = changeLock(lock => { lock.packages['pako@2.1.0'].resolution.integrity = 'sha512-republished'; }, before);
  assert.deepEqual([...narrowed(shared).keys()], ['apps/niimath', 'scripts/quality']);
  const rootRuntime = changeLock(lock => {
    lock.importers['.'].devDependencies.pako = dep('2.1.0');
    lock.packages['pako@2.1.0'].resolution.integrity = 'sha512-republished';
  }, before);
  assert.ok(narrowed(rootRuntime).has('.'), 'other root dependency roots are preserved');
  const invalid = changeLock(lock => { delete lock.snapshots['knip@5.0.0']; }, before);
  assert.throws(() => narrowed(invalid), LockfileAnalysisError);
  const optional = changeLock(lock => {
    delete lock.importers['.'].devDependencies.knip;
    lock.importers['.'].optionalDependencies = { knip: dep('5.0.0') };
  }, before);
  assert.ok(narrowed(optional).has('.'), 'only devDependencies may be independent');
});

test('independent root tools can be added or removed without hiding invalid root-only resolutions', () => {
  const options = { independentRootDevDependencies: ['knip'] };
  const compare = (before, after) => lockfileImpact({ before: JSON.stringify(before), after: JSON.stringify(after) }, options);
  const empty = changeLock(lock => {
    lock.importers['.'] = {};
    delete lock.importers['scripts/quality'];
  });
  const tool = changeLock(lock => { lock.importers['.'].devDependencies = { knip: dep('5.0.0') }; }, empty);
  assert.deepEqual([...compare(empty, tool)], []);
  assert.deepEqual([...compare(tool, empty)], []);
  const invalid = changeLock(lock => { delete lock.snapshots['knip@5.0.0']; }, tool);
  assert.throws(() => compare(tool, invalid), error => error instanceof LockfileAnalysisError && /knip for \./.test(error.message));
  const absent = changeLock(lock => { delete lock.importers['.']; }, empty);
  assert.deepEqual([...compare(absent, absent)], []);
});

test('required package metadata is validated on both original sides before excluding root tools', () => {
  const peered = 'knip@5.0.0(typescript@7.0.2)';
  const before = lockfile({
    importers: { '.': { devDependencies: { knip: dep(peered.slice('knip@'.length)) } } },
    snapshots: { [peered]: { optionalDependencies: { helper: '1.0.0' } }, 'helper@1.0.0': {} },
  });
  const options = { independentRootDevDependencies: ['knip'] };
  const compare = (base, head) => lockfileImpact({ before: JSON.stringify(base), after: JSON.stringify(head) }, options);
  const removed = changeLock(lock => {
    lock.importers['.'] = {};
    lock.snapshots = {};
    lock.packages = {};
  }, before);
  assert.deepEqual([...compare(before, before)], []);
  assert.deepEqual([...compare(before, removed)], []);
  assert.deepEqual([...compare(removed, before)], []);
  const invalidMetadata = [undefined, null, [], 'metadata', 42, {}, { resolution: null }, { resolution: [] }, { resolution: 'bad' }, { resolution: {} }];
  for (const key of ['knip@5.0.0', 'helper@1.0.0']) {
    for (const metadata of invalidMetadata) {
      const invalid = changeLock(lock => {
        if (metadata === undefined) delete lock.packages[key];
        else lock.packages[key] = metadata;
      }, before);
      for (const [base, head] of [[before, invalid], [invalid, before], [invalid, removed], [removed, invalid]]) {
        assert.throws(() => compare(base, head), error => error instanceof LockfileAnalysisError && error.message.includes(key) && /package metadata/.test(error.message), `${key}: ${JSON.stringify(metadata)}`);
      }
    }
  }
});

test('non-root closures validate required metadata with the default API', () => {
  for (const key of ['@niivue/niivue@1.0.0', 'pako@2.1.0']) {
    const invalid = changeLock(lock => { delete lock.packages[key]; });
    assert.throws(() => impact(invalid), LockfileAnalysisError);
    assert.throws(() => impact(baseLock, invalid), LockfileAnalysisError);
  }
});

test('an importer is affected through the workspace importers it links, but the root is not', () => {
  const after = changeLock((lock) => {
    lock.importers['scripts/quality'].devDependencies.knip = dep('5.1.0');
    resolve(lock, 'knip@5.1.0');
    lock.importers['packages/components'] = { dependencies: { pako: dep('2.1.0') } };
  });
  const result = impact(after);
  assert.deepEqual([...result.keys()].sort(), ['apps/niimath', 'packages/components', 'scripts/quality']);
  assert.equal(result.get('apps/niimath'), 'importer apps/niimath links affected importer packages/components');
  assert.equal(impact(baseLock).size, 0);
});

test('a transitive upgrade affects the importers that resolve it and names the changed packages in order', () => {
  const after = changeLock((lock) => {
    lock.snapshots['@niivue/niivue@1.0.0'].dependencies.pako = '2.1.1';
    delete lock.snapshots['pako@2.1.0'];
    delete lock.packages['pako@2.1.0'];
    resolve(lock, 'pako@2.1.1');
  });
  assert.deepEqual(affected(after), {
    'apps/niimath': 'importer apps/niimath resolves changed packages @niivue/niivue@1.0.0, pako@2.1.0, pako@2.1.1',
  });
});

test('a removed transitive dependency affects the importers that resolved it before', () => {
  const after = changeLock((lock) => {
    lock.snapshots['@niivue/niivue@1.0.0'] = {};
    delete lock.snapshots['pako@2.1.0'];
    delete lock.packages['pako@2.1.0'];
  });
  assert.deepEqual(affected(after), {
    'apps/niimath': 'importer apps/niimath resolves changed packages @niivue/niivue@1.0.0, pako@2.1.0',
  });
});

test('a republished package affects its importers even when every version is unchanged', () => {
  const after = changeLock((lock) => {
    lock.packages['pako@2.1.0'].resolution.integrity = 'sha512-republished';
  });
  assert.deepEqual(affected(after), { 'apps/niimath': 'importer apps/niimath resolves changed packages pako@2.1.0' });
});

test('a package resolved with peers is compared through its package entry', () => {
  const peered = 'react-dom@18.3.1(react@18.3.1)';
  const before = changeLock((lock) => {
    lock.importers['packages/components'] = { dependencies: { 'react-dom': dep(peered.slice('react-dom@'.length)), react: dep('18.3.1') } };
    resolve(lock, 'react@18.3.1');
    lock.snapshots[peered] = { dependencies: { react: '18.3.1' } };
    lock.packages['react-dom@18.3.1'] = { resolution: { integrity: 'sha512-react-dom' } };
  });
  const after = changeLock((lock) => {
    lock.packages['react-dom@18.3.1'].resolution.integrity = 'sha512-republished';
  }, before);
  assert.deepEqual(affected(after, before), {
    'packages/components': `importer packages/components resolves changed packages ${peered}`,
    'apps/niimath': 'importer apps/niimath links affected importer packages/components',
  });
});

test('dependencies are followed through optional, dev and aliased entries and through cycles', () => {
  const before = changeLock((lock) => {
    lock.importers['packages/components'] = {
      devDependencies: { a: dep('1.0.0') },
      optionalDependencies: { 'string-width-cjs': { specifier: 'npm:string-width@4.2.3', version: 'string-width@4.2.3' } },
    };
    lock.snapshots['a@1.0.0'] = { optionalDependencies: { b: '1.0.0' } };
    lock.snapshots['b@1.0.0'] = { dependencies: { a: '1.0.0', c: '1.0.0' } };
    resolve(lock, 'c@1.0.0');
    resolve(lock, 'string-width@4.2.3');
    lock.packages['a@1.0.0'] = { resolution: { integrity: 'sha512-a' } };
    lock.packages['b@1.0.0'] = { resolution: { integrity: 'sha512-b' } };
  });
  const deep = changeLock((lock) => {
    lock.packages['c@1.0.0'].resolution.integrity = 'sha512-republished';
  }, before);
  assert.deepEqual(affected(deep, before), {
    'packages/components': 'importer packages/components resolves changed packages c@1.0.0',
    'apps/niimath': 'importer apps/niimath links affected importer packages/components',
  });
  const aliased = changeLock((lock) => {
    lock.packages['string-width@4.2.3'].resolution.integrity = 'sha512-republished';
  }, before);
  assert.equal(impact(aliased, before).get('packages/components'), 'importer packages/components resolves changed packages string-width@4.2.3');
});

test('more than five changed packages are summarised with a count', () => {
  const names = ['f', 'e', 'd', 'c', 'b', 'a'];
  const before = changeLock((lock) => {
    lock.importers['packages/components'] = { dependencies: Object.fromEntries(names.map((name) => [name, dep('1.0.0')])) };
    for (const name of names) resolve(lock, `${name}@1.0.0`);
  });
  const republish = (count) => changeLock((lock) => {
    for (const name of names.slice(0, count)) lock.packages[`${name}@1.0.0`].resolution.integrity = 'sha512-republished';
  }, before);
  assert.equal(impact(republish(5), before).get('packages/components'), 'importer packages/components resolves changed packages b@1.0.0, c@1.0.0, d@1.0.0, e@1.0.0, f@1.0.0');
  assert.equal(impact(republish(6), before).get('packages/components'), 'importer packages/components resolves changed packages a@1.0.0, b@1.0.0, c@1.0.0, d@1.0.0, e@1.0.0 and 1 more');
});

test('an importer that was added, removed or edited is named as such', () => {
  const after = changeLock((lock) => {
    lock.importers['packages/new'] = { dependencies: { pako: dep('2.1.0') } };
    delete lock.importers['scripts/quality'];
    lock.importers['packages/lcmodel'].dependencies.fflate = { specifier: '^0.8.0', version: '0.8.0' };
  });
  assert.deepEqual(affected(after), {
    'packages/new': 'importer packages/new was added',
    'scripts/quality': 'importer scripts/quality was removed',
    'packages/lcmodel': 'importer packages/lcmodel changed its dependency entries',
    'apps/lcmodel': 'importer apps/lcmodel links affected importer packages/lcmodel',
  });
});

test('links are followed through every hop, on either side of the change', () => {
  const before = changeLock((lock) => {
    lock.importers['apps/viewer'] = { devDependencies: { '@neurodesk/lcmodel-ui': link('../../packages/ui') } };
    lock.importers['packages/ui'] = { optionalDependencies: { '@neurodesk/lcmodel': link('../lcmodel') } };
  });
  const after = changeLock((lock) => {
    lock.importers['packages/lcmodel'].dependencies.fflate = dep('0.8.2');
    resolve(lock, 'fflate@0.8.2');
  }, before);
  assert.deepEqual(affected(after, before), {
    'packages/lcmodel': 'importer packages/lcmodel changed its dependency entries',
    'apps/lcmodel': 'importer apps/lcmodel links affected importer packages/lcmodel',
    'packages/ui': 'importer packages/ui links affected importer packages/lcmodel',
    'apps/viewer': 'importer apps/viewer links affected importer packages/ui',
  });
});

test('the report does not depend on the order of the lockfile', () => {
  const after = changeLock((lock) => {
    lock.packages['pako@2.1.0'].resolution.integrity = 'sha512-republished';
    lock.importers['packages/lcmodel'].dependencies.fflate = dep('0.8.2');
    resolve(lock, 'fflate@0.8.2');
  });
  const reversed = (lock) => ({ ...lock, importers: Object.fromEntries(Object.entries(lock.importers).reverse()) });
  assert.deepEqual([...impact(reversed(after), reversed(baseLock))], [...impact(after)]);
  assert.deepEqual([...impact(after).keys()], ['apps/niimath', 'packages/lcmodel', 'apps/lcmodel']);
});

test('changes the analysis cannot scope throw a LockfileAnalysisError naming the cause', () => {
  const text = (lock) => (typeof lock === 'string' ? lock : JSON.stringify(lock));
  const fails = (after, reason, before = baseLock) => assert.throws(
    () => lockfileImpact({ before: text(before), after: text(after) }),
    (error) => error instanceof LockfileAnalysisError && reason.test(error.message),
    String(reason),
  );
  fails(baseLock, /^the base pnpm-lock\.yaml does not parse \(/, 'importers: [');
  fails('importers: [', /^the head pnpm-lock\.yaml does not parse \(/);
  fails({ ...baseLock, lockfileVersion: '6.0' }, /^the head pnpm-lock\.yaml has lockfileVersion 6\.0, not 9\.0$/);
  fails(baseLock, /^the base pnpm-lock\.yaml has lockfileVersion undefined, not 9\.0$/, '');
  for (const section of ['overrides', 'settings', 'patchedDependencies', 'catalogs']) {
    fails({ ...baseLock, [section]: { pako: '2.1.1' } }, new RegExp(`^pnpm-lock\\.yaml changed its ${section} section, which can alter every resolution$`));
  }
  fails(changeLock((lock) => {
    lock.importers['apps/niimath'].dependencies.missing = dep('1.0.0');
  }), /^pnpm-lock\.yaml resolves missing for apps\/niimath to 1\.0\.0, which has no snapshot$/);
  fails(changeLock((lock) => {
    lock.snapshots['@niivue/niivue@1.0.0'].dependencies.gone = '3.0.0';
  }), /^pnpm-lock\.yaml resolves gone for @niivue\/niivue@1\.0\.0 to 3\.0\.0, which has no snapshot$/);
  for (const section of ['importers', 'packages', 'snapshots']) {
    for (const value of [null, [], 'invalid']) {
      fails({ ...baseLock, [section]: value }, new RegExp(`^the head pnpm-lock\\.yaml has an invalid ${section} section$`));
      fails(baseLock, new RegExp(`^the base pnpm-lock\\.yaml has an invalid ${section} section$`), { ...baseLock, [section]: value });
    }
  }
  assert.deepEqual([...lockfileImpact({ before: 'lockfileVersion: "9.0"', after: 'lockfileVersion: "9.0"' })], []);
  // A section that is present but unchanged does not stop the analysis.
  assert.equal(impact({ ...baseLock, settings: { autoInstallPeers: true } }).size, 0);
});
