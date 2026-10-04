import {test,expect} from '@playwright/test';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {readVolume} from '@neurodesk/synthsr';

// Exercise the actual built SYNcro inference worker, including its model loader,
// backend routing, padded-shape propagation, augmentation and provenance.
for (const backend of ['wasm','webgpu']) test(`shared SynthSR stage: ${backend} matches the reference`,async({page})=>{
 test.skip(!process.env.SYNTHSR_MODEL,'Set SYNTHSR_MODEL to the checksum-pinned ONNX model.');
 test.setTimeout(300000);
 await page.route('**/test-model/synthsr-v2.onnx',route=>route.fulfill({path:process.env.SYNTHSR_MODEL}));
 await page.goto('./');
 if (backend === 'webgpu') {
  const info = await page.evaluate(async () => {
   const adapter = await navigator.gpu?.requestAdapter();
   if (!adapter) return null;
   return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter };
  });
  expect(info).not.toBeNull();
  if (process.env.SYNCRO_HARDWARE_GPU) expect(info.isFallbackAdapter).toBe(false);
  await test.info().attach('webgpu-adapter', { body: JSON.stringify(info), contentType: 'application/json' });
 }
 const fixture=new URL('../../synthsr/test/fixtures/validation.nii.gz',import.meta.url);
 await page.locator('#input').setInputFiles(fileURLToPath(fixture));
 await expect(page.locator('#statusText')).toContainText('Ready to normalize',{timeout:30000});
 const name=(await readdir(new URL('../dist/assets/',import.meta.url))).find(n=>/^inference-worker-.*\.js$/.test(n));
 expect(name).toBeTruthy();
 const result=await page.evaluate(async({name,backend})=>{
  const worker=new Worker(new URL('assets/'+name,location.href),{type:'module'});
  try{const buffer=await document.querySelector('#input').files[0].arrayBuffer();
  return await new Promise((resolve,reject)=>{
   worker.onerror=e=>reject(new Error(e.message));
   worker.onmessage=({data})=>{
    if(data.type==='error')reject(new Error(data.message));
    if(data.type==='result')resolve({buffer:Array.from(new Uint8Array(data.result.buffer)),provenance:data.result.provenance});
   };
   worker.postMessage({stage:'synthsr',backend,buffer,modelBase:new URL('test-model/',location.href).href});
  });}finally{worker.terminate();}
 },{name,backend});
 const output=readVolume(Uint8Array.from(result.buffer).buffer);
 const expected=readVolume(new Uint8Array(await readFile(new URL('../../synthsr/test/fixtures/validation-reference.nii.gz',import.meta.url))).buffer);
 expect(output.dims).toEqual(expected.dims);
 expect(output.affine).toEqual(expected.affine);
 let mismatches=0,maxError=0;
 for(let i=0;i<output.data.length;i++){
  const delta=Math.abs(output.data[i]-expected.data[i]);
  maxError=Math.max(maxError,delta);mismatches+=delta!==0;
 }
 expect(maxError).toBeLessThanOrEqual(1);
 expect(mismatches/output.data.length).toBeLessThan(.001);
 expect(result.provenance).toMatchObject({app:'SYNcro',backend,flip:true,sharpen:true,tiled:false});
 if(backend==='webgpu'){
  expect(result.provenance.gpuImplementation).toBe('synthsr-blocked-fp32-v1');
  expect(result.provenance.onnxRuntime).toBeUndefined();
 }else expect(result.provenance.onnxRuntime).toBe('1.29.0');
});
