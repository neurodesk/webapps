"""Remove >2 GiB decoder concatenations without changing spatial context or weights.

Conv(concat(a,b),W) = Conv(a,Wa) + Conv(b,Wb). Floating accumulation
order changes; validate the resulting signed distance and mask against the source.
"""
import argparse,hashlib,pathlib,onnx
from onnx import helper as oh,numpy_helper as nh
p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('output');a=p.parse_args()
source=pathlib.Path(a.source).read_bytes()
# The ONNX exports of FreeSurfer's synthstrip.1.pt and synthstrip.nocsf.1.pt (same graph, other weights).
SOURCES={'7b8eeecf3793a6c4510b9f5270ecc03d9c3262d26e08d568203a651ab4b84074','a1618df5f8f08b77917793d1e043fd4382563ddc09faa5e93489db0a74ae61f5'}
assert hashlib.sha256(source).hexdigest() in SOURCES
m=onnx.load_model_from_string(source);arrays={w.name:nh.to_array(w) for w in m.graph.initializer}
concats={n.output[0]:n for n in m.graph.node if n.op_type=='Concat'}
# These channel counts belong to the hash-pinned model's encoder skip tensors.
splits={f'/decoder.{i}.0/conv/Conv':64 for i in range(1,6)}
splits['/remaining.0/conv/Conv']=32
removed=set();nodes=[];count=0
for node in m.graph.node:
 if node.name not in splits:nodes.append(node);continue
 cat=concats[node.input[0]];weight=arrays[node.input[1]];split=splits[node.name]
 assert node.op_type=='Conv' and len(cat.input)==2
 assert oh.get_attribute_value(next(a for a in cat.attribute if a.name=='axis'))==1
 removed.add(cat.output[0]);count+=1
 attrs={a.name:oh.get_attribute_value(a) for a in node.attribute}
 assert attrs.get('group',1)==1
 for i,kernel in enumerate([weight[:,:split],weight[:,split:]]):
  name=node.name+f'_part{i}';key=name+'_W'
  m.graph.initializer.append(nh.from_array(kernel.copy(),key))
  nodes.append(oh.make_node('Conv',[cat.input[i],key]+([node.input[2]] if i==0 else []),[name],name=name,**attrs))
 nodes.append(oh.make_node('Add',[node.name+'_part0',node.name+'_part1'],list(node.output),name=node.name+'_sum'))
assert count==6
del m.graph.node[:];m.graph.node.extend(n for n in nodes if not(n.op_type=='Concat' and n.output[0] in removed))
used={i for n in m.graph.node for i in n.input};weights=[w for w in m.graph.initializer if w.name in used]
del m.graph.initializer[:];m.graph.initializer.extend(weights)
oh.set_model_props(m,{'source_sha256':hashlib.sha256(source).hexdigest(),'rewrite':'Split channel concat convolutions; unchanged spatial context and weights','license':'Apache-2.0'})
onnx.checker.check_model(m);out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);onnx.save(m,out)
print(out.stat().st_size,hashlib.sha256(out.read_bytes()).hexdigest())
