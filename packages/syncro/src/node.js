import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {homedir,availableParallelism} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {runSyncro,asBuffer} from './pipeline.js';
import {assets} from './assets.js';
import {runSynthsr,readVolume,writeVolume} from '../../synthsr/src/index.js';
import {runSynthstrip} from '../../synthstrip/src/index.js';
import {createRegistration} from '../../registration/src/index.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
export const defaultCacheDir=()=>process.env.NEURODESK_SYNCRO_MODEL_DIR||join(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'),'neurodesk','syncro');
const templateURL=new URL('../data/MNI152_T1_1mm_brain.nii.gz',import.meta.url);
const templateSha256='32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212';
const registrationWasmSha256='23cb91e0a9363cce16581d459ee52dabbf35538a2ad4ed565d2d83cd4a116348';
export async function checkInstallation({
  registrationModule=new URL('./registration/syncro-registration.mjs',import.meta.url),
  registrationWasm=new URL('./registration/syncro-registration.wasm',import.meta.url),
}={}) {
  const template=await readFile(templateURL),wasm=await readFile(registrationWasm);
  if(hash(template)!==templateSha256)throw new Error('Template checksum mismatch.');
  if(hash(wasm)!==registrationWasmSha256)throw new Error('Registration WebAssembly checksum mismatch.');
  if(wasm.subarray(0,4).toString('hex')!=='0061736d')throw new Error('Registration asset is not WebAssembly.');
  const [{default:createModule},ort]=await Promise.all([import(registrationModule),import('onnxruntime-node')]);
  if(typeof createModule!=='function')throw new Error('Registration module did not load.');
  const tensor=new ort.Tensor('float32',Float32Array.of(0),[1]);
  if(tensor.size!==1)throw new Error('ONNX Runtime tensor check failed.');
  const bundledModels=process.env.NEURODESK_SYNCRO_MODEL_DIR ? await downloadModels({offline:true}) : null;
  return {
    ...(bundledModels ? {models:Object.fromEntries(Object.entries(bundledModels).map(([name,value])=>[name,value.hash]))} : {}),
    platform:process.platform,
    arch:process.arch,
    node:process.version,
    executable:process.execPath,
    onnxRuntime:ort.env.versions.node,
    templateSha256,
    registrationWasmSha256,
  };
}
export async function downloadModels({cacheDir=defaultCacheDir(),offline=process.env.NEURODESK_OFFLINE==='1',onProgress=()=>{}}={}) {
  const result={};
  for(const [name,asset]of Object.entries(assets)) {
    const path=join(cacheDir,asset.sha256,name+'.onnx');let bytes;
    try {bytes=await readFile(path);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(bytes&&(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256))throw new Error(`Cached ${name} model failed checksum verification: ${path}`);
    if(!bytes) {
      if(offline)throw new Error(`${name} is missing from the offline installation. Reinstall the complete release.`);
      onProgress('download',0,`Downloading ${name}…`);const response=await fetch(asset.url);
      if(!response.ok)throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
      bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)throw new Error(`${name} download failed checksum verification.`);
      await mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.partial';
      await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,path);
    }
    result[name]={bytes,hash:asset.sha256};
  }
  return result;
}
export async function normalize({input,output,additional=[],ct=false,threads=Number(process.env.SLURM_CPUS_PER_TASK)||Math.min(4,availableParallelism()),cacheDir,offline=process.env.NEURODESK_OFFLINE==='1',resume=false,onProgress=()=>{}}={}) {
  if(!input||!output)throw new Error('Input image and output directory are required.');
  if(!Number.isSafeInteger(threads)||threads<1)throw new Error('Threads must be a positive integer.');
  const inputBytes=await readFile(input),out=resolve(output),checkpoint=join(out,'.checkpoints');
  const template=await readFile(templateURL);
  if(hash(template)!==templateSha256)throw new Error('Template checksum mismatch.');
  const registrationURL=new URL('./registration/syncro-registration.mjs',import.meta.url);
  const wasm=await readFile(new URL('./registration/syncro-registration.wasm',import.meta.url));
  const fingerprint=hash(JSON.stringify({input:hash(inputBytes),ct,code:hash(await readFile(new URL(import.meta.url))),wasm:hash(wasm),template:hash(template),models:Object.values(assets).map(a=>a.sha256)}));
  let exists=false;try{await stat(out);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(exists) {
    if(!resume)throw new Error('Output directory already exists. Choose a new directory or --resume an interrupted SYNcro run.');
    const marker=JSON.parse(await readFile(join(checkpoint,'run.json'),'utf8'));
    if(marker.fingerprint!==fingerprint)throw new Error('Checkpoint input, options or software differ. Choose a new output directory.');
  } else {await mkdir(checkpoint,{recursive:true});await writeFile(join(checkpoint,'run.json'),JSON.stringify({fingerprint}));}
  const models=await downloadModels({cacheDir,offline,onProgress});
  const ort=await import('onnxruntime-node');
  const createSession=bytes=>ort.InferenceSession.create(bytes,{executionProviders:['cpu'],intraOpNumThreads:threads,interOpNumThreads:1,graphOptimizationLevel:'all'});
  async function cached(name,fn,encode,decode) {
    const record=join(checkpoint,name+'.json');
    if(resume) {
      try {
        const metadata=JSON.parse(await readFile(record,'utf8')),files={};
        for(const [file,checksum]of Object.entries(metadata.files)){const b=await readFile(join(checkpoint,file));if(hash(b)!==checksum)throw new Error(`Checkpoint corrupted: ${file}`);files[file]=b;}
        onProgress(name,1,`Reusing verified ${name} checkpoint`);return decode(files,metadata.provenance);
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const result=await fn(),files=encode(result),checksums={};
    for(const [file,data]of Object.entries(files)){await writeFile(join(checkpoint,file),data);checksums[file]=hash(data);}
    await writeFile(record,JSON.stringify({files:checksums,provenance:result.provenance}));return result;
  }
  const unsupported=additional.filter(item=>item.type!=='binary');
  if(unsupported.length)throw new Error('The Node package accepts one --lesion input. Use the native SYNcro command or webapp for pathological modalities.');
  if(additional.length>1)throw new Error('SYNcro accepts at most one lesion map.');
  const lesion=additional[0]?{name:basename(additional[0].path),buffer:asBuffer(await readFile(additional[0].path))}:null;
  const represent=async({buffer,compressed})=>{
    const bytes=Buffer.from(buffer);
    const gzipped=bytes[0]===0x1f&&bytes[1]===0x8b;
    if(compressed)return new Uint8Array(gzipped?bytes:gzipSync(bytes));
    return new Uint8Array(gzipped?gunzipSync(bytes):bytes);
  };
  let engine;
  const result=await runSyncro({input:asBuffer(inputBytes),inputName:basename(input),lesion,template:asBuffer(template),ct,onProgress,
    brainExtractor:'synthstrip',normalization:'ants',represent,
    synthesize:args=>cached('synthsr',()=>runSynthsr({buffer:args.buffer,options:{ct,backend:'cpu'},loadModel:async()=>models.synthsr,createSession,Tensor:ort.Tensor,onProgress:args.onProgress,runtime:{threads,onnxRuntime:ort.env.versions.node}}),
      r=>({'synthsr.nii':new Uint8Array(r.buffer)}),(f,provenance)=>({buffer:asBuffer(f['synthsr.nii']),provenance})),
    extractBrain:args=>cached('synthstrip',()=>runSynthstrip({...args,loadModel:async()=>models.synthstrip,createSession,Tensor:ort.Tensor}),
      r=>({'brain.nii':new Uint8Array(writeVolume(r.brain)),'mask.nii':new Uint8Array(writeVolume(r.mask))}),
      (f,provenance)=>({brain:readVolume(asBuffer(f['brain.nii'])),mask:{...readVolume(asBuffer(f['mask.nii'])),data:Uint8Array.from(readVolume(asBuffer(f['mask.nii'])).data)},provenance})),
    registration:{
      provenance:{engine:'ANTs 2.6.2',method:'SyN',seed:42,precision:'float',threads:1},
      async register(args){const {default:createModule}=await import(registrationURL);engine=await createRegistration({createModule,wasmBinary:wasm,onLog:m=>onProgress('registration',null,m)});const registered=engine.register(args);return {...registered,warped:await represent({buffer:registered.warped,compressed:args.compressed})};},
      async apply(args){return represent({buffer:engine.apply(args),compressed:args.compressed});},
      release:reg=>engine.release(reg),
    },
  });
  result.provenance.input=resolve(input);result.provenance.inputHash=hash(inputBytes);result.provenance.templateHash=hash(template);result.provenance.registrationWasmHash=hash(wasm);
  result.outputs['provenance.json']=new TextEncoder().encode(JSON.stringify(result.provenance,null,2)+'\n');
  for(const [name,data]of Object.entries(result.outputs)) {
    const temp=join(out,name+'.'+randomUUID()+'.partial');await writeFile(temp,data,{flag:'wx'});await rename(temp,join(out,name));
  }
  return {output:out,provenance:result.provenance};
}
