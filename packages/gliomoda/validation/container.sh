#!/bin/bash
# Records the GlioMODA container's segmentation of the example for every bundled model, with the
# container's own command line (mirroring on), and the four-sequence model through nnU-Net with
# use_mirroring=False, the reference for the app's run without mirroring.
#
#   validation/container.sh <example dir> <output dir>
#
# <example dir> holds the four images named as in apps/gliomoda/examples.json. Needs Docker and
# about 15 minutes per model on 8 CPU threads. Existing outputs are kept.
set -u
IMAGE=vnmd/gliomoda_0.0.4@sha256:aeaa0a4aa901667612ae811700123c3b1e3525b5e78a4bcaa262914d53ad0232
IN=$(realpath "$1")
OUT=$(realpath "$2")
CASE=UPENN-GBM-00002_11
declare -A FILE=([t1c]=T1GD [t2f]=FLAIR [t1n]=T1 [t2w]=T2)
# nnU-Net's data loader shares tensors through /dev/shm, which Docker limits to 64 MB.
RUN=(docker run --rm --shm-size=8g -v "$IN:/in:ro" -v "$OUT:/out")
mkdir -p "$OUT"
for model in t1c-t2f-t1n-t2w t1c-t2f-t1n-t2w_ResEncL t1c t2f t2w t1c-t1n t1c-t2f t1c-t2w t2f-t1n t2f-t2w t1c-t1n-t2w t2f-t1n-t2w; do
  [ -f "$OUT/$model.nii.gz" ] && continue
  base=${model%_ResEncL}
  args=()
  for role in ${base//-/ }; do args+=("-$role" "/in/${CASE}_${FILE[$role]}.nii.gz"); done
  [ "$model" != "$base" ] && args+=(--use-res-enc-l)
  start=$(date +%s)
  "${RUN[@]}" --entrypoint /usr/local/bin/gliomoda "$IMAGE" "${args[@]}" --device cpu --threads 8 -o "/out/$model.nii.gz" > "$OUT/$model.log" 2>&1
  echo "$model exit=$? seconds=$(( $(date +%s) - start ))"
done
[ -f "$OUT/t1c-t2f-t1n-t2w_nomirror.nii.gz" ] || "${RUN[@]}" --entrypoint /opt/gliomoda-0.0.4/bin/python3 "$IMAGE" -c "
import pathlib, shutil, tempfile, torch, gliomoda
from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
torch.set_num_threads(8)
weights = next((pathlib.Path(gliomoda.__file__).parent / 'weights').glob('weights_v*'))
predictor = nnUNetPredictor(device=torch.device('cpu'), use_mirroring=False)
predictor.initialize_from_trained_model_folder(str(weights / 't1c-t2f-t1n-t2w'), use_folds=('all',))
with tempfile.TemporaryDirectory() as out:
    predictor.predict_from_files([['/in/${CASE}_T1GD.nii.gz', '/in/${CASE}_FLAIR.nii.gz', '/in/${CASE}_T1.nii.gz', '/in/${CASE}_T2.nii.gz']], out)
    shutil.copy(next(pathlib.Path(out).glob('*.nii.gz')), '/out/t1c-t2f-t1n-t2w_nomirror.nii.gz')
" > "$OUT/t1c-t2f-t1n-t2w_nomirror.log" 2>&1
echo "t1c-t2f-t1n-t2w_nomirror exit=$?"
