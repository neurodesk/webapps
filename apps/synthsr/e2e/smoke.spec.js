import { verifyStandaloneDialog } from '../../../test-utils/standalone-dialog.mjs';
import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {cpus,totalmem} from 'node:os';
import {basename} from 'node:path';
const VERSION=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
import {fileURLToPath} from 'node:url';
import {prepare,readVolume} from '../src/volume.js';
import {planGpuGraph} from '@neurodesk/synthsr/browser';
const fixture=(name)=>fileURLToPath(new URL('../test/fixtures/'+name,import.meta.url));
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');

test('load, invalid input, and cancellation preserve the original',async({page})=>{
  await page.goto('./');await expect(page).toHaveTitle(/SynthSR/);
  await expect(page.locator('#processButton')).toBeDisabled();
  await page.locator('#imageInput').setInputFiles({name:'bad.nii',mimeType:'application/octet-stream',buffer:Buffer.from('not a nifti')});
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await page.locator('#imageInput').setInputFiles(fixture('validation.nii.gz'));
  await expect(page.locator('#processButton')).toBeEnabled();
  // Hold the model request so this tests real cancellation without a giant asset.
  await page.route('**/synthsr-v2.onnx*',()=>{});
  await page.locator('#processButton').click();await page.locator('#cancelBtn').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await expect(page.locator('#saveBtn')).toBeDisabled();
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#aboutBtn').dispatchEvent('click');await expect(page.locator('#infoDialog')).toBeVisible();await expect(page.locator('#infoDialogTitle')).toHaveText('About SynthSR');await page.locator('#infoDialog').getByRole('button',{name:'Close',exact:true}).click();
  await expect(page.locator('#infoDialog')).toBeHidden();
  await verifyStandaloneDialog(page, 'synthsr');
});

for(const backend of ['webgpu','wasm']) test(`full-volume ${backend} regression with default augmentation`,async({page})=>{
  test.skip(!process.env.SYNTHSR_FULL_INPUT || !process.env.SYNTHSR_FULL_REFERENCE,
    'Set SYNTHSR_FULL_INPUT and SYNTHSR_FULL_REFERENCE to run on a capable hardware GPU.');
  test.setTimeout(900000);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(process.env.SYNTHSR_FULL_INPUT);
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processingSettings > summary').click();
  await page.locator('#backend').selectOption(backend);
  const started=performance.now();
  await page.locator('#processButton').click();
  await expect(page.locator('#saveBtn')).toBeEnabled({timeout:840000});
  const wallSeconds=(performance.now()-started)/1000;
  const pending=page.waitForEvent('download');await page.locator('#saveBtn').click();
  const bytes=await readFile(await (await pending).path());
  const output=readVolume(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const ref=await readFile(process.env.SYNTHSR_FULL_REFERENCE);
  const expected=readVolume(ref.buffer.slice(ref.byteOffset,ref.byteOffset+ref.byteLength));
  expect(output.dims).toEqual(expected.dims);
  let max=0,mismatches=0;
  for(let i=0;i<output.data.length;i++){
    const delta=Math.abs(output.data[i]-expected.data[i]);max=Math.max(max,delta);mismatches+=delta!==0;
  }
  expect(max).toBeLessThanOrEqual(1);
  expect(mismatches/output.data.length).toBeLessThan(.001);
  for(let r=0;r<3;r++)for(let c=0;c<4;c++)expect(Math.abs(output.affine[r][c]-expected.affine[r][c])).toBeLessThan(2e-5);
  if(process.env.SYNTHSR_VALIDATION_REPORT){
    const provenanceDownload=page.waitForEvent('download');
    await page.locator('#reportBtn').click();
    const provenance=JSON.parse(await readFile(await (await provenanceDownload).path(),'utf8'));
    const sourceBytes=await readFile(process.env.SYNTHSR_FULL_INPUT);
    const sourceBuffer=sourceBytes.buffer.slice(sourceBytes.byteOffset,sourceBytes.byteOffset+sourceBytes.byteLength);
    const sourceVolume=readVolume(sourceBuffer);
    const prep=prepare(sourceVolume);
    const plan=planGpuGraph(prep.paddedDims);
    const browser=await page.evaluate(async()=>{
      const adapter=await navigator.gpu?.requestAdapter();
      return {
        userAgent:navigator.userAgent,
        hardwareConcurrency:navigator.hardwareConcurrency,
        gpu:adapter?{
          architecture:adapter.info.architecture,
          description:adapter.info.description,
          device:adapter.info.device,
          vendor:adapter.info.vendor,
        }:null,
      };
    });
    await writeFile(process.env.SYNTHSR_VALIDATION_REPORT,JSON.stringify({
      schemaVersion:1,
      date:new Date().toISOString(),
      command:'pnpm --filter synthsr test:e2e --grep "full-volume webgpu regression"',
      backend,
      source:{name:basename(process.env.SYNTHSR_FULL_INPUT),sha256:hash(sourceBytes),shape:sourceVolume.dims},
      preparation:{resampledShape:prep.dims,paddedShape:prep.paddedDims},
      gpuPlan:{largestBufferBytes:Math.max(...plan.slots.map(slot=>slot.bytes)),reusableBufferBytes:plan.slots.reduce((sum,slot)=>sum+slot.bytes,0)},
      modelSha256:provenance.modelSha256,
      output:{sha256:hash(bytes),shape:output.dims},
      reference:{name:basename(process.env.SYNTHSR_FULL_REFERENCE),sha256:hash(ref),shape:expected.dims},
      comparison:{maxError:max,mismatches,voxels:output.data.length,maxAffineError:Math.max(...output.affine.slice(0,3).flatMap((row,r)=>row.map((value,c)=>Math.abs(value-expected.affine[r][c]))))},
      timing:{browserPipelineSeconds:provenance.seconds,playwrightProcessSeconds:wallSeconds,timings:provenance.timings},
      environment:{host:`${cpus()[0]?.model||'unknown CPU'}; ${(totalmem()/2**30).toFixed(0)} GiB RAM`,browser},
      settings:{ct:false,flip:true,sharpen:true,tiled:false},
    },null,2)+'\n');
  }
});

for(const backend of ['wasm','webgpu']) test(`real ${backend} inference matches TensorFlow and downloads provenance`,async({page})=>{
  test.skip(!process.env.SYNTHSR_ASSET_DIR,'Set SYNTHSR_ASSET_DIR to the converted pretrained model for inference parity.');
  await page.goto('./');
  if(backend==='webgpu') {
    const gpu=await page.evaluate(async()=>!!(await navigator.gpu?.requestAdapter()));
    test.skip(!gpu,'This browser has no WebGPU adapter.');
  }
  await page.locator('#imageInput').setInputFiles(fixture('validation.nii.gz'));
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processingSettings > summary').click();
  await page.locator('#backend').selectOption(backend);await page.locator('#processButton').click();
  await expect(page.locator('#saveBtn')).toBeEnabled({timeout:240000});
  const downloadPromise=page.waitForEvent('download');await page.locator('#saveBtn').click();const download=await downloadPromise;
  const bytes=await readFile(await download.path());const output=readVolume(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const r=await readFile(fixture('validation-reference.nii.gz'));const expected=readVolume(r.buffer.slice(r.byteOffset,r.byteOffset+r.byteLength));
  expect(output.dims).toEqual([32,32,32]);let mismatches=0,maxError=0;
  for(let i=0;i<output.data.length;i++){maxError=Math.max(maxError,Math.abs(output.data[i]-expected.data[i]));mismatches+=output.data[i]!==expected.data[i];}
  expect(maxError).toBeLessThanOrEqual(1);
  expect(mismatches/output.data.length).toBeLessThan(.001);
  const reportPromise=page.waitForEvent('download');await page.locator('#reportBtn').click();const report=JSON.parse(await readFile(await (await reportPromise).path(),'utf8'));
  expect(report.backend).toBe(backend);expect(report.synthetic).toBe(true);expect(report.flip).toBe(true);expect(report.modelSha256).toMatch(/^[a-f0-9]{64}$/);
  if(backend==='webgpu')expect(report.gpuImplementation).toBe('synthsr-blocked-fp32-v1');
  else expect(report.onnxRuntime).toBe('1.29.0');
  await expect(page.locator('#outputTab')).toBeVisible();
  await page.locator('#inputTab').click();await expect(page.locator('#inputTab')).toHaveClass(/active/);await expect(page.locator('#outputTab')).not.toHaveClass(/active/);
  await page.locator('#imageInput').setInputFiles(fixture('validation.nii.gz'));
  await expect(page.locator('#outputTab')).toBeHidden();
  await expect(page.locator('#processButton')).toBeEnabled();
});
