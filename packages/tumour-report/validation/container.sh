#!/usr/bin/env bash
# Record reference outputs from the pinned Raidionics v1.3.2 CPU container on a native-space T1c scan.
#
#   bash packages/tumour-report/validation/container.sh <input_t1c.nii.gz> <models_dir> <output_dir>
#
# <models_dir> holds extracted MRI_Brain/ and MRI_TumorCore/ from Raidionics-models v1.3.0-rc.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <input_t1c.nii.gz> <models_dir> <output_dir>" >&2
  exit 2
fi

INPUT_FILE="$(realpath "$1")"
MODELS_DIR="$(realpath "$2")"
OUTPUT_DIR="$(realpath -m "$3")"
IMAGE="dbouget/raidionics-rads@sha256:ef2861258f92e66c21ded1405ec5ffa856ffda9cd9bda38ae90e07ade01946ab"
BASE_NAME="$(basename "$INPUT_FILE" .nii.gz)"
BASE_NAME="${BASE_NAME%.nii}"

WORK_DIR="${OUTPUT_DIR}/work"
mkdir -p "${WORK_DIR}/input/T0/raw" "${WORK_DIR}/output"
cp "$INPUT_FILE" "${WORK_DIR}/input/T0/raw/${BASE_NAME}_t1c.nii.gz"

cat > "${WORK_DIR}/input/mri_sequences.csv" <<CSV
File,MRI sequence
${BASE_NAME}_t1c,T1-CE
CSV

cat > "${WORK_DIR}/pipeline.json" <<'JSON'
{
  "1": {
    "task": "Segmentation",
    "inputs": {
      "0": { "timestamp": 0, "sequence": "T1-CE", "labels": null, "space": { "timestamp": 0, "sequence": "T1-CE" } }
    },
    "target": ["Brain"],
    "model": "MRI_Brain",
    "format": "thresholding",
    "description": "Brain segmentation in T1CE"
  },
  "2": {
    "task": "Segmentation",
    "inputs": {
      "0": { "timestamp": 0, "sequence": "T1-CE", "labels": null, "space": { "timestamp": 0, "sequence": "T1-CE" } }
    },
    "target": ["Tumor"],
    "model": "MRI_TumorCore/t1c",
    "format": "thresholding",
    "description": "Tumor core segmentation"
  },
  "3": {
    "task": "Segmentation refinement",
    "inputs": {
      "0": { "timestamp": 0, "sequence": "T1-CE", "labels": "Tumor", "space": { "timestamp": 0, "sequence": "T1-CE" } }
    },
    "operation": "brain_overlap",
    "args": [],
    "description": "Tumor core refinement"
  },
  "4": {
    "task": "Registration",
    "moving": { "timestamp": 0, "sequence": "T1-CE" },
    "fixed": { "timestamp": -1, "sequence": "MNI" },
    "description": "Register T1-CE to MNI"
  },
  "5": {
    "task": "Apply registration",
    "moving": { "timestamp": 0, "sequence": "T1-CE" },
    "fixed": { "timestamp": -1, "sequence": "MNI" },
    "direction": "forward",
    "description": "Apply MNI registration"
  }
}
JSON

cat > "${WORK_DIR}/config.ini" <<'INI'
[Default]
task=neuro_diagnosis
trace=true
caller=raidionics

[System]
gpu_id=-1
acceleration=cpu
input_folder=/work/input
output_folder=/work/output
model_folder=/models
pipeline_filename=/work/pipeline.json

[Runtime]
overlapping_ratio=0.0
batch_size=1
reconstruction_method=thresholding
reconstruction_order=resample_first
use_stripped_data=false
use_registered_data=false
test_time_augmentation_iteration=0
test_time_augmentation_fusion_mode=average

[Neuro]
cortical_features=MNI,Schaefer7,Schaefer17
subcortical_features=BCB
INI

docker run --rm --user "$(id -u):$(id -g)" \
  -e MPLCONFIGDIR=/tmp/mpl \
  -v "${WORK_DIR}:/work" \
  -v "${MODELS_DIR}:/models:ro" \
  "$IMAGE" \
  -c /work/config.ini -v info
