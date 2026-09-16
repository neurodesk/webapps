import { verifyStandaloneDialog } from '../../../test-utils/standalone-dialog.mjs';
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const PACKAGE_VERSION=JSON.parse(await readFile(new URL('../../../packages/syncro/package.json',import.meta.url),'utf8')).version;
test.beforeEach(async({page})=>{await page.route('**/MNI152_T1_1mm_brain.nii.gz',async route=>route.fulfill({body:await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz',import.meta.url))}));});
function scan(name,translation=0,value=20){
 const buffer=Buffer.alloc(352+4096);
 buffer.writeInt32LE(348,0);
 [3,16,16,16,1,1,1,1].forEach((n,i)=>buffer.writeInt16LE(n,40+i*2));
 buffer.writeInt16LE(2,70);buffer.writeInt16LE(8,72);
 for(let i=0;i<8;i++)buffer.writeFloatLE(1,76+i*4);
 buffer.writeFloatLE(352,108);buffer.writeFloatLE(1,112);
 buffer.writeInt16LE(1,254);
 for(let i=0;i<3;i++)buffer.writeFloatLE(1,280+i*20);
 buffer.writeFloatLE(translation,292);buffer.write('n+1\0',344);buffer.fill(value,352);
 return {name,mimeType:'application/octet-stream',buffer};
}
async function expectCentered(page,locator){
 const box=await locator.boundingBox(),viewport=page.viewportSize();
 expect(Math.abs(box.x-(viewport.width-box.width)/2)).toBeLessThan(2);
 expect(Math.abs(box.y-(viewport.height-box.height)/2)).toBeLessThan(2);
}
test('built runtime asset URLs return executable modules and WebAssembly',async({request})=>{
 for(const path of ['mindgrab/brainchop-mindgrab-gpu.js','mindgrab/brainchop-mindgrab-gl.js','mindgrab/brainchop-mindgrab.js','greedy-wasm/greedy_rs_wasm.js','greedy-wasm/snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.no-bundler.js','registration/syncro-registration.mjs']){
  const response=await request.get(path);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toMatch(/javascript/);
  expect(await response.text()).not.toMatch(/<!doctype html>/i);
 }
 for(const path of ['mindgrab/brainchop-mindgrab-gpu.wasm','mindgrab/brainchop-mindgrab-gl.wasm','mindgrab/brainchop-mindgrab.wasm','greedy-wasm/greedy_rs_wasm_bg.wasm','registration/syncro-registration.wasm']){
  const response=await request.get(path);
  expect(response.ok()).toBe(true);
  expect([...((await response.body()).subarray(0,4))]).toEqual([0,97,115,109]);
 }
});
test('geometry error keeps the explicit lesion input available before inference',async({page})=>{
 const modelRequests=[];page.on('request',r=>{if(r.url().includes('.onnx'))modelRequests.push(r.url());});
 await page.goto('./');
 expect(await page.evaluate(()=>crossOriginIsolated)).toBe(true);
 await page.locator('#input').setInputFiles(scan('anatomical.nii'));
 await expect(page.locator('#runButton')).toBeEnabled({timeout:30000});
 await page.locator('#lesion').setInputFiles(scan('misaligned-lesion.nii',5,1));
 await page.locator('#runButton').click();
 await expect(page.locator('#statusText')).toContainText('must match');
 await expect(page.locator('#inputSection')).toHaveAttribute('open','');
 await expect(page.locator('#lesionInfo')).toBeVisible();
 await expect(page.locator('#download')).toBeDisabled();
 expect(modelRequests).toEqual([]);
});
test('cancellation restores input controls and invalid input cannot reuse an old scan',async({page})=>{
 await page.addInitScript(()=>{
  const OriginalWorker=window.Worker;
  window.Worker=class extends OriginalWorker {
   postMessage(job,...rest){if(job.synthsrBackend){window.sentBackend=job.synthsrBackend;window.sentBrainExtractor=job.brainExtractor;window.sentNormalization=job.normalization;}return super.postMessage(job,...rest);}
  };
 });
 await page.goto('./');
 await page.locator('#input').setInputFiles(scan('anatomical.nii'));
 await expect(page.locator('#runButton')).toBeEnabled({timeout:30000});
 await page.getByText('Processing settings',{exact:true}).click();
 await expect(page.locator('#synthsrBackend')).toHaveValue('webgpu');
 await expect(page.locator('#brainExtractor')).toHaveValue('mindgrab');
 await expect(page.locator('#normalization')).toHaveValue('greedy');
 await page.route('**/MNI152_T1_1mm_brain.nii.gz',()=>{});
 await page.locator('#runButton').click();
 await expect(page.locator('#synthsrBackend')).toBeDisabled();
 await expect(page.locator('#brainExtractor')).toBeDisabled();
 expect(await page.evaluate(()=>window.sentBackend)).toBe('webgpu');
 expect(await page.evaluate(()=>window.sentBrainExtractor)).toBe('mindgrab');
 expect(await page.evaluate(()=>window.sentNormalization)).toBe('greedy');
 await page.locator('#cancel').click();
 await expect(page.locator('#statusText')).toContainText('cancelled');
 await expect(page.locator('#input')).toBeEnabled();
 await expect(page.locator('#synthsrBackend')).toBeEnabled();
 await expect(page.locator('#brainExtractor')).toBeEnabled();
 await expect(page.locator('#normalization')).toBeEnabled();
 await expect(page.locator('#synthsrBackend')).toHaveValue('webgpu');
 await expect(page.locator('#brainExtractor')).toHaveValue('mindgrab');
 await expect(page.locator('#normalization')).toHaveValue('greedy');
 await expect(page.locator('#download')).toBeDisabled();
 await page.locator('#input').setInputFiles({name:'broken.nii',mimeType:'application/octet-stream',buffer:Buffer.from('not a NIfTI')});
 await expect(page.locator('#runButton')).toBeDisabled();
 await expect(page.locator('#empty')).toBeVisible();
 await expect(page.locator('#viewLabel')).toBeEmpty();
 await expect(page.locator('#opacityControl')).toBeHidden();
});

test('failed tutorial loading returns the selector to its neutral action',async({page})=>{
 await page.route('https://huggingface.co/datasets/neurodeskorg/webapps/**',route=>route.abort());
 await page.goto('./');
 await page.locator('#tutorial').selectOption('trace-only');
 await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state','error');
 await expect(page.locator('#tutorial')).toHaveValue('');
 await expect(page.locator('#runButton')).toBeDisabled();
});

test('compact help, standalone commands and result switching remain reachable',async({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedText=value;}}});
  const NativeWorker=window.Worker;
  window.Worker=function(url,options){
   if(!/\/assets\/worker-[^/]+\.js/.test(String(url)))return new NativeWorker(url,options);
   return {
    onmessage:null,onerror:null,
    postMessage(job){job.input.arrayBuffer().then(buffer=>{const bytes=new Uint8Array(buffer);this.onmessage?.({data:{type:'result',outputs:{'wbt1anatomical.nii':bytes.slice(),'wanatomical.nii':bytes.slice(),'wlesion.nii':bytes.slice(),'wbanatomical.nii':bytes.slice()}}});});},
    terminate(){}
   };
  };
 });
 await page.goto('./');
 await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
 await expect(page.locator('#log')).toBeHidden();
 await expect(page.locator('#technicalLog')).toBeAttached();
 expect(await page.locator('#technicalLog').evaluate(node=>node.parentElement.id)).toBe('viewer');
 await page.locator('.nd-console-title').click();
 await expect(page.locator('#technicalLog')).not.toHaveClass(/collapsed/);
 await expect(page.locator('#log')).toBeVisible();
 await page.locator('.nd-console-title').click();
 await expect(page.locator('#localSr, #localStrip, #browserModelLink')).toHaveCount(0);
 await page.locator('#settingsSection > summary').click();
 await page.locator('.nd-info-icon').first().focus();
 await expect(page.locator('.nd-info-tooltip').first()).toBeVisible();
 await page.locator('#settingsSection > summary').click();
 await expect(page.locator('#standalone')).toHaveCount(0);
 await verifyStandaloneDialog(page, 'syncro');
 for(const label of ['About','Privacy']){
  await page.locator('.nd-app-bar').getByRole('button',{name:label,exact:true}).click();
  await expect(page.locator('#info')).toBeVisible();
  await expectCentered(page,page.locator('#info'));
  await page.locator('#info').getByRole('button',{name:'Close'}).click();
 }

 await page.locator('#input').setInputFiles(scan('anatomical.nii'));
 await expect(page.locator('#runButton')).toBeEnabled();
 await page.locator('#lesion').setInputFiles(scan('lesion.nii',0,1));
 await expect(page.locator('#lesionInfo')).toBeVisible();
 await expect(page.locator('#viewSelect')).toHaveValue('input:primary');
 await expect(page.locator('#viewSelect option')).toHaveText(['Input · primary scan']);
 await expect(page.locator('#opacityControl')).toBeVisible();
 await expect(page.locator('.nd-viewer-actions #opacity')).toHaveCount(1);
 await page.locator('#runButton').click();
 await expect(page.locator('#statusText')).toContainText('Normalization complete');
 await expect(page.locator('#results')).toHaveAttribute('open','');
 await expect(page.locator('#viewSelect option')).toHaveText(['Input · primary scan','Output · Normalized brain-extracted synthetic T1','Output · Normalized primary scan','Output · Normalized brain-extracted primary scan']);
 await expect(page.locator('#viewSelect')).toHaveValue('output:wanatomical.nii');
 await expect(page.locator('#downloadSelected')).toBeEnabled();
 await expect(page.locator('#opacityControl')).toBeVisible();
 const archive=page.waitForEvent('download');
 await page.locator('#download').click();
 await archive;
 await page.locator('#opacity').fill('65');
 await expect(page.locator('#opacityValue')).toHaveText('65%');
 await page.locator('#viewSelect').selectOption('input:primary');
 await expect(page.locator('#viewLabel')).toHaveText('anatomical.nii + lesion.nii');
 await expect(page.locator('#opacityControl')).toBeVisible();
 await expect(page.locator('#downloadSelected')).toBeDisabled();
 await page.locator('#viewSelect').selectOption('output:wbanatomical.nii');
 await expect(page.locator('#viewLabel')).toHaveText('wbanatomical.nii + wlesion.nii');
 await page.locator('#viewSelect').evaluate(select=>{
  select.value='input:primary';select.dispatchEvent(new Event('change',{bubbles:true}));
  select.value='output:wanatomical.nii';select.dispatchEvent(new Event('change',{bubbles:true}));
 });
 await expect(page.locator('#viewLabel')).toHaveText('wanatomical.nii + wlesion.nii');

 await page.locator('.nd-app-bar').getByRole('button',{name:'Cite',exact:true}).click();
 const cite=page.locator('.nd-app-dialog[data-dialog="cite"]');
 await expect(cite).toBeVisible();
 await expectCentered(page,cite);
 await expect(cite.locator('h2')).toHaveText('Cite SYNcro');
 await expect(cite.locator('h3').first()).toHaveText('Image synthesis');
 await expect(cite.locator('h3').last()).toHaveText('Platform');
 await expect(cite).toContainText('Iglesias JE, Billot B');
 await expect(cite).toContainText('Greedy was created by Paul Yushkevich');
 await expect(cite).toContainText('niimath and fslmaths');
 await expect(cite).toContainText('NeuroImage. 2011;54(3):2033');
 await expect(cite.locator('a[href="https://doi.org/10.1016/j.neuroimage.2021.118206"]')).toHaveCount(1);
 await expect(cite.locator('a[href="https://doi.org/10.1038/s41592-023-02145-x"]')).toHaveCount(1);
 await cite.locator('.nd-app-dialog__close').click();
 await page.locator('.nd-app-bar').getByRole('button',{name:'About',exact:true}).click();
 await expect(page.locator('#info [data-neurodesk-app-info="about"]')).toContainText('lightniing.org');
 await expect(page.locator('#info [data-neurodesk-app-info="about"]')).toContainText('Neurodesk team');
 await page.locator('#info').getByRole('button',{name:'Close'}).click();
 await page.locator('#clearLesion').click();
 await expect(page.locator('#progress')).toHaveJSProperty('value',0);
 await expect(page.locator('#elapsed')).toBeEmpty();
 await expect(page.locator('#results')).not.toHaveAttribute('open','');
});
