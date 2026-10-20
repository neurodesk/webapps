# Shared settings for the reverse-PE reference runs. Source it; do not run it.
# ROOT holds bids/, containers/, tools/, venv-*/ and runs/.
ROOT=${ROOT:-$HOME/scratch/reverse-pe}
SCRIPTS=${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
CVMFS=/cvmfs/neurodesk.ardc.edu.au/containers

FSL_IMAGE=$CVMFS/fsl_6.0.7.23_20261013/fsl_6.0.7.23_20261013.simg
ANTS_IMAGE=$CVMFS/ants_2.6.5_20261012/ants_2.6.5_20261012.simg
AFNI_IMAGE=$CVMFS/afni_26.3.04_20261015/afni_26.3.04_20261015.simg
QSIPREP_IMAGE=$ROOT/containers/qsiprep-26.1.1.sif

# Every method runs with 8 threads, about a laptop.
THREADS=8
export OMP_NUM_THREADS=$THREADS
export ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=$THREADS
export MKL_NUM_THREADS=$THREADS
export OPENBLAS_NUM_THREADS=$THREADS
export FSLOUTPUTTYPE=NIFTI_GZ

in_image() {
  local image=$1
  shift
  apptainer exec --cleanenv \
    --env OMP_NUM_THREADS=$THREADS,ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=$THREADS,FSLOUTPUTTYPE=NIFTI_GZ \
    -B "$ROOT" -B "$SCRIPTS" "$image" "$@"
}
fsl() { in_image "$FSL_IMAGE" "$@"; }
ants() { in_image "$ANTS_IMAGE" "$@"; }
afni() { in_image "$AFNI_IMAGE" "$@"; }
qsiprep() { in_image "$QSIPREP_IMAGE" "$@"; }
# The FSL image's Python has nibabel, numpy and scipy.
py() { fsl python3 "$@"; }

# timed <log> <command...>: wall time and peak RSS of one method. GNU time
# runs executables only, so the command runs in a bash that has the wrappers.
export ROOT SCRIPTS THREADS FSL_IMAGE ANTS_IMAGE AFNI_IMAGE QSIPREP_IMAGE
export -f in_image fsl ants afni qsiprep py
timed() {
  local log=$1
  shift
  /usr/bin/time -v -o "$log" bash -c '"$@"' _ "$@"
}

mindgrab_mask() {
  node "$SCRIPTS/mindgrab-mask.mjs" "$@"
}
