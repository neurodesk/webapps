// Native Metal executor: the webapp's `synthsr-blocked-fp32-v1` WebGPU executor
// (packages/runtime-support/src/gpu-unet/) with its WGSL translated to MSL.
// Same NDHWC layout, same blocked FP32 implicit-GEMM Conv3D, same buffer-slot plan.
use crate::nifti::product;
use metal::*;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write;

const GRAPH: &str = include_str!("../../../packages/synthsr/src/gpu-model.json");
const POSITIONS: usize = 2; // spatial positions accumulated per thread
const CHUNK: usize = 16; // reduction elements staged per barrier
const ROWS: usize = 64; // thread rows per threadgroup

struct Node {
    name: String,
    output: String,
    op: String,
    inputs: Vec<String>,
    attrs: Value,
    elu: bool,
    kernel: usize,
    dims: [usize; 3],
    channels: usize,
    in_dims: [usize; 3],
    in_channels: usize,
    slot: usize,
    input_slots: Vec<usize>,
}

struct Step {
    pipeline: ComputePipelineState,
    buffers: [Buffer; 4],
    groups: MTLSize,
    threads: MTLSize,
}

pub struct Session {
    queue: CommandQueue,
    slots: Vec<Buffer>,
    steps: Vec<Step>,
    output_slot: usize,
    voxels: usize,
}

// ponytail: the graph is checksum-tied to the embedded model and its attributes are
// validated by the webapp's test suite, so only what selects a kernel is inspected here.
fn plan(dims: [usize; 3], graph: &Value) -> Result<(Vec<Node>, Vec<usize>, usize), String> {
    if dims.iter().any(|&d| d < 32 || !d.is_multiple_of(32)) {
        return Err("Metal dimensions must be positive multiples of 32.".into());
    }
    let raw = graph["nodes"].as_array().unwrap();
    let output_name = graph["output"].as_str().unwrap();
    let mut uses: HashMap<String, usize> = HashMap::from([(output_name.to_string(), 1)]);
    for n in raw {
        for i in n["inputs"].as_array().unwrap() {
            *uses.entry(i.as_str().unwrap().to_string()).or_default() += 1;
        }
    }
    let mut shapes: HashMap<String, ([usize; 3], usize)> =
        HashMap::from([(graph["input"].as_str().unwrap().to_string(), (dims, 1))]);
    let mut aliases: HashMap<String, String> = HashMap::new();
    let resolve = |aliases: &HashMap<String, String>, n: &str| {
        aliases.get(n).cloned().unwrap_or_else(|| n.to_string())
    };
    let mut nodes = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let src = &raw[i];
        let op = src["op"].as_str().unwrap().to_string();
        let inputs: Vec<String> = src["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| resolve(&aliases, v.as_str().unwrap()))
            .collect();
        let mut output = src["output"].as_str().unwrap().to_string();
        if op == "Identity" {
            aliases.insert(output, inputs[0].clone());
            i += 1;
            continue;
        }
        let (in_dims, in_channels) = *shapes
            .get(&inputs[0])
            .ok_or(format!("Missing Metal graph input: {}", inputs[0]))?;
        let (mut out_dims, mut channels, mut kernel) = (in_dims, in_channels, 0);
        match op.as_str() {
            "Conv" => {
                let w = graph["tensors"][&inputs[1]]["dims"].as_array().unwrap();
                channels = w[0].as_u64().unwrap() as usize;
                kernel = w[2].as_u64().unwrap() as usize;
            }
            "MaxPool" => out_dims = in_dims.map(|d| d / 2),
            "Resize" => out_dims = in_dims.map(|d| d * 2),
            "Add" | "Elu" | "BatchNormalization" => {}
            other => return Err(format!("Unsupported Metal operator: {other}")),
        }
        let mut elu = false;
        if matches!(op.as_str(), "Conv" | "Add") {
            if let Some(next) = raw.get(i + 1) {
                if next["op"] == "Elu"
                    && next["inputs"][0] == output.as_str()
                    && uses.get(&output) == Some(&1)
                {
                    output = next["output"].as_str().unwrap().to_string();
                    elu = true;
                    i += 1;
                }
            }
        }
        shapes.insert(output.clone(), (out_dims, channels));
        nodes.push(Node {
            name: src["name"].as_str().unwrap().to_string(),
            output,
            op,
            inputs,
            attrs: src["attrs"].clone(),
            elu,
            kernel,
            dims: out_dims,
            channels,
            in_dims,
            in_channels,
            slot: 0,
            input_slots: vec![],
        });
        i += 1;
    }
    let output = resolve(&aliases, output_name);
    if shapes.get(&output) != Some(&(dims, 1)) {
        return Err("Metal output does not match the SynthSR contract.".into());
    }
    // Reusable buffers by lifetime; never alias a node's input and output.
    let mut remaining: HashMap<String, usize> = HashMap::from([(output.clone(), 1)]);
    for n in &nodes {
        for name in &n.inputs {
            if shapes.contains_key(name) {
                *remaining.entry(name.clone()).or_default() += 1;
            }
        }
    }
    let mut slots = vec![product(&dims) * 4];
    let mut assigned: HashMap<String, usize> =
        HashMap::from([(graph["input"].as_str().unwrap().to_string(), 0)]);
    let mut free: Vec<usize> = Vec::new();
    for n in nodes.iter_mut() {
        let bytes = product(&n.dims) * n.channels * 4;
        // Match the shared WebGPU planner: smallest fitting free slot, otherwise
        // grow the largest free slot. Allocate only while every slot is live.
        free.sort_by_key(|&s| std::cmp::Reverse(slots[s]));
        let candidate = free
            .iter()
            .rev()
            .find(|&&s| slots[s] >= bytes)
            .or_else(|| free.first())
            .copied();
        let slot = match candidate {
            Some(s) => {
                free.retain(|&f| f != s);
                slots[s] = slots[s].max(bytes);
                s
            }
            None => {
                slots.push(bytes);
                slots.len() - 1
            }
        };
        n.slot = slot;
        assigned.insert(n.output.clone(), slot);
        n.input_slots = n
            .inputs
            .iter()
            .map(|name| assigned.get(name).copied().unwrap_or(0))
            .collect();
        for name in &n.inputs {
            if let Some(left) = remaining.get_mut(name) {
                *left -= 1;
                if *left == 0 {
                    free.push(assigned[name]);
                }
            }
        }
    }
    let output_slot = assigned[&output];
    Ok((nodes, slots, output_slot))
}

fn channel_block(out: usize) -> (usize, usize) {
    for channels in [8, 4] {
        let mut tile = out.min(32);
        while tile >= channels {
            if out.is_multiple_of(tile) && tile.is_multiple_of(channels) {
                return (channels, tile);
            }
            tile -= channels;
        }
    }
    panic!("Blocked Conv3D requires output channels divisible by four.")
}

const PRELUDE: &str = "#include <metal_stdlib>\nusing namespace metal;\n";

fn conv3d_shader(n: &Node) -> (String, MTLSize, MTLSize) {
    let [d, h, w] = n.dims;
    let (spatial, k, ci, co) = (product(&n.dims), n.kernel, n.in_channels, n.channels);
    let reduction = k * k * k * ci;
    let (channels, tile) = channel_block(co);
    let (columns, positions, lanes, out_vectors) =
        (tile / channels, POSITIONS * ROWS, channels / 4, co / 4);
    let groups = spatial.div_ceil(positions);
    let groups_x = groups.min(65535);
    let mut s = String::from(PRELUDE);
    let _ = write!(s, "static inline float gather(device const float* input, uint position, uint k) {{
  if (position >= {spatial}u || k >= {reduction}u) {{ return 0.0f; }}
  uint tap = k / {ci}u;
  int z = int(position % {w}u) + int(tap % {k}u) - {p};
  int y = int(position / {w}u % {h}u) + int(tap / {k}u % {k}u) - {p};
  int x = int(position / {wh}u) + int(tap / {kk}u) - {p};
  if (x < 0 || y < 0 || z < 0 || x >= {d} || y >= {h} || z >= {w}) {{ return 0.0f; }}
  return input[((uint(x)*{h}u+uint(y))*{w}u+uint(z))*{ci}u+k%{ci}u];
}}
kernel void main0(device const float* input [[buffer(0)]], device const float4* weights [[buffer(1)]],
  device const float4* biases [[buffer(2)]], device float4* result [[buffer(3)]],
  uint3 group [[threadgroup_position_in_grid]], uint3 local_id [[thread_position_in_threadgroup]]) {{
  threadgroup float a[{a_len}];
  threadgroup float4 b[{b_len}];
  uint base = (group.x + group.y*{groups_x}u)*{positions}u;
  uint channel = group.z*{tile}u + local_id.x*{channels}u;
  uint tid = local_id.y*{columns}u+local_id.x;
", p = k / 2, wh = w * h, kk = k * k, a_len = CHUNK * positions, b_len = CHUNK * tile / 4);
    for p in 0..POSITIONS {
        for j in 0..lanes {
            let _ = writeln!(s, "  float4 sum{p}_{j} = float4(0.0f);");
        }
    }
    let _ = write!(s, "  for (uint start=0u; start<{reduction}u; start+={CHUNK}u) {{
    for (uint i=tid; i<{a_len}u; i+={stride}u) {{ a[i]=gather(input, base+i%{positions}u, start+i/{positions}u); }}
    for (uint i=tid; i<{b_len}u; i+={stride}u) {{
      uint k=start+i/{tile4}u;
      uint c=group.z*{tile}u+(i%{tile4}u)*4u;
      float4 value=float4(0.0f);
      if (k<{reduction}u) {{ value=weights[k*{out_vectors}u+c/4u]; }}
      b[i]=value;
    }}
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint k=0u;k<{CHUNK}u;k++) {{
", a_len = CHUNK * positions, b_len = CHUNK * tile / 4, stride = columns * ROWS, tile4 = tile / 4);
    for j in 0..lanes {
        let _ = writeln!(
            s,
            "      float4 weight{j} = b[k * {}u + local_id.x * {lanes}u + {j}u];",
            tile / 4
        );
    }
    for p in 0..POSITIONS {
        let _ = writeln!(
            s,
            "      float activation{p} = a[k * {positions}u + local_id.y + {}u];",
            p * ROWS
        );
        for j in 0..lanes {
            let _ = writeln!(s, "      sum{p}_{j} += activation{p} * weight{j};");
        }
    }
    s.push_str("    }\n    threadgroup_barrier(mem_flags::mem_threadgroup);\n  }\n");
    for p in 0..POSITIONS {
        let _ = writeln!(
            s,
            "  uint position{p} = base + local_id.y + {}u;\n  if (position{p} < {spatial}u) {{",
            p * ROWS
        );
        for j in 0..lanes {
            let bias = if n.inputs.len() > 2 {
                format!(" + biases[channel / 4u + {j}u]")
            } else {
                String::new()
            };
            let elu = if n.elu {
                "value = select(exp(value) - float4(1.0f), value, value >= float4(0.0f));"
            } else {
                ""
            };
            let _ = writeln!(s, "    {{ float4 value = sum{p}_{j}{bias}; {elu} result[position{p} * {out_vectors}u + channel / 4u + {j}u] = value; }}");
        }
        s.push_str("  }\n");
    }
    s.push_str("}\n");
    let groups = MTLSize::new(
        groups_x as u64,
        groups.div_ceil(groups_x) as u64,
        (co / tile) as u64,
    );
    (s, groups, MTLSize::new(columns as u64, ROWS as u64, 1))
}

fn element_shader(n: &Node) -> (String, MTLSize, MTLSize) {
    let [d, h, w] = n.dims;
    let c = n.channels;
    let size = d * h * w * c;
    let [_, ih, iw] = n.in_dims;
    let body = match n.op.as_str() {
        "Elu" => "float x=input[i];result[i]=select(exp(x)-1.0f,x,x>=0.0f);".to_string(),
        "Add" => format!("float x=input[i]+other[i];result[i]={};", if n.elu { "select(exp(x)-1.0f,x,x>=0.0f)" } else { "x" }),
        "BatchNormalization" => format!("uint channel=i%{c}u;
    result[i]=(input[i]-params[{c2}u+channel])/sqrt(params[{c3}u+channel]+{eps:?}f)*params[channel]+params[{c}u+channel];",
            c2 = 2 * c, c3 = 3 * c, eps = n.attrs["epsilon"].as_f64().unwrap() as f32),
        "Resize" => format!("uint channel=i%{c}u;uint p=i/{c}u;
    uint z=p%{w}u/2u;uint y=p/{w}u%{h}u/2u;uint x=p/{wh}u/2u;
    result[i]=input[((x*{ih}u+y)*{iw}u+z)*{c}u+channel];", wh = w * h),
        "MaxPool" => format!("uint channel=i%{c}u;uint p=i/{c}u;
    uint z=(p%{w}u)*2u;uint y=(p/{w}u%{h}u)*2u;uint x=(p/{wh}u)*2u;
    float value=-3.402823466e38f;
    for(uint dx=0u;dx<2u;dx++){{for(uint dy=0u;dy<2u;dy++){{for(uint dz=0u;dz<2u;dz++){{
      value=max(value,input[(((x+dx)*{ih}u+y+dy)*{iw}u+z+dz)*{c}u+channel]);
    }}}}}}result[i]=value;", wh = w * h),
        "Conv" => format!("float value=0.0f;for(uint k=0u;k<{ci}u;k++){{value+=input[i*{ci}u+k]*other[k];}}result[i]=value+params[0];", ci = n.in_channels),
        _ => unreachable!("plan() admits only the ops above"),
    };
    let groups = size.div_ceil(256);
    let x = groups.min(65535);
    let code = format!("{PRELUDE}kernel void main0(device const float* input [[buffer(0)]], device const float* other [[buffer(1)]],
  device const float* params [[buffer(2)]], device float* result [[buffer(3)]],
  uint3 group [[threadgroup_position_in_grid]], uint tid [[thread_index_in_threadgroup]]) {{
  uint i=(group.x+group.y*{x}u)*256u+tid;if(i>={size}u){{return;}} {body}}}
");
    (
        code,
        MTLSize::new(x as u64, groups.div_ceil(x) as u64, 1),
        MTLSize::new(256, 1, 1),
    )
}

fn pack_conv_weights(values: &[f32], dims: &[usize]) -> Vec<f32> {
    let (co, ci) = (dims[0], dims[1]);
    let taps = dims[2..].iter().product::<usize>();
    let mut packed = vec![0f32; values.len()];
    for o in 0..co {
        for i in 0..ci {
            for k in 0..taps {
                packed[(k * ci + i) * co + o] = values[(o * ci + i) * taps + k];
            }
        }
    }
    packed
}

impl Session {
    pub fn new(model: &[u8], dims: [usize; 3]) -> Result<Self, String> {
        let graph: Value = serde_json::from_str(GRAPH).unwrap();
        let (nodes, slot_bytes, output_slot) = plan(dims, &graph)?;
        let device =
            Device::system_default().ok_or("No Metal device is available; use --device cpu.")?;
        let queue = device.new_command_queue();
        let opts = CompileOptions::new();
        opts.set_fast_math_enabled(false); // keep IEEE FP32 like the WGSL executor
                                           // Metal buffers need at least 16 bytes; never read past a shorter slice.
        let upload = |v: &[f32]| {
            let mut padding = [0.0f32; 4];
            let data = if v.len() < padding.len() {
                padding[..v.len()].copy_from_slice(v);
                &padding[..]
            } else {
                v
            };
            device.new_buffer_with_data(
                data.as_ptr().cast(),
                std::mem::size_of_val(data) as u64,
                MTLResourceOptions::StorageModeShared,
            )
        };
        let values = |name: &str| -> Vec<f32> {
            let t = &graph["tensors"][name];
            let (off, len) = (
                t["offset"].as_u64().unwrap() as usize,
                t["bytes"].as_u64().unwrap() as usize,
            );
            model[off..off + len]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|&c| f32::from_le_bytes(c))
                .collect()
        };
        let slots: Vec<Buffer> = slot_bytes
            .iter()
            .map(|&b| device.new_buffer(b.max(16) as u64, MTLResourceOptions::StorageModeShared))
            .collect();
        let dummy = upload(&[0f32; 4]);
        let mut steps = Vec::new();
        for n in &nodes {
            let (mut other, mut params) = (dummy.clone(), dummy.clone());
            let (code, groups, threads) = if n.op == "Conv" {
                let w = &graph["tensors"][&n.inputs[1]]["dims"];
                let wdims: Vec<usize> = w
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as usize)
                    .collect();
                let raw = values(&n.inputs[1]);
                other = upload(&if n.channels == 1 {
                    raw
                } else {
                    pack_conv_weights(&raw, &wdims)
                });
                if n.inputs.len() > 2 {
                    params = upload(&values(&n.inputs[2]));
                }
                if n.channels == 1 {
                    element_shader(n)
                } else {
                    conv3d_shader(n)
                }
            } else {
                if n.op == "Add" {
                    other = slots[n.input_slots[1]].clone();
                }
                if n.op == "BatchNormalization" {
                    let data: Vec<f32> = (1..5).flat_map(|i| values(&n.inputs[i])).collect();
                    params = upload(&data);
                }
                element_shader(n)
            };
            let library = device
                .new_library_with_source(&code, &opts)
                .map_err(|e| format!("Metal shader {}: {e}", n.name))?;
            let function = library
                .get_function("main0", None)
                .map_err(|e| e.to_string())?;
            let pipeline = device
                .new_compute_pipeline_state_with_function(&function)
                .map_err(|e| format!("Metal pipeline {}: {e}", n.name))?;
            steps.push(Step {
                pipeline,
                buffers: [
                    slots[n.input_slots[0]].clone(),
                    other,
                    params,
                    slots[n.slot].clone(),
                ],
                groups,
                threads,
            });
        }
        Ok(Session {
            queue,
            slots,
            steps,
            output_slot,
            voxels: product(&dims),
        })
    }

    // Native outputs own their Vec: there is no mapped WebGPU readback to unmap.
    pub fn run(&self, input: &[f32]) -> Result<Vec<f32>, String> {
        if input.len() != self.voxels {
            return Err("Metal input size mismatch.".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(
                input.as_ptr(),
                self.slots[0].contents().cast::<f32>(),
                input.len(),
            )
        };
        let cmd = self.queue.new_command_buffer();
        for step in &self.steps {
            let enc = cmd.new_compute_command_encoder();
            enc.set_compute_pipeline_state(&step.pipeline);
            for (i, b) in step.buffers.iter().enumerate() {
                enc.set_buffer(i as u64, Some(b), 0);
            }
            enc.dispatch_thread_groups(step.groups, step.threads);
            enc.end_encoding();
        }
        cmd.commit();
        cmd.wait_until_completed();
        if cmd.status() != MTLCommandBufferStatus::Completed {
            return Err(format!("Metal inference failed: {:?}", cmd.status()));
        }
        let out = self.slots[self.output_slot].contents().cast::<f32>();
        Ok(unsafe { std::slice::from_raw_parts(out, self.voxels) }.to_vec())
    }
}

#[cfg(test)]
mod planner_tests {
    use super::*;

    #[test]
    fn full_volume_slots_preserve_every_live_tensor() {
        let graph: Value = serde_json::from_str(GRAPH).unwrap();
        let (nodes, slots, output_slot) = plan([192, 224, 160], &graph).unwrap();
        let output = nodes.last().unwrap().output.clone();
        let mut remaining = HashMap::from([(output.clone(), 1)]);
        for node in &nodes {
            for input in &node.inputs {
                if !input.is_empty() && graph["tensors"].get(input).is_none() {
                    *remaining.entry(input.clone()).or_default() += 1;
                }
            }
        }
        let mut live = HashMap::from([(graph["input"].as_str().unwrap().to_string(), 0)]);
        for node in &nodes {
            assert!(
                !live.values().any(|&slot| slot == node.slot),
                "{} overwrites a live tensor",
                node.name
            );
            for (index, input) in node.inputs.iter().enumerate() {
                if let Some(&slot) = live.get(input) {
                    assert_eq!(node.input_slots[index], slot);
                }
            }
            live.insert(node.output.clone(), node.slot);
            for input in &node.inputs {
                if let Some(count) = remaining.get_mut(input) {
                    *count -= 1;
                    if *count == 0 {
                        live.remove(input);
                    }
                }
            }
        }
        assert_eq!(live.len(), 1);
        assert_eq!(live[&output], output_slot);
        assert_eq!(slots.len(), 6);
        assert_eq!(slots.iter().sum::<usize>(), 2859171840);
    }
}
