import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import {readVolume,runSynthsr} from '@neurodesk/synthsr';
import {createBrowserSession,browserRuntime} from '@neurodesk/synthsr/browser';
import {runSynthstrip} from '@neurodesk/synthstrip';
import {createBrowserSession as createStripSession} from '@neurodesk/synthstrip/browser';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import {assets,browserSynthstrip} from '../../../packages/syncro/src/assets.js';
import {runMindgrab} from '@neurodesk/brain-extraction/mindgrab';
import * as mindgrab from '@brainchop/mindgrab';
import mindgrabPackage from '@brainchop/mindgrab/package.json' with { type: 'json' };
import {withBackendChoice} from '@neurodesk/runtime-support/mindgrab/backend';
ort.env.wasm.wasmPaths={wasm:wasmURL,mjs:wasmModuleURL};
ort.env.wasm.numThreads=self.crossOriginIsolated?Math.min(4,navigator.hardwareConcurrency||1):1;
async function model(name,base) {
 const asset=name==='synthstrip'?browserSynthstrip:assets[name];
 const url=name==='synthstrip'?asset.url:base?new URL('synthsr-v2.onnx',base).href:asset.url;
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
   const output={brain:result.brain,provenance:result.provenance};
   self.postMessage({type:'result',result:output},[output.brain.data.buffer]);return;
  }
  const runtime={app:'SYNcro',...browserRuntime(job.backend??'webgpu'),threads:ort.env.wasm.numThreads};
  const common={loadModel:()=>model(job.stage,job.modelBase),
   createSession:job.stage==='synthsr'
    ? (bytes,backend,shape)=>{Object.assign(runtime,browserRuntime(backend,shape));return createBrowserSession(ort,bytes,backend,shape,{
      bufferLimitHelp:'Use native SynthSR or another device for full-volume processing.',
    });}
    : (bytes,shape)=>createStripSession(bytes,shape,ort),
   Tensor:ort.Tensor,onProgress:(value,message)=>self.postMessage({type:'progress',value,message})};
  const result=job.stage==='synthsr'?await runSynthsr({...common,buffer:job.buffer,options:{ct:job.ct,backend:job.backend??'webgpu'},runtime}):await runSynthstrip({...common,volume:job.volume??readVolume(job.buffer)});
  if(job.stage==='synthsr')self.postMessage({type:'result',result},[result.buffer]);
  else {
   const output={brain:result.brain,provenance:result.provenance};
   self.postMessage({type:'result',result:output},[output.brain.data.buffer]);
  }
 }catch(e){self.postMessage({type:'error',message:e.message||String(e)});}
};
