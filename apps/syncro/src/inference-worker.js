import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import {readVolume,runSynthsr} from '@neurodesk/synthsr';
import {createBrowserSession,browserRuntime} from '@neurodesk/synthsr/browser';
import {runSynthstrip} from '@neurodesk/synthstrip';
import {assets,browserSynthstrip} from '../../../packages/syncro/src/assets.js';
import {runMindgrab} from '@neurodesk/brain-extraction/mindgrab';
ort.env.wasm.wasmPaths={wasm:wasmURL,mjs:wasmModuleURL};
ort.env.wasm.numThreads=self.crossOriginIsolated?Math.min(4,navigator.hardwareConcurrency||1):1;
const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
async function model(name,base) {
 const asset=name==='synthstrip'?browserSynthstrip:assets[name];
 const url=name==='synthstrip'?asset.url:base?new URL('synthsr-v2.onnx',base).href:asset.url;
 let cache;try{cache=await caches.open(name==='synthsr'?'neurodesk-synthsr-v1':'neurodesk-models-v1');}catch{}
 let bytes;
 const response=await cache?.match(url)||await fetch(url);if(!response.ok)throw new Error(`Unable to download the ${name} model. Check your connection and try again.`);bytes=await response.arrayBuffer();
 if(bytes.byteLength!==asset.bytes||await sha(bytes)!==asset.sha256){await cache?.delete(url);throw new Error(`${name} model checksum mismatch.`);}
 try{await cache?.put(url,new Response(bytes));}catch{}
 return {bytes,hash:asset.sha256};
}
self.onmessage=async({data:job})=>{
 try {
  if(job.stage==='mindgrab') {
   const result=await runMindgrab({volume:job.volume??readVolume(job.buffer),assetPath:job.assetPath,backend:job.brainBackend??'auto',
    onProgress:(value,message)=>self.postMessage({type:'progress',value,message}),
    onLog:message=>self.postMessage({type:'log',message})});
   const output={brain:result.brain,provenance:result.provenance};
   self.postMessage({type:'result',result:output},[output.brain.data.buffer]);return;
  }
  const runtime={app:'SYNcro',...browserRuntime(job.backend??'webgpu'),threads:ort.env.wasm.numThreads};
  const common={loadModel:()=>model(job.stage,job.modelBase),
   createSession:job.stage==='synthsr'
    ? (bytes,backend,shape)=>{Object.assign(runtime,browserRuntime(backend,shape));return createBrowserSession(ort,bytes,backend,shape,{
      bufferLimitHelp:'Use native SynthSR or another device for full-volume processing.',
    });}
    : bytes=>ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'}),
   Tensor:ort.Tensor,onProgress:(value,message)=>self.postMessage({type:'progress',value,message})};
  const result=job.stage==='synthsr'?await runSynthsr({...common,buffer:job.buffer,options:{ct:job.ct,backend:job.backend??'webgpu'},runtime}):await runSynthstrip({...common,volume:job.volume??readVolume(job.buffer)});
  if(job.stage==='synthsr')self.postMessage({type:'result',result},[result.buffer]);
  else {
   const output={brain:result.brain,provenance:result.provenance};
   self.postMessage({type:'result',result:output},[output.brain.data.buffer]);
  }
 }catch(e){self.postMessage({type:'error',message:e.message||String(e)});}
};
