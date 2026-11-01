import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

test('base worker initialization uses the exact runtime manifest WASM URL', async () => {
  const importedUrls = [];
  const initializedUrls = [];
  const messages = [];
  const versions = { qsmxt: { version: 'git 1f72772' }, qsm_rs: { version: 'git 95be94b' } };
  let handle;
  const context = createContext({
    self: { location: { href: 'https://example.org/qsmbly/js/qsm-worker-pure.js' } },
    console,
  });
  const wasm = new SyntheticModule(['default', 'health_check_wasm', 'get_version_wasm', 'get_dependency_versions_wasm'], function () {
    this.setExport('default', async url => initializedUrls.push(url));
    this.setExport('health_check_wasm', () => true);
    this.setExport('get_version_wasm', () => 'test');
    this.setExport('get_dependency_versions_wasm', () => JSON.stringify(versions));
  }, { context });
  await wasm.link(() => {});
  await wasm.evaluate();
  const source = await readFile(new URL('./qsm-worker-pure.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, {
    context,
    importModuleDynamically: async url => {
      importedUrls.push(url);
      return wasm;
    },
  });
  await module.link(async specifier => {
    if (specifier.endsWith('/config.js')) {
      const config = await import('./app/config.js');
      return new SyntheticModule(Object.keys(config), function () {
        for (const [name, value] of Object.entries(config)) this.setExport(name, value);
      }, { context });
    }
    const end = source.indexOf(`from '${specifier}'`);
    const declaration = source.slice(source.lastIndexOf('import ', end), end);
    const names = declaration.match(/\{([^}]+)\}/)[1].split(',').map(name => name.trim());
    return new SyntheticModule(names, function () {
      for (const name of names) {
        let value = () => {};
        if (name === 'installWorkerRouter') value = options => { handle = options.handle; };
        if (name === 'createWorkerEmitter') value = () => ({
          log: () => {},
          error: error => messages.push({ type: 'error', error }),
          initialized: data => messages.push({ type: 'initialized', ...data }),
        });
        this.setExport(name, value);
      }
    }, { context });
  });
  await module.evaluate();
  await handle({ type: 'init' });
  expect(messages).toEqual([{ type: 'initialized', versions }]);
  expect(importedUrls).toHaveLength(1);
  expect(importedUrls[0]).toMatch(/^https:\/\/example.org\/qsmbly\/wasm\/qsm_wasm\.js\?v=.+$/);
  expect(initializedUrls).toEqual(['https://example.org/qsmbly/wasm/qsm_wasm_bg.wasm']);
});

test('every module the worker imports exists', async () => {
  const { access } = await import('node:fs/promises');
  const source = await readFile(new URL('./qsm-worker-pure.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^import [^;]* from '(\.[^']+)';$/gm)].map(match => match[1]);
  expect(specifiers.length).toBeGreaterThan(3);
  for (const specifier of specifiers) await access(new URL(specifier, import.meta.url));
});
