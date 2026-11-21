import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import {readVolume,runSynthsr} from '@neurodesk/synthsr';
import {createBrowserSession,browserRuntime} from '@neurodesk/synthsr/browser';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import {assets} from '../../../packages/syncro/src/assets.js';
import {runMindgrab} from '@neurodesk/brain-extraction/mindgrab';
import * as mindgrab from '@brainchop/core';
import mindgrabPackage from '@brainchop/core/package.json' with { type: 'json' };
import {withBackendChoice} from '@neurodesk/runtime-support/mindgrab/backend';
ort.env.wasm.wasmPaths={wasm:wasmURL,mjs:wasmModuleURL};
ort.env.wasm.numThreads=self.crossOriginIsolated?Math.min(4,navigator.hardwareConcurrency||1):1;
async function model(name,base) {
 const asset=assets[name];
 const url=base?new URL('synthsr-v2.onnx',base).href:asset.url;
 const bytes = await fetchModel({ url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
  requestFailureMessage: `Unable to download the ${name} model. Check your connection and try again.`,
 });
 return {bytes,hash:asset.sha256};
}
self.onmessage=async({data:job})=>{
 try {
  if(job.stage==='mindgrab') {
   const result=await runMindgrab({volume:job.volume??readVolume(job.buffer),assetPath:job.assetPath,backend:job.brainBackend??'auto',
    runtime:{segment:withBackendChoice(mindgrab).segment,version:mindgrabPackage.version},
    onProgress:(value,message)=>self.postMessage({type:'progress',value,message}),
    onLog:message=>self.postMessage({type:'log',message})});
   const output={brain:result.brain,mask:result.mask,provenance:result.provenance};
   self.postMessage({type:'result',result:output},[output.brain.data.buffer,output.mask.data.buffer]);return;
  }
  const runtime={app:'SYNcro',...browserRuntime(job.backend??'webgpu'),threads:ort.env.wasm.numThreads};
  const common={loadModel:()=>model(job.stage,job.modelBase),
   createSession:(bytes,backend,shape)=>{Object.assign(runtime,browserRuntime(backend,shape));return createBrowserSession(ort,bytes,backend,shape,{
     bufferLimitHelp:'Use native SynthSR or another device for full-volume processing.',
   });},
   Tensor:ort.Tensor,onProgress:(value,message)=>self.postMessage({type:'progress',value,message})};
  if(job.stage!=='synthsr')throw new Error(`Unknown inference stage ${job.stage}.`);
  const result=await runSynthsr({...common,buffer:job.buffer,options:{ct:job.ct,backend:job.backend??'webgpu'},runtime});
  self.postMessage({type:'result',result},[result.buffer]);
 }catch(e){self.postMessage({type:'error',message:e.message||String(e)});}
};
