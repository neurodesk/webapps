import hashlib, json
import numpy as np
from PIL import Image
out = []
for rows, cols in [(2, 3), (17, 300), (255, 232), (224, 100), (400, 224), (224, 224), (191, 640)]:
    i = np.arange(rows * cols, dtype=np.uint64)
    a = (((i * np.uint64(2654435761)) & np.uint64(0xffffffff)) % np.uint64(251)).astype(np.uint8).reshape(rows, cols)
    rgb = Image.fromarray(np.stack([a, a, a], -1), 'RGB')
    r = np.asarray(rgb.resize((224, 224), Image.BILINEAR))[:, :, 0]
    out.append({'rows': rows, 'cols': cols, 'sha256': hashlib.sha256(np.ascontiguousarray(r).tobytes()).hexdigest()})
print(json.dumps(out, indent=2))
