# Runs inside garciaml/brainqcnetcpu (torch 1.9, med2image 2.2.10, Pillow 10.3).
# Repeats predict_all_axes.py's per-slice preprocessing and forward pass on the
# PNG slices med2image wrote, recording what the browser port must reproduce.
import hashlib, json, os, sys
import numpy as np
import torch
import torchvision.transforms as transforms
from PIL import Image
sys.path.insert(0, '/app')
from preprocess import mean, std

slice_dir, model_path, out_path = sys.argv[1:4]
ppnet = torch.load(model_path, map_location=torch.device('cpu'))
size = ppnet.img_size
resize = transforms.Resize((size, size))
to_tensor = transforms.Compose([transforms.ToTensor(), transforms.Normalize(mean=mean, std=std)])
slices = []
for axis in 'xyz':
    names = sorted(f for f in os.listdir(os.path.join(slice_dir, axis)) if 'png' in f)
    for name in names:
        index = int(name.split('slice')[-1].split('.png')[0])
        rgb = Image.open(os.path.join(slice_dir, axis, name)).convert('RGB')
        png = np.asarray(rgb)
        resized = resize(rgb)
        tensor = to_tensor(resized).unsqueeze(0)
        with torch.no_grad():
            logits, _ = ppnet(tensor)
        logits = logits[0].numpy().astype(np.float32)
        slices.append({
            'axis': axis,
            'slice': index,
            'shape': list(png.shape[:2]),
            'png_gray_sha256': hashlib.sha256(np.ascontiguousarray(png[:, :, 0]).tobytes()).hexdigest(),
            'gray_channels_equal': bool((png[:, :, 0] == png[:, :, 1]).all() and (png[:, :, 0] == png[:, :, 2]).all()),
            'resized_gray_sha256': hashlib.sha256(np.ascontiguousarray(np.asarray(resized)[:, :, 0]).tobytes()).hexdigest(),
            'logits': [float(v) for v in logits],
            'pred': int(np.argmax(logits)),
        })
        np.save(os.path.join(slice_dir, f'tensor_{axis}{index:03d}.npy'), tensor.numpy()) if os.environ.get('SAVE_TENSORS') else None
json.dump({'img_size': size, 'slices': slices}, open(out_path, 'w'))
