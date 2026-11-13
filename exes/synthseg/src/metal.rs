// Native Metal executor, from exes/synthsr/src/metal.rs: NDHWC layout, blocked FP32 implicit-GEMM
// Conv3D, buffer slots reused by tensor lifetime. SynthSeg additions: Concat, Softmax, and output
// channels padded to a multiple of four for the 33-class classifier.
use crate::nifti::product;
use metal::*;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Write;

const GRAPH: &str = include_str!("../../../packages/synthseg/src/gpu-model.json");
const POSITIONS: usize = 2; // spatial positions accumulated per thread
const CHUNK: usize = 16; // reduction elements staged per barrier
const ROWS: usize = 64; // thread rows per threadgroup
const CLASSES: usize = crate::post::N;
// Feature metal-f16: intermediate activations stored as half (fp32 accumulation); the graph input
// and the softmax output stay float so no CPU-side conversion is needed.
const HALF: bool = cfg!(feature = "metal-f16");
const ELEMENT: usize = if HALF { 2 } else { 4 };

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
    /// Channels of the second input (Concat).
    other_channels: usize,
    slot: usize,
    input_slots: Vec<usize>,
    /// MSL scalar type of the first input / the output buffer.
    t_in: &'static str,
    t_out: &'static str,
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
    dims: [usize; 3],
    device_name: String,
    activation_bytes: usize,
    recommended_working_set_bytes: u64,
}

fn pad4(c: usize) -> usize {
    c.div_ceil(4) * 4
}

// ponytail: the graph is checksum-tied to the embedded model and validated by scripts/check_onnx.py,
// so only what selects a kernel is inspected here.
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
    let mut nodes = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let src = &raw[i];
        let op = src["op"].as_str().unwrap().to_string();
        let inputs: Vec<String> = src["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let mut output = src["output"].as_str().unwrap().to_string();
        let (in_dims, in_channels) = *shapes
            .get(&inputs[0])
            .ok_or(format!("Missing Metal graph input: {}", inputs[0]))?;
        let (mut out_dims, mut channels, mut kernel, mut other_channels) =
            (in_dims, in_channels, 0, 0);
        match op.as_str() {
            "Conv" => {
                let w = graph["tensors"][&inputs[1]]["dims"].as_array().unwrap();
                channels = pad4(w[0].as_u64().unwrap() as usize);
                kernel = w[2].as_u64().unwrap() as usize;
            }
            "MaxPool" => out_dims = in_dims.map(|d| d / 2),
            "Resize" => out_dims = in_dims.map(|d| d * 2),
            "Concat" => {
                other_channels = shapes.get(&inputs[1]).ok_or("Missing Concat input")?.1;
                channels = in_channels + other_channels;
            }
            "Softmax" => channels = CLASSES,
            "Elu" | "BatchNormalization" => {}
            other => return Err(format!("Unsupported Metal operator: {other}")),
        }
        let mut elu = false;
        if op == "Conv" {
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
        let t_in = if !HALF || inputs[0] == graph["input"].as_str().unwrap() {
            "float"
        } else {
            "half"
        };
        let t_out = if !HALF || op == "Softmax" {
            "float"
        } else {
            "half"
        };
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
            other_channels,
            slot: 0,
            input_slots: vec![],
            t_in,
            t_out,
        });
        i += 1;
    }
    if shapes.get(output_name) != Some(&(dims, CLASSES)) {
        return Err("Metal output does not match the SynthSeg contract.".into());
    }
    // Reusable buffers by lifetime; never alias a node's input and output.
    let mut remaining: HashMap<String, usize> = HashMap::from([(output_name.to_string(), 1)]);
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
        let bytes = product(&n.dims) * n.channels * if n.t_out == "float" { 4 } else { ELEMENT };
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
    let output_slot = assigned[output_name];
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
    let _ = write!(
        s,
        "static inline float gather(device const {t_in}* input, uint position, uint k) {{
  if (position >= {spatial}u || k >= {reduction}u) {{ return 0.0f; }}
  uint tap = k / {ci}u;
  int z = int(position % {w}u) + int(tap % {k}u) - {p};
  int y = int(position / {w}u % {h}u) + int(tap / {k}u % {k}u) - {p};
  int x = int(position / {wh}u) + int(tap / {kk}u) - {p};
  if (x < 0 || y < 0 || z < 0 || x >= {d} || y >= {h} || z >= {w}) {{ return 0.0f; }}
  return float(input[((uint(x)*{h}u+uint(y))*{w}u+uint(z))*{ci}u+k%{ci}u]);
}}
kernel void main0(device const {t_in}* input [[buffer(0)]], device const float4* weights [[buffer(1)]],
  device const float4* biases [[buffer(2)]], device {t_out}4* result [[buffer(3)]],
  uint3 group [[threadgroup_position_in_grid]], uint3 local_id [[thread_position_in_threadgroup]]) {{
  threadgroup float a[{a_len}];
  threadgroup float4 b[{b_len}];
  uint base = (group.x + group.y*{groups_x}u)*{positions}u;
  uint channel = group.z*{tile}u + local_id.x*{channels}u;
  uint tid = local_id.y*{columns}u+local_id.x;
",
        t_in = n.t_in,
        t_out = n.t_out,
        p = k / 2,
        wh = w * h,
        kk = k * k,
        a_len = CHUNK * positions,
        b_len = CHUNK * tile / 4
    );
    for p in 0..POSITIONS {
        for j in 0..lanes {
            let _ = writeln!(s, "  float4 sum{p}_{j} = float4(0.0f);");
        }
    }
    let _ = write!(
        s,
        "  for (uint start=0u; start<{reduction}u; start+={CHUNK}u) {{
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
",
        a_len = CHUNK * positions,
        b_len = CHUNK * tile / 4,
        stride = columns * ROWS,
        tile4 = tile / 4
    );
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
            let elu = if n.elu {
                "value = select(exp(value) - float4(1.0f), value, value >= float4(0.0f));"
            } else {
                ""
            };
            let _ = writeln!(s, "    {{ float4 value = sum{p}_{j} + biases[channel / 4u + {j}u]; {elu} result[position{p} * {out_vectors}u + channel / 4u + {j}u] = {t_out}4(value); }}", t_out = n.t_out);
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
    let [_, ih, iw] = n.in_dims;
    let ci = n.in_channels;
    let mut size = d * h * w * c;
    let body = match n.op.as_str() {
        "Elu" => "float x=float(input[i]);result[i]=T(select(exp(x)-1.0f,x,x>=0.0f));".to_string(),
        "BatchNormalization" => format!(
            "uint channel=i%{c}u;
    result[i]=T((float(input[i])-params[{c2}u+channel])/sqrt(params[{c3}u+channel]+{eps:?}f)*params[channel]+params[{c}u+channel]);",
            c2 = 2 * c,
            c3 = 3 * c,
            eps = n.attrs["epsilon"].as_f64().unwrap() as f32
        ),
        "Resize" => format!(
            "uint channel=i%{c}u;uint p=i/{c}u;
    uint z=p%{w}u/2u;uint y=p/{w}u%{h}u/2u;uint x=p/{wh}u/2u;
    result[i]=T(input[((x*{ih}u+y)*{iw}u+z)*{c}u+channel]);",
            wh = w * h
        ),
        "MaxPool" => format!(
            "uint channel=i%{c}u;uint p=i/{c}u;
    uint z=(p%{w}u)*2u;uint y=(p/{w}u%{h}u)*2u;uint x=(p/{wh}u)*2u;
    float value=-3.402823466e38f;
    for(uint dx=0u;dx<2u;dx++){{for(uint dy=0u;dy<2u;dy++){{for(uint dz=0u;dz<2u;dz++){{
      value=max(value,float(input[(((x+dx)*{ih}u+y+dy)*{iw}u+z+dz)*{c}u+channel]));
    }}}}}}result[i]=T(value);",
            wh = w * h
        ),
        "Concat" => format!(
            "uint channel=i%{c}u;uint p=i/{c}u;
    result[i]=T(channel<{ci}u?float(input[p*{ci}u+channel]):float(other[p*{co}u+channel-{ci}u]));",
            co = n.other_channels
        ),
        // One thread per voxel over the padded classifier channels; only the first CLASSES count.
        "Softmax" => {
            size = d * h * w;
            format!(
                "float m=float(input[i*{ci}u]);for(uint k=1u;k<{c}u;k++){{m=max(m,float(input[i*{ci}u+k]));}}
    float s=0.0f;for(uint k=0u;k<{c}u;k++){{float e=exp(float(input[i*{ci}u+k])-m);result[i*{c}u+k]=e;s+=e;}}
    for(uint k=0u;k<{c}u;k++){{result[i*{c}u+k]/=s;}}"
            )
        }
        _ => unreachable!("plan() admits only the ops above"),
    };
    let groups = size.div_ceil(256);
    let x = groups.min(65535);
    let code = format!(
        "{PRELUDE}#define T {t_out}
kernel void main0(device const {t_in}* input [[buffer(0)]], device const {t_other}* other [[buffer(1)]],
  device const float* params [[buffer(2)]], device {t_out}* result [[buffer(3)]],
  uint3 group [[threadgroup_position_in_grid]], uint tid [[thread_index_in_threadgroup]]) {{
  uint i=(group.x+group.y*{x}u)*256u+tid;if(i>={size}u){{return;}} {body}}}
",
        t_in = n.t_in,
        t_out = n.t_out,
        t_other = if HALF { "half" } else { "float" }
    );
    (
        code,
        MTLSize::new(x as u64, groups.div_ceil(x) as u64, 1),
        MTLSize::new(256, 1, 1),
    )
}

/// ONNX [co, ci, k, k, k] -> [tap][ci][co_padded] so a reduction index k*ci+i addresses one float4 row per 4 outputs.
fn pack_conv_weights(values: &[f32], dims: &[usize], co_padded: usize) -> Vec<f32> {
    let (co, ci) = (dims[0], dims[1]);
    let taps = dims[2..].iter().product::<usize>();
    let mut packed = vec![0f32; taps * ci * co_padded];
    for o in 0..co {
        for i in 0..ci {
            for k in 0..taps {
                packed[(k * ci + i) * co_padded + o] = values[(o * ci + i) * taps + k];
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
        opts.set_fast_math_enabled(false); // keep IEEE FP32 like ONNX Runtime
        let upload = |v: &[f32]| {
            let padded;
            let v = if v.len() < 4 {
                padded = [v, &[0.0; 4][..4 - v.len()]].concat();
                &padded[..]
            } else {
                v
            };
            device.new_buffer_with_data(
                v.as_ptr().cast(),
                (v.len() * 4) as u64,
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
                .map(|c| f32::from_le_bytes(*c))
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
                let wdims: Vec<usize> = graph["tensors"][&n.inputs[1]]["dims"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as usize)
                    .collect();
                other = upload(&pack_conv_weights(
                    &values(&n.inputs[1]),
                    &wdims,
                    n.channels,
                ));
                let mut bias = values(&n.inputs[2]);
                bias.resize(n.channels, 0.0);
                params = upload(&bias);
                conv3d_shader(n)
            } else {
                if n.op == "Concat" {
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
            dims,
            device_name: device.name().to_string(),
            activation_bytes: slot_bytes.iter().sum(),
            recommended_working_set_bytes: device.recommended_max_working_set_size(),
        })
    }

    // Native outputs own their Vec (including the layout transpose); WebGPU alone
    // lends a mapped readback view until dispose, the next run, or session release.
    /// Softmax posteriors, channel-major (CLASSES × voxels) like the ORT path.
    pub fn run(&self, input: &[f32]) -> Result<Vec<f32>, String> {
        let voxels = product(&self.dims);
        if input.len() != voxels {
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
            return Err(format!(
                "Metal inference failed: {:?}; device: {}; volume: {:?}; activation buffers: {} bytes; \
                 recommended Metal working set: {} bytes. CPU posteriors need additional memory. \
                 Retry with --device cpu on resource-limited systems.",
                cmd.status(), self.device_name, self.dims,
                self.activation_bytes, self.recommended_working_set_bytes,
            ));
        }
        let out = unsafe {
            std::slice::from_raw_parts(
                self.slots[self.output_slot].contents().cast::<f32>(),
                voxels * CLASSES,
            )
        };
        let mut post = vec![0f32; voxels * CLASSES];
        for (v, chunk) in out.as_chunks::<CLASSES>().0.iter().enumerate() {
            for (c, &x) in chunk.iter().enumerate() {
                post[c * voxels + v] = x;
            }
        }
        Ok(post)
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
        if !HALF {
            assert_eq!(slots.iter().sum::<usize>(), 4180377600);
        }
    }
}
