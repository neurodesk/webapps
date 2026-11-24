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
import {registerAffineGreedy,registerGreedy,resliceAffineGreedy,resliceGreedy} from '../../greedy/src/index.js';
import {runMindgrab} from '../../brain-extraction/src/mindgrab.js';
import {loadMindgrabCpu} from '@neurodesk/node-drivers/mindgrab';
import {loadGreedySingleThread} from '../../greedy/src/single.js';
import {REGISTRATION_WASM_SHA256 as registrationWasmSha256,readRegistrationWasm} from '../../registration/src/node.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
export const defaultCacheDir=()=>process.env.NEURODESK_SYNCRO_MODEL_DIR||join(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'),'neurodesk','syncro');
const templateURL=new URL('../data/MNI152_T1_1mm_brain.nii.gz',import.meta.url);
const templateSha256='32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212';
// Greedy's single-threaded build, which scripts/build.mjs copies beside the bundle.
const greedyFiles={glue:new URL('./greedy/greedy_rs_wasm.js',import.meta.url),binary:new URL('./greedy/greedy_rs_wasm_bg.wasm',import.meta.url)};
const NORMALIZATIONS=['greedy','ants'];
const EXTRACTORS=['mindgrab','synthstrip'];
export async function checkInstallation({
  registrationModule=new URL('./registration/syncro-registration.mjs',import.meta.url),
  registrationWasm=new URL('./registration/syncro-registration.wasm',import.meta.url),
  greedy=greedyFiles,
}={}) {
  const template=await readFile(templateURL);
  if(hash(template)!==templateSha256)throw new Error('Template checksum mismatch.');
  await readRegistrationWasm(registrationWasm);
  const greedyApi=await loadGreedySingleThread(greedy);
  if(typeof greedyApi.register_nmi_svf_wasm!=='function')throw new Error('Greedy module did not load.');
  const [{default:createModule},ort]=await Promise.all([import(registrationModule),import('onnxruntime-node')]);
  if(typeof createModule!=='function')throw new Error('Registration module did not load.');
  const mindgrab=await loadMindgrabCpu(import.meta.resolve('@brainchop/core/package.json'));
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
    greedyWasmSha256:hash(await readFile(greedy.binary)),
    mindgrab:mindgrab.version,
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
export async function normalize({input,output,additional=[],ct=false,normalization='greedy',brainExtractor='mindgrab',threads=Number(process.env.SLURM_CPUS_PER_TASK)||Math.min(4,availableParallelism()),cacheDir,offline=process.env.NEURODESK_OFFLINE==='1',resume=false,onProgress=()=>{}}={}) {
  if(!input||!output)throw new Error('Input image and output directory are required.');
  if(!Number.isSafeInteger(threads)||threads<1)throw new Error('Threads must be a positive integer.');
  if(!NORMALIZATIONS.includes(normalization))throw new Error('Normalization must be greedy or ants.');
  if(!EXTRACTORS.includes(brainExtractor))throw new Error('Brain extractor must be mindgrab or synthstrip.');
  const lesions=additional.filter(item=>item.type==='binary'),pathologicals=additional.filter(item=>item.type==='image');
  if(lesions.length+pathologicals.length!==additional.length)throw new Error('Accompanying inputs must be a lesion map or a pathological modality scan.');
  if(lesions.length>1)throw new Error('SYNcro accepts at most one lesion map.');
  if(pathologicals.length>1)throw new Error('SYNcro accepts at most one pathological modality scan.');
  const accompanying=async item=>item&&{name:basename(item.path),buffer:asBuffer(await readFile(item.path))};
  const [lesion,pathological]=await Promise.all([accompanying(lesions[0]),accompanying(pathologicals[0])]);
  const inputBytes=await readFile(input),out=resolve(output),checkpoint=join(out,'.checkpoints');
  const template=await readFile(templateURL);
  if(hash(template)!==templateSha256)throw new Error('Template checksum mismatch.');
  const registrationURL=new URL('./registration/syncro-registration.mjs',import.meta.url);
  const wasm=normalization==='ants'?await readRegistrationWasm(new URL('./registration/syncro-registration.wasm',import.meta.url)):await readFile(greedyFiles.binary);
  const fingerprint=hash(JSON.stringify({
    input:[basename(input),hash(inputBytes)],
    lesion:lesion&&[lesion.name,hash(Buffer.from(lesion.buffer))],
    pathological:pathological&&[pathological.name,hash(Buffer.from(pathological.buffer))],
    ct,normalization,brainExtractor,
    code:hash(await readFile(new URL(import.meta.url))),
    wasm:hash(wasm),
    affineWasm:normalization==='ants'&&pathological?hash(await readFile(greedyFiles.binary)):null,
    template:hash(template),
    models:Object.values(assets).map(a=>a.sha256),
  }));
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
  const represent=async({buffer,compressed})=>{
    const bytes=Buffer.from(buffer);
    const gzipped=bytes[0]===0x1f&&bytes[1]===0x8b;
    if(compressed)return new Uint8Array(gzipped?bytes:gzipSync(bytes));
    return new Uint8Array(gzipped?gunzipSync(bytes):bytes);
  };
  let engine,api,fixed;
  const registerAffine=async args=>{api??=await loadGreedySingleThread(greedyFiles);return registerAffineGreedy({api,fixed:args.fixed,moving:args.moving});};
  const ants={
    provenance:{engine:'ANTs 2.6.2',method:'SyN',seed:42,precision:'float',threads:1},
    async register(args){const {default:createModule}=await import(registrationURL);engine=await createRegistration({createModule,wasmBinary:wasm,onLog:m=>onProgress('registration',null,m)});const registered=engine.register(args);return {...registered,warped:await represent({buffer:registered.warped,compressed:args.compressed})};},
    // The pathological scan's affine and its preceding reslice run on Greedy, as in the web app.
    registerAffine,
    async apply({registration,moving,compressed,interpolation,fill,precedingMatrix,precedingFixed}){
      const prepared=precedingMatrix?resliceAffineGreedy({api,fixed:precedingFixed,moving,matrix:precedingMatrix,interpolation,fill}):moving;
      return represent({buffer:engine.apply({registration,moving:prepared,interpolation,fill}),compressed});
    },
    release:reg=>engine.release(reg),
  };
  // The web app's Greedy calls (apps/syncro/src/worker.js) on the single-threaded build, which gives
  // the threaded build's bytes.
  const greedy={
    provenance:{engine:'Greedy',method:'affine + NMI stationary velocity field',threads:1},
    registerAffine,
    async register(args){api??=await loadGreedySingleThread(greedyFiles);fixed=new Uint8Array(args.fixed);const registered=registerGreedy({api,fixed,moving:args.moving,mode:'deformable',onProgress:m=>onProgress('registration',null,m)});return {matrix:registered.matrix,warp:registered.warp,warped:await represent({buffer:registered.image,compressed:args.compressed})};},
    async apply({registration,moving,compressed,interpolation,fill,precedingMatrix}){return represent({buffer:resliceGreedy({api,fixed,moving,registration,precedingMatrix,interpolation,fill}),compressed});},
    release(){},
  };
  const result=await runSyncro({input:asBuffer(inputBytes),inputName:basename(input),lesion,pathological,template:asBuffer(template),ct,onProgress,
    brainExtractor,normalization,represent,
    synthesize:args=>cached('synthsr',()=>runSynthsr({buffer:args.buffer,options:{ct,backend:'cpu'},loadModel:async()=>models.synthsr,createSession,Tensor:ort.Tensor,onProgress:args.onProgress,runtime:{threads,onnxRuntime:ort.env.versions.node}}),
      r=>({'synthsr.nii':new Uint8Array(r.buffer)}),(f,provenance)=>({buffer:asBuffer(f['synthsr.nii']),provenance})),
    extractBrain:args=>cached(brainExtractor,brainExtractor==='mindgrab'
      ? async()=>{const {segment,version}=await loadMindgrabCpu(import.meta.resolve('@brainchop/core/package.json'));return runMindgrab({...args,backend:'cpu',runtime:{segment:(input,options)=>segment(input,{...options,threads}),version}});}
      : ()=>runSynthstrip({...args,loadModel:async()=>models.synthstrip,createSession,Tensor:ort.Tensor}),
      r=>({'brain.nii':new Uint8Array(writeVolume(r.brain)),'mask.nii':new Uint8Array(writeVolume(r.mask))}),
      (f,provenance)=>({brain:readVolume(asBuffer(f['brain.nii'])),mask:{...readVolume(asBuffer(f['mask.nii'])),data:Uint8Array.from(readVolume(asBuffer(f['mask.nii'])).data)},provenance})),
    registration:normalization==='ants'?ants:greedy,
  });
  result.provenance.input=resolve(input);result.provenance.inputHash=hash(inputBytes);result.provenance.templateHash=hash(template);result.provenance.registrationWasmHash=hash(wasm);
  result.outputs['provenance.json']=new TextEncoder().encode(JSON.stringify(result.provenance,null,2)+'\n');
  for(const [name,data]of Object.entries(result.outputs)) {
    const temp=join(out,name+'.'+randomUUID()+'.partial');await writeFile(temp,data,{flag:'wx'});await rename(temp,join(out,name));
  }
  return {output:out,provenance:result.provenance};
}
