import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';

test('DL initialization uses the exact runtime manifest WASM URL', async () => {
  const importedUrls = [];
  const initializedUrls = [];
  const dlModule = new SyntheticModule(['default'], function () {
    this.setExport('default', async url => initializedUrls.push(url));
  });
  await dlModule.link(() => {});
  await dlModule.evaluate();

  const source = await readFile(new URL('./ModelWeights.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, {
    importModuleDynamically: async url => {
      importedUrls.push(url);
      return dlModule;
    },
  });
  await module.link(() => new SyntheticModule(['fetchModel'], function () {
    this.setExport('fetchModel', () => {
      throw new Error('Loading the DL runtime must not fetch model weights');
    });
  }));
  await module.evaluate();

  const first = module.namespace.loadDlWasm('https://example.org/qsmbly', '0.31.20261016');
  const second = module.namespace.loadDlWasm('https://example.org/qsmbly', '0.31.20261016');
  expect(await first).toBe(await second);
  expect(importedUrls).toEqual([
    'https://example.org/qsmbly/wasm/qsm_wasm_dl.js?v=0.31.20261016',
  ]);
  expect(initializedUrls).toEqual([
    'https://example.org/qsmbly/wasm/qsm_wasm_dl_bg.wasm',
  ]);
});
