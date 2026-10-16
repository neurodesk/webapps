import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

test('base worker initialization uses the exact runtime manifest WASM URL', async () => {
  const importedUrls = [];
  const initializedUrls = [];
  const messages = [];
  let handle;
  const context = createContext({
    self: { location: { href: 'https://example.org/qsmbly/js/qsm-worker-pure.js' } },
    console,
  });
  const wasm = new SyntheticModule(['default', 'health_check_wasm', 'get_version_wasm'], function () {
    this.setExport('default', async url => initializedUrls.push(url));
    this.setExport('health_check_wasm', () => true);
    this.setExport('get_version_wasm', () => 'test');
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
    const declaration = source.split('\n').find(line => line.includes(`from '${specifier}'`));
    const names = declaration.match(/\{([^}]+)\}/)[1].split(',').map(name => name.trim());
    return new SyntheticModule(names, function () {
      for (const name of names) {
        let value = () => {};
        if (name === 'installWorkerRouter') value = options => { handle = options.handle; };
        if (name === 'createWorkerEmitter') value = () => ({
          log: () => {},
          error: error => messages.push({ type: 'error', error }),
          initialized: () => messages.push({ type: 'initialized' }),
        });
        this.setExport(name, value);
      }
    }, { context });
  });
  await module.evaluate();
  await handle({ type: 'init' });
  expect(messages).toEqual([{ type: 'initialized' }]);
  expect(importedUrls).toHaveLength(1);
  expect(importedUrls[0]).toMatch(/^https:\/\/example.org\/qsmbly\/wasm\/qsm_wasm\.js\?v=.+$/);
  expect(initializedUrls).toEqual(['https://example.org/qsmbly/wasm/qsm_wasm_bg.wasm']);
});
