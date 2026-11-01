# Runs the exported ONNX on the slices a reference run kept and compares with
# the logits torch 1.9 produced in the original container.
import hashlib, json, os, sys
import numpy as np, onnxruntime as ort
from PIL import Image

onnx_path, ref_dir = sys.argv[1:3]
ref = json.load(open(os.path.join(ref_dir, 'slices.json')))
sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
mean = np.array([0.485, 0.456, 0.406], np.float32).reshape(3, 1, 1)
std = np.array([0.229, 0.224, 0.225], np.float32).reshape(3, 1, 1)
stem = os.path.basename(ref_dir).split('_')[0]
batch, meta, worst, flips, hash_bad = [], [], 0.0, 0, 0
def flush():
    global worst, flips
    out = sess.run(['logits'], {'input': np.stack(batch)})[0]
    for s, l in zip(meta, out):
        worst = max(worst, float(np.abs(l - np.array(s['logits'], np.float32)).max()))
        flips += int(int(np.argmax(l)) != s['pred'])
    batch.clear(); meta.clear()
for s in ref['slices']:
    img = Image.open(os.path.join(ref_dir, s['axis'], f"{stem}-slice{s['slice']:03d}.png")).convert('RGB')
    r = img.resize((224, 224), Image.BILINEAR)
    a = np.asarray(r)
    hash_bad += hashlib.sha256(np.ascontiguousarray(a[:, :, 0]).tobytes()).hexdigest() != s['resized_gray_sha256']
    x = (a.transpose(2, 0, 1).astype(np.float32) / np.float32(255) - mean) / std
    batch.append(x); meta.append(s)
    if len(batch) == 16: flush()
if batch: flush()
print(json.dumps({'slices': len(ref['slices']), 'resize_hash_mismatch': int(hash_bad), 'max_abs_logit_diff': worst, 'pred_flips': flips}))
if hash_bad or flips:
    sys.exit(1)
