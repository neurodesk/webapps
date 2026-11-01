#!/bin/sh
# Inside garciaml/brainqcnetcpu: crop_nii.py and med2image only, then the PNG hashes.
set -eu
INPATH=$1; OUTDIR=$2
cd /app && . venv/bin/activate
WORK=$(mktemp -d); FILENAME=$(basename "$INPATH")
python3 crop_nii.py -inpath "$INPATH" -outdir "$WORK" -filename "$FILENAME"
med2image --inputFile "$WORK/$FILENAME" --outputDir "$OUTDIR" --outputFileStem s --outputFileType png --sliceToConvert -1 --reslice > /dev/null 2>&1
python3 - "$OUTDIR" <<'PY'
import hashlib, json, os, sys
import numpy as np
from PIL import Image
d = sys.argv[1]; slices = []
for axis in 'xyz':
    for name in sorted(os.listdir(os.path.join(d, axis))):
        a = np.asarray(Image.open(os.path.join(d, axis, name)).convert('RGB'))
        r = np.asarray(Image.open(os.path.join(d, axis, name)).convert('RGB').resize((224, 224), Image.BILINEAR))
        slices.append({'axis': axis, 'slice': int(name.split('slice')[-1][:-4]), 'shape': list(a.shape[:2]),
                       'png_gray_sha256': hashlib.sha256(np.ascontiguousarray(a[:, :, 0]).tobytes()).hexdigest(),
                       'resized_gray_sha256': hashlib.sha256(np.ascontiguousarray(r[:, :, 0]).tobytes()).hexdigest()})
json.dump({'slices': slices}, open(os.path.join(d, 'slices.json'), 'w'))
PY
