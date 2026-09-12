import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveModel,manifest,defaultThreads,synthesize } from '../src/node.js';
import { readVolume,writeVolume } from '../src/index.js';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/synthsr.js',import.meta.url));
const fixture=name=>fileURLToPath(new URL('../../../apps/synthsr/test/fixtures/'+name,import.meta.url));
const volume=async path=>{const b=await readFile(path);return readVolume(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};

test('standalone manifest matches the browser model pin',async()=>{
  assert.deepEqual(manifest,JSON.parse(await readFile(new URL('../../../models/synthsr.manifest.json',import.meta.url))));
});
test('CLI help/version work without native inference; unknown flags fail',async()=>{
  const {stdout}=await exec(process.execPath,[cli,'--help']);assert.match(stdout,/download-model/);
  assert.equal((await exec(process.execPath,[cli,'--version'])).stdout.trim(),JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
  await assert.rejects(exec(process.execPath,[cli,'--typo']),error=>error.code===1&&error.stderr.includes('Unknown option'));
});
test('offline mode and invalid local weights fail without downloading',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'synthsr-offline-'));
  try {
    await assert.rejects(resolveModel({cacheDir:directory,offline:true}),/not cached/);
    const path=join(directory,'bad.onnx');await writeFile(path,'broken');
    await assert.rejects(resolveModel({modelPath:path,offline:true}),/checksum mismatch/);
    await assert.rejects(resolveModel({modelPath:join(directory,'missing.onnx')}),/not found/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('thread defaults respect the Slurm allocation',()=>{
  const before=process.env.SLURM_CPUS_PER_TASK;
  try {process.env.SLURM_CPUS_PER_TASK='3';assert.equal(defaultThreads(),3);}
  finally {if(before===undefined)delete process.env.SLURM_CPUS_PER_TASK;else process.env.SLURM_CPUS_PER_TASK=before;}
});
test('singleton fourth dimensions remain spatially 3D',()=>{
  const buffer=writeVolume({data:new Uint8Array(8),dims:[2,2,2],affine:[[1,0,0,0],[0,1,0,0],[0,0,1,0]]});
  const header=new DataView(buffer);header.setInt16(40,4,true);header.setInt16(48,1,true);
  assert.deepEqual(readVolume(buffer).dims,[2,2,2]);
  header.setInt16(48,2,true);assert.throws(()=>readVolume(buffer),/single 3D image/);
});
test('invalid thread/device options and output conflicts fail before inference',async()=>{
  const input=fixture('validation.nii.gz');
  await assert.rejects(synthesize({input,threads:0}),/positive integer/);
  await assert.rejects(synthesize({input,device:'webgpu'}),/cpu or cuda/);
  await assert.rejects(synthesize({input,output:input,force:true}),/overwrite the input/);
  const directory=await mkdtemp(join(tmpdir(),'synthsr-protect-'));
  try {
    const output=join(directory,'out.nii.gz');await writeFile(output,'keep this');
    await assert.rejects(synthesize({input,output}),/already exists/);
    assert.equal(await readFile(output,'utf8'),'keep this');
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('native packaged interface matches the TensorFlow fixture with offline weights',{
  skip:!process.env.SYNTHSR_MODEL_PATH,timeout:120000,
},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'synthsr-native-'));
  try {
    const output=join(directory,'native.nii.gz');
    await exec(process.execPath,[cli,fixture('validation.nii.gz'),output,'--model',process.env.SYNTHSR_MODEL_PATH,'--offline','--threads','2','--quiet']);
    const actual=await volume(output),expected=await volume(fixture('validation-reference.nii.gz'));
    assert.deepEqual(actual.dims,expected.dims);
    let max=0,mismatches=0;
    for(let i=0;i<actual.data.length;i++){const delta=Math.abs(actual.data[i]-expected.data[i]);max=Math.max(max,delta);mismatches+=delta!==0;}
    assert.ok(max<=1);assert.ok(mismatches/actual.data.length<.001);
    const report=JSON.parse(await readFile(join(directory,'native.json')));
    assert.equal(report.backend,'cpu');assert.equal(report.threads,2);assert.equal(report.flip,true);
    assert.equal(report.sharpen,true);assert.equal(report.modelSha256,manifest.assets[0].sha256);
    assert.equal(report.onnxRuntime,'1.29.0');assert.ok(report.timings.inference>0);
  } finally {await rm(directory,{recursive:true,force:true});}
});
