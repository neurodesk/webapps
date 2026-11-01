#!/bin/sh
# Inside garciaml/brainqcnetcpu: the steps of preprocess_and_predict.sh for one
# T1w file, keeping the slice PNGs, then dump_slices.py over them.
# Usage: run_reference.sh <input.nii[.gz]> <outdir> <modeldir> <subid>
set -e
set -u
INPATH=$1; OUTDIR=$2; MODELDIR=$3; SUBID=$4
FILENAME=$(basename "$INPATH")
cd /app
. venv/bin/activate
mkdir -p "$OUTDIR"
WORK=$(mktemp -d)
python3 crop_nii.py -inpath "$INPATH" -outdir "$WORK" -filename "$FILENAME"
med2image --inputFile "$WORK/$FILENAME" --outputDir "$OUTDIR" --outputFileStem "$SUBID" --outputFileType png --sliceToConvert -1 --reslice > "$OUTDIR/med2image.log" 2>&1
python predict_all_axes.py -modeldir "$MODELDIR" -model 10push0.8167.pth -partid "$SUBID" -imgdir "$OUTDIR" -masks 0 > "$OUTDIR/predict.log" 2>&1
python transform_log_to_csv.py -indir "$OUTDIR" -subid "$SUBID" -method percentage -n_areas 3
[ "${DUMP:-0}" = 1 ] && python /harness/dump_slices.py "$OUTDIR" "$MODELDIR/10push0.8167.pth" "$OUTDIR/slices.json"
