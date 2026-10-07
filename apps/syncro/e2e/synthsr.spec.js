import {test,expect} from '@playwright/test';
import {readFile,readdir} from 'node:fs/promises';
import {readVolume} from '@neurodesk/synthsr';

// Exercise the actual built SYNcro inference worker, including its model loader,
// backend routing, padded-shape propagation, augmentation and provenance.
// The model is the checksum-pinned one from Hugging Face; SYNTHSR_MODEL serves a local copy instead.
// WebGPU here is whatever adapter Chromium offers, which on a machine without a GPU is SwiftShader.
for (const backend of ['wasm','webgpu']) test(`shared SynthSR stage: ${backend} matches the reference`,async({page})=>{
 test.setTimeout(600000);
 const local=Boolean(process.env.SYNTHSR_MODEL);
 if(local)await page.route('**/test-model/synthsr-v2.onnx',route=>route.fulfill({path:process.env.SYNTHSR_MODEL}));
 await page.goto('./');
 if(backend==='webgpu')expect(await page.evaluate(async()=>!!await navigator.gpu?.requestAdapter())).toBe(true);
 const fixture=Array.from(await readFile(new URL('../../synthsr/test/fixtures/validation.nii.gz',import.meta.url)));
 const name=(await readdir(new URL('../dist/assets/',import.meta.url))).find(n=>/^inference-worker-.*\.js$/.test(n));
 expect(name).toBeTruthy();
 const result=await page.evaluate(async({name,backend,local,fixture})=>{
  const worker=new Worker(new URL('assets/'+name,location.href),{type:'module'});
  try{const buffer=Uint8Array.from(fixture).buffer;
  return await new Promise((resolve,reject)=>{
   worker.onerror=e=>reject(new Error(e.message));
   worker.onmessage=({data})=>{
    if(data.type==='error')reject(new Error(data.message));
    if(data.type==='result')resolve({buffer:Array.from(new Uint8Array(data.result.buffer)),provenance:data.result.provenance});
   };
   worker.postMessage({stage:'synthsr',backend,buffer,modelBase:local?new URL('test-model/',location.href).href:undefined});
  });}finally{worker.terminate();}
 },{name,backend,local,fixture});
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
