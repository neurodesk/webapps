import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const check=fileURLToPath(new URL('../validation/package-check.mjs',import.meta.url));
const template=fileURLToPath(new URL('../data/MNI152_T1_1mm_brain.nii.gz',import.meta.url));

// A stand-in for the installed command. Its normalisation copies the MNI152 template into every
// output and draws a 6 mm lesion at MNI (-30, -10, 20), then applies FAKE_SYNCRO_DEFECT.
const fake=`#!/usr/bin/env node
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
const args=process.argv.slice(2);
const fail=message=>{console.error(message);process.exit(1);};
if(args[0]==='--help'){console.log('usage');process.exit(0);}
if(args[0]==='self-check'){console.log(JSON.stringify({executable:process.execPath}));process.exit(0);}
if(args[0]==='download-models')fail('Model is missing from the offline installation.');
if(args.includes('--resume'))fail('Checkpoint input, options or software differ.');
if(args[args.indexOf('--threads')+1]==='0')fail('Threads must be a positive integer.');
const [input,output]=args;
if(await stat(output).catch(()=>null))fail('Output directory already exists.');
const defect=process.env.FAKE_SYNCRO_DEFECT;
const bytes=gunzipSync(await readFile(${JSON.stringify(template)}));
const header=Buffer.from(bytes.subarray(0,352));
const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
const [nx,ny,nz]=[42,44,46].map(offset=>view.getInt16(offset,true));
const brain=new Int16Array(nx*ny*nz);
for(let i=0;i<brain.length;i+=1)brain[i]=bytes.readInt16LE(352+i*2);
const shifted=new Int16Array(brain.length);
const shift=defect==='shift'?2:0;
for(let i=0;i<brain.length;i+=1){const x=i%nx;if(x+shift<nx)shifted[i+shift]=brain[i];}
const lesion=new Int16Array(brain.length);
const centreX=defect==='lesion-right'?30:-30;
for(let i=0;i<lesion.length;i+=1){
  const voxel=[i%nx,Math.floor(i/nx)%ny,Math.floor(i/(nx*ny))];
  const mm=[90-voxel[0],voxel[1]-126,voxel[2]-72];
  if(Math.hypot(mm[0]-centreX,mm[1]+10,mm[2]-20)<=6)lesion[i]=1;
}
const nifti=data=>gzipSync(Buffer.concat([header,Buffer.from(data.buffer)]));
await mkdir(output);
const name=basename(input);
const primary=defect==='garbage'?brain.map((value,i)=>(i*7919)%1000):shifted;
await writeFile(join(output,'wbt1'+name),nifti(shifted));
await writeFile(join(output,'w'+name),nifti(primary));
await writeFile(join(output,'wlesion.nii'),nifti(lesion));
console.log(output);
`;

async function runCheck(defect) {
  const directory=await mkdtemp(join(tmpdir(),'syncro-fake-'));
  try {
    const executable=join(directory,'syncro');
    await writeFile(executable,fake);
    await chmod(executable,0o755);
    const result=spawnSync(process.execPath,[check,'--executable',executable],{encoding:'utf8',env:{...process.env,FAKE_SYNCRO_DEFECT:defect}});
    return {status:result.status,output:result.stdout+result.stderr};
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}

const posix={skip:process.platform==='win32'&&'the stand-in command is a shebang script'};

test('the release check passes outputs that match the template and the lesion hemisphere',posix,async()=>{
  const {status,output}=await runCheck('none');
  assert.equal(status,0,output);
  assert.doesNotMatch(output,/^FAIL/m);
});

test('the release check fails a lesion propagated into the wrong hemisphere',posix,async()=>{
  const {status,output}=await runCheck('lesion-right');
  assert.equal(status,1,output);
  assert.match(output,/^FAIL left lesion stays left/m);
  assert.match(output,/^FAIL lesion centre/m);
});

test('the release check fails a normalisation 2 mm off the template',posix,async()=>{
  const {status,output}=await runCheck('shift');
  assert.equal(status,1,output);
  assert.match(output,/^FAIL warped brain correlation/m);
});

test('the release check fails a scan that is not the brain it normalised',posix,async()=>{
  const {status,output}=await runCheck('garbage');
  assert.equal(status,1,output);
  assert.match(output,/^FAIL warped scan correlation/m);
});
