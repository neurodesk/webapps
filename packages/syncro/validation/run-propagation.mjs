import {readFile,writeFile} from 'node:fs/promises';
import createModule from '../../registration/wasm/syncro-registration.mjs';
import {createRegistration} from '../../registration/src/index.js';
import {gaussian,readVolume,writeVolume} from '../../synthsr/src/index.js';
// The web app's lesion handling as it was when the container comparison ran (pipeline.js at 55199029d): FWHM 3 mm
// smoothing before nearest-neighbour warping, then a 0.5 threshold.
const asBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
function prepareAdditional(volume,type) {
  if(type!=='binary')return volume;
  const sigma=3/(2*Math.sqrt(2*Math.log(2)));
  const sigmas=[0,1,2].map(axis=>sigma/Math.hypot(...volume.affine.slice(0,3).map(row=>row[axis])));
  return {...volume,data:gaussian(volume.data,volume.dims,sigmas)};
}
const thresholdBinary=volume=>({...volume,data:Uint8Array.from(volume.data,value=>value>=0.5?1:0)});
const w=process.argv[2];
const engine=await createRegistration({createModule,wasmBinary:await readFile(new URL('../../registration/wasm/syncro-registration.wasm',import.meta.url)),onLog:console.log});
const transforms={};for(const name of ['0GenericAffine.mat','1Warp.nii.gz','1InverseWarp.nii.gz'])transforms[name]=await readFile(w+'/reference/transform-'+name);
const reg=engine.importTransforms({fixed:writeVolume(readVolume(asBuffer(await readFile(w+'/reference/template.nii.gz')))),transforms});
try{for(const type of ['binary','labels']){
 const source=readVolume(asBuffer(await readFile(w+'/'+type+'.nii.gz')));
 const volume=type==='binary'?prepareAdditional(source,type):source;
 if(type==='binary')await writeFile(w+'/web-binary-smoothed.nii',new Uint8Array(writeVolume(volume)));
 let out=engine.apply({registration:reg,moving:writeVolume(volume),interpolation:type==='labels'?'nearest':'linear'});
 if(type==='binary')out=new Uint8Array(writeVolume(thresholdBinary(readVolume(asBuffer(out)))));
 await writeFile(w+'/web-'+type+(type==='binary'?'.nii':'.nii.gz'),out);
}}finally{engine.release(reg);}
