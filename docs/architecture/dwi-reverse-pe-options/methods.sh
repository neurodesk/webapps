#!/usr/bin/env bash
# Run one method on one prepared subject.
# Usage: methods.sh <subject> <method>
# Methods: topup topup-single ants pyhysco pyhysco-gpu qwarp drbuddi fdnet fdnet-pa-first
# Each method writes runs/<subject>/<method>/ with time.log and its own outputs.
# fields.py then converts those outputs to field_hz.nii.gz on the AP b0 grid.
set -euo pipefail
source "$(dirname "$0")/common.sh"
sub=$1 method=$2
prep=$ROOT/runs/$sub/prep
out=$ROOT/runs/$sub/$method
rm -rf "$out"
mkdir -p "$out"
cd "$out"
pe=$(py -c "import json; print(json.load(open('$prep/prep.json'))['ap']['pe'])")

# The PE axis as 1-based voxel dimension and as an ANTs restriction mask.
case ${pe:0:1} in
  i) dim=1 restrict=1x0x0 ;;
  j) dim=2 restrict=0x1x0 ;;
  k) dim=3 restrict=0x0x1 ;;
esac

case $method in
  topup)
    timed time.log fsl topup --imain="$prep/topup_in" --datain="$prep/acqparams.txt" \
      --config=b02b0.cnf --out=topup --fout=topup_fout --iout=topup_iout --nthr=$THREADS -v > topup.log
    ;;
  topup-single)
    timed time.log fsl topup --imain="$prep/topup_in_single" --datain="$prep/acqparams_single.txt" \
      --config=b02b0.cnf --out=topup --fout=topup_fout --iout=topup_iout --nthr=$THREADS -v > topup.log
    ;;
  ants)
    # SyN restricted to the PE axis, PA moved onto AP. The schedule is the
    # SyN-SDC one (#460, sdcflows sd_syn.json); the metric is CC because both
    # images are SE-EPI b0. The physical restriction equals the voxel PE axis
    # only for a grid without rotation, which holds for both datasets.
    # --restrict-deformation is a per-stage option, so each stage carries it.
    timed time.log ants antsRegistration -d 3 -v 1 \
      -o "[ants_]" \
      -t "SyN[0.8,6.0,10.0]" \
      -m "CC[$prep/ap_mean.nii.gz,$prep/pa_mean_reg.nii.gz,1,4]" \
      -c "[200x100,1e-6,5]" -f 1x1 -s 2x0vox --restrict-deformation $restrict \
      -t "SyN[0.8,2.0,0.5]" \
      -m "CC[$prep/ap_mean.nii.gz,$prep/pa_mean_reg.nii.gz,1,4]" \
      -c "[10,1e-8,2]" -f 1 -s 0vox --restrict-deformation $restrict \
      --winsorize-image-intensities "[0.001,0.998]" -u 1 > ants.log
    ;;
  pyhysco | pyhysco-gpu)
    device=cpu
    [[ $method == pyhysco-gpu ]] && device=cuda:0
    timed time.log "$ROOT/venv-main/bin/python" "$SCRIPTS/run_pyhysco.py" \
      "$prep/ap_mean.nii.gz" "$prep/pa_mean_reg.nii.gz" $dim $device . > pyhysco.log
    ;;
  qwarp)
    # The sdcflows init_3dQwarp_wf settings. -noXdis/-noZdis keep the warp on
    # the PE axis for j; the case below picks the pair for other axes.
    case $dim in
      1) nodis="-noYdis -noZdis" ;;
      2) nodis="-noXdis -noZdis" ;;
      3) nodis="-noXdis -noYdis" ;;
    esac
    timed time.log afni 3dQwarp -plusminus -base "$prep/ap_mean.nii.gz" -source "$prep/pa_mean_reg.nii.gz" \
      -blur -1 -1 -minpatch 9 -noweight -pblur 0.05 0.05 -nopadWARP $nodis \
      -prefix qwarp.nii.gz > qwarp.log 2>&1
    ;;
  drbuddi)
    py "$SCRIPTS/drbuddi_inputs.py" "$prep/ap_mean.nii.gz" "$prep/pa_mean_reg.nii.gz" "$pe" .
    timed time.log qsiprep DRBUDDI -u "$out/blip_up_b0.nii" -d "$out/blip_down_b0.nii" \
      --up_json "$out/blip_up.json" --ncores $THREADS --disable_itk_threads > drbuddi.log 2>&1
    ;;
  fdnet | fdnet-pa-first)
    order=ap-first
    [[ $method == fdnet-pa-first ]] && order=pa-first
    timed time.log "$ROOT/venv-fdnet/bin/python" "$SCRIPTS/run_fdnet.py" \
      "$ROOT/src/FD-Net" "$prep/ap_mean.nii.gz" "$prep/pa_mean_reg.nii.gz" $dim . $order > fdnet.log 2>&1
    ;;
  *)
    echo "unknown method $method" >&2
    exit 1
    ;;
esac
