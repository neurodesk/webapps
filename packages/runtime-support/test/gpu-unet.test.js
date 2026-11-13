import { test } from 'node:test';
import assert from 'node:assert/strict';
import synthseg from '../../synthseg/src/gpu-model.json' with { type: 'json' };
import synthsr from '../../synthsr/src/gpu-model.json' with { type: 'json' };
import { planGpuGraph } from '../src/gpu-unet/index.js';
import { assertGpuBufferSupported, elementShader } from '../src/gpu-unet/session.js';
import { conv3dShader } from '../src/gpu-unet/conv3d.js';

const CLASSES = 33;

for (const dims of [[128,128,128],[192,224,160]]) {
  test(`SynthSeg plan reuses buffers without clobbering a live tensor: ${dims}`,()=>{
    const plan=planGpuGraph(dims,synthseg,{outputChannels:CLASSES,label:'SynthSeg'});
    const live=new Map([[synthseg.input,0]]),remaining=new Map(),used=new Set([0]);
    for(const node of plan.nodes)for(const input of node.inputs)if(!synthseg.tensors[input] && input)remaining.set(input,(remaining.get(input)||0)+1);
    for(const node of plan.nodes) {
      assert.ok(![...live.values()].includes(node.slot),`${node.name} overwrites a live tensor`);
      // Every slot stays allocated for the session, so a tensor that fits no free slot grows one.
      if(!used.has(node.slot))assert.ok([...used].every(slot=>[...live.values()].includes(slot)),`${node.name} adds a slot while one is free`);
      used.add(node.slot);
      for(let i=0;i<node.inputs.length;i++)if(live.has(node.inputs[i]))assert.equal(node.inputSlots[i],live.get(node.inputs[i]));
      assert.ok(plan.slots[node.slot].bytes>=node.shape.dims.reduce((a,b)=>a*b,4*node.shape.channels));
      live.set(node.output,node.slot);
      for(const input of node.inputs)if(remaining.has(input)) {
        remaining.set(input,remaining.get(input)-1);if(!remaining.get(input))live.delete(input);
      }
    }
    assert.deepEqual(plan.outputShape,{dims,channels:CLASSES});
    assert.equal(plan.nodes.filter(n=>n.op==='Concat').length,4);
    assert.equal(plan.nodes.filter(n=>n.op==='Softmax').length,1);
    for(const node of plan.nodes.filter(n=>n.op==='Conv'))assert.equal(node.shape.channels%4,0,`${node.name} is not padded to a multiple of four`);
    assert.equal(plan.nodes.find(n=>n.name==='unet_likelihood').shape.channels,36);
    assert.equal(live.size,1);
    assert.equal([...live.values()][0],plan.outputSlot);
  });
}

test('the full-volume SynthSeg plan uses six activation slots below 4 GiB',()=>{
  const plan=planGpuGraph([192,224,160],synthseg,{outputChannels:CLASSES,label:'SynthSeg'});
  const total=plan.slots.reduce((sum,slot)=>sum+slot.bytes,0);
  assert.equal(plan.slots.length,6);
  assert.ok(total<=4*2**30,`${(total/2**30).toFixed(2)} GiB of activation buffers`);
  assert.equal(Math.max(...plan.slots.map(slot=>slot.bytes)),192*224*160*72*4);
});

test('SynthSR still plans to a single output channel with the same node counts',()=>{
  const plan=planGpuGraph([32,32,32],synthsr,{label:'SynthSR'});
  assert.deepEqual(plan.outputShape,{dims:[32,32,32],channels:1});
  assert.equal(plan.nodes.filter(n=>n.op==='Conv').length,23);
  assert.equal(plan.nodes.filter(n=>n.elu).length,18);
  assert.equal(plan.nodes.filter(n=>n.op==='BatchNormalization').length,9);
});

test('the padded classifier head compiles as a blocked convolution',()=>{
  const code=conv3dShader({dims:[32,32,32],inputChannels:24,outputChannels:36,kernel:1});
  assert.match(code,/@workgroup_size/);
});

test('caller ceilings are optional and adapter buffer limits always apply', () => {
  const limits = { maxStorageBufferBindingSize: 4 * 2 ** 30, maxBufferSize: 4 * 2 ** 30 };
  assert.throws(
    () => assertGpuBufferSupported(2.25 * 2 ** 30, limits, { label: 'SynthSeg' }),
    /needs a 2,304 MiB GPU buffer, above the validated 2,047 MiB limit for SynthSeg.*native SynthSeg/s,
  );
  assert.doesNotThrow(() => assertGpuBufferSupported(2.8 * 2 ** 30, limits, {
    label: 'SynthSR',
    maxValidatedBufferSize: Number.POSITIVE_INFINITY,
  }));
  assert.throws(
    () => assertGpuBufferSupported(2.5 * 2 ** 30, limits, {
      label: 'Limited U-Net',
      maxValidatedBufferSize: 2.25 * 2 ** 30,
    }),
    /above the validated 2,304 MiB limit for Limited U-Net/,
  );
  assert.throws(
    () => assertGpuBufferSupported(2.8 * 2 ** 30, { maxStorageBufferBindingSize: 2.5 * 2 ** 30, maxBufferSize: 4 * 2 ** 30 }, {
      label: 'SynthSR',
      maxValidatedBufferSize: Number.POSITIVE_INFINITY,
      bufferLimitHelp: 'Choose tiled mode.',
    }),
    /needs a 2,868 MiB GPU buffer but this device allows 2,560 MiB.*Choose tiled mode/s,
  );
});

// SwiftShader allows 1 GiB; a volume just above it must not read as "1.0 GiB but allows 1.0 GiB".
test('the buffer-limit message keeps the need and the limit apart', () => {
  const limits = { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 30 };
  assert.throws(
    () => assertGpuBufferSupported(2 ** 30 + 2 ** 20, limits, { label: 'SynthSR', maxValidatedBufferSize: Number.POSITIVE_INFINITY }),
    /needs a 1,025 MiB GPU buffer but this device allows 1,024 MiB/,
  );
  assert.throws(
    () => assertGpuBufferSupported(2 ** 30 + 1, limits, { label: 'SynthSR', maxValidatedBufferSize: Number.POSITIVE_INFINITY }),
    /needs a 1,025 MiB GPU buffer but this device allows 1,024 MiB/,
  );
});

// Channel-major posteriors make the readback NCDHW, so no host transpose is needed.
test('Softmax stores posteriors channel-major',()=>{
  const dims=[32,32,32],voxels=32**3;
  const plan=planGpuGraph(dims,synthseg,{outputChannels:CLASSES,label:'SynthSeg'});
  const softmax=plan.nodes.find(n=>n.op==='Softmax');
  assert.equal(softmax.inputShape.channels,36);
  assert.ok(plan.slots[softmax.slot].bytes>=voxels*CLASSES*4);
  const {code}=elementShader(softmax);
  assert.match(code,new RegExp(`result\\[k\\*${voxels}u\\+i\\]=e;`));
  assert.doesNotMatch(code,/result\[i\*/);
});

test('growing free slots preserves skips, duplicate inputs, aliases and a retained graph output', () => {
  for (let seed = 1; seed <= 128; seed++) {
    let state = seed;
    const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const graph = { input: 'image', output: 'head', tensors: {}, nodes: [] };
    const names = ['image'], channels = new Map([['image', 1]]);
    const add = (op, inputs, attrs, count) => {
      const output = `tensor${graph.nodes.length}`;
      graph.nodes.push({ name: output, output, op, inputs, attrs });
      names.push(output);
      channels.set(output, count);
      return output;
    };
    let previous = 'image';
    for (let i = 0; i < 48; i++) {
      const count = channels.get(previous), choice = random(5);
      if (choice === 0) {
        previous = add('Identity', [previous], {}, count);
      } else if (choice === 1 && count < 64) {
        // A second read of the same tensor must not free it after the first input.
        const other = random(2) ? previous : names[random(names.length)];
        previous = add('Concat', [previous, other], { axis: 1 }, count + channels.get(other));
      } else if (choice === 2) {
        previous = add('Add', [previous, previous], {}, count);
      } else {
        const outputChannels = 4 * (1 + random(8)), weight = `weight${i}`;
        graph.tensors[weight] = { dims: [outputChannels, count, 1, 1, 1] };
        previous = add('Conv', [previous, weight], { strides: [1, 1, 1], pads: [0, 0, 0, 0, 0, 0] }, outputChannels);
      }
    }
    graph.nodes.push({ name: 'head', output: 'head', op: 'Elu', inputs: [previous], attrs: { alpha: 1 } });
    // An exported tensor stays live even when later nodes also consume it.
    graph.nodes.push({ name: 'tail', output: 'tail', op: 'Elu', inputs: ['head'], attrs: { alpha: 1 } });
    const plan = planGpuGraph([32, 32, 32], graph, { outputChannels: channels.get(previous) });
    const lastUse = new Map([['head', Infinity]]);
    plan.nodes.forEach((node, index) => {
      for (const input of node.inputs) if (input !== 'head') lastUse.set(input, index);
    });
    const live = new Map([['image', 0]]);
    for (const [index, node] of plan.nodes.entries()) {
      assert.ok(![...live.values()].includes(node.slot), `seed ${seed}: ${node.name} overwrites a live tensor`);
      for (const [i, input] of node.inputs.entries()) {
        if (live.has(input)) assert.equal(node.inputSlots[i], live.get(input));
      }
      live.set(node.output, node.slot);
      for (const name of live.keys()) if ((lastUse.get(name) ?? -1) <= index) live.delete(name);
      assert.ok(plan.slots[node.slot].bytes >= node.shape.dims.reduce((a, b) => a * b, node.shape.channels * 4));
    }
    assert.equal(live.get('head'), plan.outputSlot);
  }
});
