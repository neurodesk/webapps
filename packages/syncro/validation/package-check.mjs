// Checks an installed SYNcro command line: rejected inputs, then a full offline normalisation of
// the pinned OpenNeuro ds000001 sub-01 T1w scan with a synthetic left-hemisphere lesion.
// The expected results come from outside SYNcro: the published FSL MNI152 1 mm brain template
// (pinned by SHA-256) and the lesion's hemisphere, which is fixed by construction.
// This file reads NIfTI itself so that no code under test judges its own output.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const INPUT={
  name:'sub-01_T1w.nii.gz',
  source:'https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/anat/sub-01_T1w.nii.gz',
  url:'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/b438d1162e7192ca425ca47282b06fe62340c85a/topofit/0.5.1/onnx-20260911/validation/inputs/sub-01_T1w.nii.gz',
  sha256:'bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98',
};
const TEMPLATE={
  url:new URL('../data/MNI152_T1_1mm_brain.nii.gz',import.meta.url),
  sha256:'32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212',
};
// The lesion sits this far from the head's intensity centroid, in native world millimetres (RAS).
const LESION_OFFSET_MM=[-30,0,10];
const LESION_RADIUS_MM=6;
// Far enough that skipping the pathological-to-primary affine moves the lesion outside lesionXMm.
const PATHOLOGICAL_SHIFT_MM=20;
// With ANTs, Linux, Windows and macOS archives measured Dice 0.9665, correlations 0.815-0.816 and
// 0.701-0.702 (2026-10-06); with Greedy, Linux measured Dice 0.9670, correlations 0.783 and 0.672
// (2026-10-27), both with SynthStrip. With MindGrab, macOS measured Greedy Dice 0.9771, correlations
// 0.851 and 0.757, and ANTs 0.9669, 0.807 and 0.694 (2026-11-21). Without registration the scan
// correlates 0.13; the template shifted 2 mm, 0.74.
const LIMITS={
  brainDice:0.95,
  brainCorrelation:0.77,
  primaryCorrelation:0.65,
  lesionXMm:[-42,-18],
  lesionInsideBrain:0.9,
};

const executableIndex=process.argv.indexOf('--executable');
if(executableIndex<0)throw new Error('usage: package-check.mjs --executable PATH/syncro [--input SCAN]');
const executable=resolve(process.argv[executableIndex+1]);
// A local scan in place of the pinned download. Only the check's own tests pass it, to judge a
// stand-in command without the network; a release check always reads the pinned scan.
const inputIndex=process.argv.indexOf('--input');
const localInput=inputIndex>=0?resolve(process.argv[inputIndex+1]):null;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const failures=[];

function run(args,timeout=30000) {
  const result=spawnSync(executable,args,{encoding:'utf8',timeout,maxBuffer:64*1024*1024});
  if(result.error)throw result.error;
  return result;
}

function check(passed,line) {
  if(!passed)failures.push(line);
  console.log(`${passed?'PASS':'FAIL'} ${line}`);
}

async function pinnedInput() {
  const path=join(tmpdir(),'neurodesk-syncro-validation',INPUT.sha256,INPUT.name);
  const cached=await readFile(path).catch(()=>null);
  if(cached&&sha256(cached)===INPUT.sha256)return path;
  const response=await fetch(INPUT.url);
  if(!response.ok)throw new Error(`${INPUT.url}: HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha256(bytes)!==INPUT.sha256)throw new Error(`${INPUT.url}: SHA-256 differs from its pin`);
  await mkdir(join(path,'..'),{recursive:true});
  await writeFile(`${path}.partial`,bytes);
  await rename(`${path}.partial`,path);
  return path;
}

const READERS={
  2:(view,offset,le)=>view.getUint8(offset),
  4:(view,offset,le)=>view.getInt16(offset,le),
  8:(view,offset,le)=>view.getInt32(offset,le),
  16:(view,offset,le)=>view.getFloat32(offset,le),
  64:(view,offset,le)=>view.getFloat64(offset,le),
  256:(view,offset,le)=>view.getInt8(offset),
  512:(view,offset,le)=>view.getUint16(offset,le),
};

function readNifti(compressedOrRaw) {
  const bytes=compressedOrRaw[0]===0x1f&&compressedOrRaw[1]===0x8b?gunzipSync(compressedOrRaw):compressedOrRaw;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const le=view.getInt32(0,true)===348;
  if(!le&&view.getInt32(0,false)!==348)throw new Error('not a NIfTI-1 file');
  const dims=[1,2,3].map(axis=>view.getInt16(40+axis*2,le));
  const datatype=view.getInt16(70,le);
  const bytesPerVoxel=view.getInt16(72,le)/8;
  const offset=view.getFloat32(108,le);
  const slope=view.getFloat32(112,le)||1;
  const intercept=view.getFloat32(116,le);
  if(view.getInt16(254,le)<=0)throw new Error('NIfTI has no sform');
  const sform=[280,296,312].map(row=>[0,1,2,3].map(column=>view.getFloat32(row+column*4,le)));
  const read=READERS[datatype];
  if(!read)throw new Error(`unsupported NIfTI datatype ${datatype}`);
  const data=new Float32Array(dims[0]*dims[1]*dims[2]);
  for(let i=0;i<data.length;i+=1)data[i]=read(view,offset+i*bytesPerVoxel,le)*slope+intercept;
  return {bytes,le,dims,sform,data};
}

function world(volume,index) {
  const [nx,ny]=volume.dims;
  const voxel=[index%nx,Math.floor(index/nx)%ny,Math.floor(index/(nx*ny)),1];
  return volume.sform.map(row=>row.reduce((sum,value,column)=>sum+value*voxel[column],0));
}

function centroid(volume,weight) {
  const sum=[0,0,0];
  let total=0;
  for(let i=0;i<volume.data.length;i+=1) {
    const w=weight(volume.data[i]);
    if(!w)continue;
    const point=world(volume,i);
    for(let axis=0;axis<3;axis+=1)sum[axis]+=w*point[axis];
    total+=w;
  }
  return sum.map(value=>value/total);
}

// A binary sphere on the input's grid, written as uint8 NIfTI with the input's geometry.
function lesionFixture(input) {
  let mean=0;
  for(const value of input.data)mean+=value/input.data.length;
  const head=centroid(input,value=>value>mean?value:0);
  const centre=head.map((value,axis)=>value+LESION_OFFSET_MM[axis]);
  const mask=new Uint8Array(input.data.length);
  for(let i=0;i<mask.length;i+=1) {
    const point=world(input,i);
    if(Math.hypot(point[0]-centre[0],point[1]-centre[1],point[2]-centre[2])<=LESION_RADIUS_MM)mask[i]=1;
  }
  const header=Buffer.alloc(352);
  input.bytes.copy(header,0,0,348);
  const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
  view.setInt16(70,2,input.le);
  view.setInt16(72,8,input.le);
  view.setFloat32(108,352,input.le);
  view.setFloat32(112,1,input.le);
  view.setFloat32(116,0,input.le);
  return {centre,bytes:Buffer.concat([header,Buffer.from(mask)])};
}

// The scan moved 20 mm along x in world space (sform and qform offsets), standing in for a second
// modality: SYNcro must register it back to the primary scan before the lesion drawn on it is warped.
function shiftedCopy(input,shift=PATHOLOGICAL_SHIFT_MM) {
  const bytes=Buffer.from(input.bytes);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const offset of [268,292])view.setFloat32(offset,view.getFloat32(offset,input.le)+shift,input.le);
  return bytes;
}

function sameGrid(volume,template) {
  const dims=volume.dims.every((value,axis)=>value===template.dims[axis]);
  const affine=volume.sform.every((row,r)=>row.every((value,c)=>Math.abs(value-template.sform[r][c])<1e-3));
  return dims&&affine;
}

function correlation(x,y,include) {
  let n=0;
  let sx=0;
  let sy=0;
  let sxx=0;
  let syy=0;
  let sxy=0;
  for(let i=0;i<x.length;i+=1) {
    if(!include(i))continue;
    n+=1;
    sx+=x[i];
    sy+=y[i];
    sxx+=x[i]*x[i];
    syy+=y[i]*y[i];
    sxy+=x[i]*y[i];
  }
  return (n*sxy-sx*sy)/Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));
}

function dice(x,y) {
  let both=0;
  let a=0;
  let b=0;
  for(let i=0;i<x.length;i+=1) {
    a+=x[i]>0;
    b+=y[i]>0;
    both+=x[i]>0&&y[i]>0;
  }
  return 2*both/(a+b);
}

// Scores normalised outputs against the template and the lesion's known hemisphere.
function score({template,brain,primary,lesion}) {
  const inTemplate=i=>template.data[i]>0;
  const lesionVoxels=[];
  for(let i=0;i<lesion.data.length;i+=1)if(lesion.data[i]>0)lesionVoxels.push(i);
  const lesionCentre=centroid(lesion,value=>value>0?1:0);
  return {
    grids:[brain,primary,lesion].every(volume=>sameGrid(volume,template)),
    brainDice:dice(brain.data,template.data),
    brainCorrelation:correlation(brain.data,template.data,i=>brain.data[i]>0||inTemplate(i)),
    primaryCorrelation:correlation(primary.data,template.data,inTemplate),
    lesionVoxels:lesionVoxels.length,
    lesionCentre,
    lesionRightVoxels:lesionVoxels.filter(i=>world(lesion,i)[0]>0).length,
    lesionInsideBrain:lesionVoxels.filter(inTemplate).length/lesionVoxels.length,
  };
}

function report(metrics,engine) {
  const [low,high]=LIMITS.lesionXMm;
  const x=metrics.lesionCentre[0];
  check(metrics.grids,`${engine}: outputs share the MNI152 template grid and affine`);
  check(metrics.brainDice>=LIMITS.brainDice,`${engine}: brain mask Dice with the MNI152 template ${metrics.brainDice.toFixed(4)} >= ${LIMITS.brainDice}`);
  check(metrics.brainCorrelation>=LIMITS.brainCorrelation,`${engine}: warped brain correlation with the MNI152 template ${metrics.brainCorrelation.toFixed(4)} >= ${LIMITS.brainCorrelation}`);
  check(metrics.primaryCorrelation>=LIMITS.primaryCorrelation,`${engine}: warped scan correlation with the MNI152 template inside its brain ${metrics.primaryCorrelation.toFixed(4)} >= ${LIMITS.primaryCorrelation}`);
  check(metrics.lesionVoxels>0&&metrics.lesionRightVoxels===0,`${engine}: left lesion stays left: ${metrics.lesionVoxels} voxels, ${metrics.lesionRightVoxels} right of the midline`);
  check(x>=low&&x<=high,`${engine}: lesion centre ${metrics.lesionCentre.map(value=>value.toFixed(1)).join(', ')} mm, x within [${low}, ${high}]`);
  check(metrics.lesionInsideBrain>=LIMITS.lesionInsideBrain,`${engine}: lesion inside the template brain ${metrics.lesionInsideBrain.toFixed(3)} >= ${LIMITS.lesionInsideBrain}`);
}

async function rejectsInvalidUse(work) {
  assert.equal(run(['--help']).status,0);
  const selfCheck=run(['self-check']);
  assert.equal(selfCheck.status,0,selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).executable.length>0,true);
  const input=join(work,'input.nii');
  const output=join(work,'existing');
  await writeFile(input,Buffer.from('Validation is rejected before inference.'));
  await mkdir(output);
  await writeFile(join(output,'keep.txt'),'preserve');
  let r=run([input,output]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/already exists/);
  assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'preserve');
  r=run([input,join(work,'new'),'--threads','-1']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/positive integer/);
  // A refused input leaves no output directory, so the same command can run once the input is fixed.
  r=run([input,join(work,'refused')]);
  assert.notEqual(r.status,0);
  assert.equal(existsSync(join(work,'refused')),false);
  r=run(['download-models']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/was removed/);
  r=run([input,output,'--resume']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/not an interrupted SYNcro run/);
  assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'preserve');
  console.log('PASS installed package: self-check, help, output preservation, thread validation, refused input leaves no directory, removed command, resume of a foreign directory');
}

// A finished run resumes without rerunning a step; a changed input is refused and the outputs kept.
async function resumes(inputPath,output,options,pathologicalPath,original) {
  const name=basename(inputPath);
  const before=sha256(await readFile(join(output,`wbt1${name}`)));
  let r=run([inputPath,output,...options,'--resume'],10*60*1000);
  const reran=r.stdout.split('\n').filter(line=>/^ +[0-9.]+s /.test(line));
  check(r.status===0&&reran.length===0,`resume of a finished run reruns no step${reran.length?`: ${reran.join('; ')}`:''}`);
  await writeFile(pathologicalPath,shiftedCopy(readNifti(original),PATHOLOGICAL_SHIFT_MM+1));
  r=run([inputPath,output,...options,'--resume']);
  const kept=sha256(await readFile(join(output,`wbt1${name}`)))===before;
  check(r.status!==0&&/Checkpoint input, options or software differ/.test(r.stderr)&&kept,'resume with a changed pathological scan is refused and keeps the outputs');
}

// Exercise the default Greedy path with a pathological scan and its lesion, then ANTs SyN (ANTs must be on
// PATH or in ANTSPATH: SYNcro does not bundle it).
async function normalisesPinnedScan(work,engine) {
  const templateBytes=await readFile(TEMPLATE.url);
  check(sha256(templateBytes)===TEMPLATE.sha256,`MNI152 template SHA-256 ${TEMPLATE.sha256}`);
  const inputPath=localInput??await pinnedInput();
  if(localInput)console.log(`INFO input: ${localInput} replaces the pinned ${INPUT.name}`);
  const name=basename(inputPath);
  const primaryScan=readNifti(await readFile(inputPath));
  const pathological=engine==='greedy'?shiftedCopy(primaryScan):null;
  const pathologicalPath=join(work,'pathological.nii');
  if(pathological)await writeFile(pathologicalPath,pathological);
  const lesion=lesionFixture(pathological?readNifti(pathological):primaryScan);
  const lesionPath=join(work,'lesion.nii');
  await writeFile(lesionPath,lesion.bytes);
  const output=join(work,`normalised-${engine}`);
  const started=performance.now();
  const options=['--lesion',lesionPath,...(pathological?['--pathological',pathologicalPath]:['--normalization',engine])];
  const result=run([inputPath,output,...options],40*60*1000);
  const seconds=(performance.now()-started)/1000;
  if(result.status!==0)throw new Error(`normalisation exited with ${result.status}:\n${result.stderr}`);
  const provenance=JSON.parse(await readFile(join(output,'provenance.json'),'utf8'));
  check(provenance.normalization===engine,`${engine}: provenance records the ${provenance.normalization} normalisation`);
  check(provenance.brainExtractor==='mindgrab'&&Boolean(provenance.tools?.['brainchop-mindgrab']),`${engine}: brain extraction ran MindGrab (${provenance.tools?.['brainchop-mindgrab']?.version})`);
  console.log(`INFO ${engine}: offline normalisation of ${name} took ${seconds.toFixed(0)} s; native lesion centre ${lesion.centre.map(value=>value.toFixed(1)).join(', ')} mm`);
  const template=readNifti(templateBytes);
  report(score({
    template,
    brain:readNifti(await readFile(join(output,`wbt1${name}`))),
    primary:readNifti(await readFile(join(output,`w${name}`))),
    lesion:readNifti(await readFile(join(output,'wlesion.nii'))),
  }),engine);
  if(pathological) {
    const warped=readNifti(await readFile(join(output,'wpathological.nii')));
    const value=correlation(warped.data,template.data,i=>template.data[i]>0);
    check(sameGrid(warped,template)&&value>=LIMITS.primaryCorrelation,`${engine}: warped pathological modality correlation with the MNI152 template inside its brain ${value.toFixed(4)} >= ${LIMITS.primaryCorrelation}`);
    await resumes(inputPath,output,options,pathologicalPath,await readFile(inputPath));
  }
}

const work=await mkdtemp(join(tmpdir(),'syncro-package-check-'));
try {
  await rejectsInvalidUse(work);
  await normalisesPinnedScan(work,'greedy');
  await normalisesPinnedScan(work,'ants');
} finally {
  await rm(work,{recursive:true,force:true});
}
console.log(failures.length?`FAIL ${failures.length} SYNcro normalisation checks`:'PASS SYNcro normalises the pinned scan onto the MNI152 template with the lesion in its hemisphere');
process.exitCode=failures.length?1:0;
