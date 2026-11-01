import assert from 'node:assert/strict';
import test from 'node:test';
import {checkInstallation} from '../src/node.js';

test('installation check loads the native runtime and external assets',async()=>{
  const result=await checkInstallation({
    registrationModule:new URL('../../registration/wasm/syncro-registration.mjs',import.meta.url),
    registrationWasm:new URL('../../registration/wasm/syncro-registration.wasm',import.meta.url),
    greedy:{glue:new URL('../../greedy/wasm-single/greedy_rs_wasm.js',import.meta.url),binary:new URL('../../greedy/wasm-single/greedy_rs_wasm_bg.wasm',import.meta.url)},
  });
  assert.equal(result.platform,process.platform);
  assert.equal(result.arch,process.arch);
  assert.equal(result.node,process.version);
  assert.equal(result.executable,process.execPath);
  assert.equal(result.onnxRuntime,'1.29.0');
  assert.equal(result.templateSha256,'32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212');
  assert.equal(result.registrationWasmSha256,'0583607d257eb0913bc7b7bef5c4846f99e802a4766c2c3558b6373909e78c72');
  assert.match(result.greedyWasmSha256,/^[0-9a-f]{64}$/);
});
