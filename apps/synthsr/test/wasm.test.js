import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {planGpuGraph} from '@neurodesk/synthsr/browser';
import {slabPlan} from '../../../packages/runtime-support/src/streamed-onnx/session.js';
import {needsStreamedWasm,createStreamedWasmSession} from '../../../packages/synthsr/src/wasm-session.js';

test('larger CT volumes use bounded-memory CPU execution; FLAIR keeps the fast full session',()=>{
  assert.equal(needsStreamedWasm([192,224,256]),true);
  assert.equal(needsStreamedWasm([192,256,160]),false);
});

test('slabs cover every output exactly once, retain real convolution neighbors and align pooling/resize',()=>{
  for(const node of planGpuGraph([192,224,256]).nodes) {
    const slabs=slabPlan(node);let end=0;
    for(const slab of slabs) {
      assert.equal(slab.start,end);end=slab.end;
      assert.ok(slab.inputStart>=0&&slab.inputEnd<=node.inputShape.dims[0]);
      if(node.op==='Conv'&&node.kernel===3) {
        assert.equal(slab.inputStart,Math.max(0,slab.start-1));
        assert.equal(slab.inputEnd,Math.min(node.inputShape.dims[0],slab.end+1));
        assert.equal(slab.outputOffset,slab.start-slab.inputStart);
      }
      if(node.op==='MaxPool')assert.deepEqual([slab.inputStart,slab.inputEnd],[slab.start*2,slab.end*2]);
      if(node.op==='Resize')assert.deepEqual([slab.inputStart,slab.inputEnd],[slab.start/2,slab.end/2]);
      const elements=(slab.inputEnd-slab.inputStart)*node.inputShape.dims[1]*node.inputShape.dims[2]*node.inputShape.channels;
      assert.ok(elements<=8*1024*1024,`${node.name}: ${elements} input elements`);
    }
    assert.equal(end,node.shape.dims[0]);
  }
});

test('streamed full network preserves native predictions across forced slab boundaries',{
  skip:!process.env.SYNTHSR_MODEL_PATH&&'Set SYNTHSR_MODEL_PATH for full-network numerical validation',
},async()=>{
  const ort=createRequire(new URL('../../../packages/synthsr/package.json',import.meta.url))('onnxruntime-node');
  const raw=await readFile(process.env.SYNTHSR_MODEL_PATH);
  const adapter={...ort,InferenceSession:{create:(bytes,options)=>ort.InferenceSession.create(bytes,{
    ...options,executionProviders:['cpu'],intraOpNumThreads:2,
  })}};
  const dims=[32,32,32],tensor=new ort.Tensor('float32',Float32Array.from({length:32768},(_,i)=>(i*17%101)/100),[1,1,...dims]);
  let failLayer = false;
  const streamed=await createStreamedWasmSession(raw,dims,adapter,{
    maxElements:32768,
    onProgress(layer) {
      if (failLayer && layer === 4) throw new Error('Injected layer failure');
    },
  });
  const reference=await adapter.InferenceSession.create(raw,{graphOptimizationLevel:'all'});
  let a,b;
  try {
    a=await streamed.run({input:tensor});b=await reference.run({input:tensor});
    const x=await a.output.getData(),y=await b.output.getData();
    assert.equal(x.length,y.length);
    let max=0;for(let i=0;i<x.length;i++){assert.ok(Number.isFinite(x[i]));max=Math.max(max,Math.abs(x[i]-y[i]));}
    assert.ok(max<1e-5,`maximum float32 difference ${max}`);
    failLayer = true;
    await assert.rejects(streamed.run({input:tensor}), /Injected layer failure/);
    failLayer = false;
    const rerun = await streamed.run({input:tensor});
    try {
      assert.deepEqual(await rerun.output.getData(), x);
    } finally {
      rerun.output.dispose();
    }
  }finally{tensor.dispose();a?.output.dispose();b?.output.dispose();await streamed.release();await reference.release();}
});

test('constructing the pinned T1 session never reserves volume-sized GPU slots', {
  skip: !process.env.SYNTHSR_MODEL_PATH && 'Set SYNTHSR_MODEL_PATH for allocation regression',
}, async () => {
  const raw = await readFile(process.env.SYNTHSR_MODEL_PATH);
  const NativeFloat32Array = globalThis.Float32Array;
  const allocations = [];
  let created = 0;
  let released = 0;
  const ort = { InferenceSession: { create: async () => {
    created++;
    return { release: async () => { released++; } };
  } } };
  globalThis.Float32Array = new Proxy(NativeFloat32Array, {
    construct(target, args) {
      allocations.push(args[0]);
      if (args[0] === 764411904) {
        throw new Error(`Unexpected activation allocation during construction: ${args[0]}`);
      }
      return new target(0);
    },
  });
  let session;
  try {
    session = await createStreamedWasmSession(raw, [192, 288, 288], ort);
    assert.deepEqual(allocations, []);
  } finally {
    globalThis.Float32Array = NativeFloat32Array;
    await session?.release();
    assert.equal(released, created);
  }
});
