import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const appRequire=createRequire(new URL('../../../apps/syncro/package.json',import.meta.url));
const {chromium}=(await import(pathToFileURL(appRequire.resolve('@playwright/test')).href)).default;

const [url,inputPath,synthstripPath,mindgrabBackend='auto']=process.argv.slice(2);
if(!synthstripPath)throw new Error('Usage: benchmark-brain-extraction.mjs URL synthetic-t1.nii[.gz] synthstrip-browser.onnx [auto|webgpu|webgl2|cpu]');
if(!['auto','webgpu','webgl2','cpu'].includes(mindgrabBackend))throw new Error('Invalid MindGrab backend.');
const appDist=resolve('apps/syncro/dist'),workerName=(await readdir(appDist+'/assets')).find(name=>name.startsWith('inference-worker-')&&name.endsWith('.js'));
if(!workerName)throw new Error('Build apps/syncro before running this benchmark.');
const [input,model]=await Promise.all([readFile(inputPath),readFile(synthstripPath)]);
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));

async function processTreeRss(rootPid) {
 const directories=await readdir('/proc'),processes=[];
 await Promise.all(directories.filter(name=>/^\d+$/.test(name)).map(async name=>{
  const pid=Number(name);
  try {
   const status=await readFile(`/proc/${pid}/status`,'utf8');
   const parent=Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),rssKiB=Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]);
   if(Number.isFinite(parent)&&Number.isFinite(rssKiB))processes.push({pid,parent,rssKiB});
  } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
 }));
 const children=new Map(),byPid=new Map(processes.map(process=>[process.pid,process]));
 for(const process of processes)children.set(process.parent,[...(children.get(process.parent)??[]),process]);
 const stack=[rootPid],tree=[];
 while(stack.length) {
  const pid=stack.pop(),process=byPid.get(pid);
  if(process)tree.push(process);
  for(const child of children.get(pid)??[])stack.push(child.pid);
 }
 return {rssKiB:tree.reduce((sum,process)=>sum+process.rssKiB,0),processCount:tree.length};
}

async function idleBaseline(rootPid) {
 let baseline={rssKiB:0,processCount:0};
 for(let index=0;index<5;index+=1) {
  baseline=await processTreeRss(rootPid);
  if(index<4)await delay(100);
 }
 return baseline;
}

function startMemorySampler(rootPid,baseline) {
 let peak={...baseline},samples=0,pending=Promise.resolve();
 const sample=async()=>{
  const current=await processTreeRss(rootPid);
  samples+=1;
  if(current.rssKiB>peak.rssKiB)peak=current;
 };
 const queueSample=()=>{pending=pending.then(sample);};
 const timer=setInterval(queueSample,100);
 queueSample();
 return async()=>{
  clearInterval(timer);
  await pending;
  await sample();
  return {
   method:'Linux aggregate VmRSS sampled for the isolated Chromium process tree',
   targetSamplingIntervalMs:100,
   samples,
   idleBaselineRssKiB:baseline.rssKiB,
   peakRssKiB:peak.rssKiB,
   peakOverIdleRssKiB:Math.max(0,peak.rssKiB-baseline.rssKiB),
   idleProcessCount:baseline.processCount,
   peakProcessCount:peak.processCount
  };
 };
}

async function run(stage) {
 const server=await chromium.launchServer({headless:true,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']}),rootPid=server.process().pid;
 let browser;
 try {
  browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();
  await page.route('**/__brain-input.nii',route=>route.fulfill({body:input,contentType:'application/octet-stream'}));
  if(stage==='synthstrip')await page.route('**/__synthstrip.onnx',route=>route.fulfill({body:model,contentType:'application/octet-stream'}));
  await page.goto(url);
  const environment=await page.evaluate(()=>({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated}));
  if(!environment.crossOriginIsolated)throw new Error('Benchmark page is not cross-origin isolated.');
  const baseline=await idleBaseline(rootPid),stopSampler=startMemorySampler(rootPid,baseline);
  try {
   const result=await page.evaluate(async({workerName,mindgrabBackend,stage})=>{
    const workerUrl=new URL('assets/'+workerName,location.href).href,assetPath=new URL('mindgrab/',location.href).href;
    const input=await (await fetch('__brain-input.nii')).arrayBuffer(),worker=new Worker(workerUrl,{type:'module'});
    const job=stage==='mindgrab'?{stage,buffer:input,assetPath,brainBackend:mindgrabBackend}:{stage,buffer:input,file:new File([await (await fetch('__synthstrip.onnx')).arrayBuffer()],'synthstrip-browser.onnx')};
    const started=performance.now();
    try {
     const output=await new Promise((resolveOutput,reject)=>{
      worker.onerror=event=>reject(new Error(event.message||'brain-extraction worker failed'));
      worker.onmessage=({data})=>{if(data.type==='error')reject(new Error(data.message));else if(data.type==='result')resolveOutput(data.result);};
      worker.postMessage(job,[input]);
     });
     return {wallMs:performance.now()-started,backend:output.provenance?.backend??'wasm',engineMs:output.provenance?.elapsedMs??null};
    } finally {worker.terminate();}
   },{workerName,mindgrabBackend,stage});
   return {environment,result,memory:await stopSampler()};
  } catch(error) {
   await stopSampler();
   throw error;
  }
 } finally {
  if(browser)await browser.close().catch(()=>{});
  await server.close().catch(()=>{});
 }
}

const mindgrab=await run('mindgrab'),synthstrip=await run('synthstrip');
console.log(JSON.stringify({
 input:resolve(inputPath),
 inputBytes:input.byteLength,
 synthstripModelBytes:model.byteLength,
 mindgrabBackend,
 environment:mindgrab.environment,
 mindgrab:{...mindgrab.result,memory:mindgrab.memory},
 synthstrip:{...synthstrip.result,memory:synthstrip.memory}
},null,2));
