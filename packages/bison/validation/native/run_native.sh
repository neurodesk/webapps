#!/usr/bin/env bash
# Native MINC reference for BISON (T1 only, 8 classes) and BISON-WMH (T1 + FLAIR, 9 classes).
#
# Usage:
#   run_native.sh <work-dir> <subject> <run-name> [options]
#
# Options:
#   --denoise mincnlm|ants-rician|ants-gaussian   denoiser for T1 and FLAIR (default mincnlm)
#   --xfm forward|inverse    XFMs column for BISON: forward = T1toTemplate_pp_both.xfm,
#                            inverse = xfminvert of it, template -> subject (default: inverse;
#                            the geometry check on sub-HML0541 shows forward is wrong, README
#                            "XFM direction")
#   --volpol unmasked|masked-order1|masked-order2
#                            volume_pol variant (default unmasked = upstream -d, --order 1);
#                            masked-* add --source_mask <lin mask> --target_mask Mask.mnc, as in
#                            upstream's commented-out line (which used --order 2). Diagnostic only.
#   --flair-reg minctracc|ants
#                            FLAIR -> T1 rigid: minctracc = upstream bestlinreg_s2 -lsq6 -mi -close
#                            (default); ants = native antsRegistration Rigid, Mattes MI, converted
#                            to FLAIRtoT1.xfm by itk_to_xfm.py (README "FLAIR registration")
#   --stages LIST            comma list of preproc,geometry,bison,export (default all)
#
# The work dir must hold lib/, scripts/, venv/ (setup_native.sh) and data/<subject>/
# (fetch_subjects.py). Every result goes to <work-dir>/runs/<run-name>/<subject>/:
#   preproc/    every preprocessing checkpoint (MINC, XFM, volume_pol expression files)
#   geometry/   itk_resample of Mask.mnc and SP_1.mnc through both XFM candidates + geometry.json
#   t1/         BISON_L8.py run: list.csv, out/ (upstream outputs), tmp/ (upstream -t files),
#               warped/ (the -t priors and av images under stable names), export/
#   t1-flair/   BISON_L9.py run, same layout
#   commands.log, timings.tsv
# A step whose output exists is skipped, so a failed run resumes. Use a new run name
# for an independent repeat (the determinism check compares two run names).
set -euo pipefail

work=$(realpath "$1")
sub=$2
run=$3
shift 3
denoise=mincnlm
xfm_choice=inverse
stages=preproc,geometry,bison,export
volpol=unmasked
flair_reg=minctracc
while (($#)); do
  case $1 in
    --denoise) denoise=$2; shift 2 ;;
    --xfm) xfm_choice=$2; shift 2 ;;
    --stages) stages=$2; shift 2 ;;
    --volpol) volpol=$2; shift 2 ;;
    --flair-reg) flair_reg=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

here=$(dirname "$(realpath "$0")")
# shellcheck disable=SC1091
source "${MINC_TOOLKIT_CONFIG:-/opt/minc-toolkit-2037a07/minc-toolkit-config.sh}"
ants_bin=${ANTS_BIN:-/opt/ANTs/bin}
py=("$work/venv/bin/python" -I)

out=$work/runs/$run/$sub
P=$out/preproc
mkdir -p "$P" "$out/tmp"
export TMPDIR=$out/tmp
# One thread everywhere: ITK (itk_resample, SimpleITK, DenoiseImage), BLAS and OpenMP.
export ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1

raw_t1=$work/data/$sub/${sub}_ses-01_rec-defaced_T1w.nii.gz
raw_flair=$work/data/$sub/${sub}_ses-01_rec-defaced_FLAIR.nii.gz
L8=$work/lib/L8
L9=$work/lib/L9
mask_tpl=$L9/Mask.mnc   # identical bytes to $L8/Mask.mnc (lib/MANIFEST.sha256)
av_t1=$L9/Av_T1.mnc     # identical bytes to $L8/Av_T1.mnc
av_flair=$L9/Av_FLAIR.mnc
id=$sub

# One line per invocation: a resumed run can add stages with the same settings.
printf '{"subject": "%s", "run": "%s", "stages": "%s", "denoise": "%s", "volpol": "%s", "flair_reg": "%s", "xfm": "%s", "host": "%s", "started": "%s", "minc_toolkit": "%s", "upstream": "%s"}\n' \
  "$sub" "$run" "$stages" "$denoise" "$volpol" "$flair_reg" "$xfm_choice" "$(hostname)" "$(date -u +%FT%TZ)" \
  "$MINC_TOOLKIT_VERSION" "$(tr '\n' ' ' < "$work/lib/UPSTREAM")" >> "$out/invocations.jsonl"

# step <name> <expected output> <command...>: run once, log the command and its wall time.
step() {
  local name=$1 target=$2
  shift 2
  if [[ -e $target ]]; then
    return 0
  fi
  printf '%s\t%q' "$name" "$1" >> "$out/commands.log"
  printf ' %q' "${@:2}" >> "$out/commands.log"
  printf '\n' >> "$out/commands.log"
  local t0 t1
  t0=$(date +%s.%N)
  "$@" > "$out/logs.$name.txt" 2>&1 || {
    echo "step $name failed, see $out/logs.$name.txt" >&2
    tail -20 "$out/logs.$name.txt" >&2
    exit 1
  }
  t1=$(date +%s.%N)
  printf '%s\t%.1f\n' "$name" "$(echo "$t1 - $t0" | bc)" >> "$out/timings.tsv"
  [[ -e $target ]] || { echo "step $name did not write $target" >&2; exit 1; }
}

# denoise <in.mnc> <out.mnc> <mask.mnc> <tag>
denoise() {
  local in=$1 dst=$2 msk=$3 tag=$4
  case $denoise in
    mincnlm)
      step "${tag}_nlm" "$dst" mincnlm -clobber -mt 1 "$in" "$dst" -beta 0.7 -clobber
      ;;
    ants-rician|ants-gaussian)
      # /opt/ANTs DenoiseImage cannot write MINC: round trip through NIfTI with the
      # same converters, then check the grid is unchanged (ants_denoise.sh).
      local model=Rician
      [[ $denoise == ants-gaussian ]] && model=Gaussian
      step "${tag}_denoise" "$dst" "$here/ants_denoise.sh" "$ants_bin" "$model" "$in" "$msk" "$dst"
      ;;
    *) echo "unknown denoiser $denoise" >&2; exit 2 ;;
  esac
}

has_stage() { [[ ,$stages, == *,$1,* ]]; }

# volpol_args <lin mask>: the volume_pol options for --volpol
volpol_args() {
  case $volpol in
    unmasked) echo --order 1 ;;
    masked-order1) echo --order 1 --source_mask "$1" --target_mask "$mask_tpl" ;;
    masked-order2) echo --order 2 --source_mask "$1" --target_mask "$mask_tpl" ;;
    *) echo "unknown --volpol $volpol" >&2; exit 2 ;;
  esac
}

if has_stage preproc; then
  # T1 -------------------------------------------------------------------------------
  step t1_nii2mnc "$P/${id}_T1.mnc" nii2mnc -clobber "$raw_t1" "$P/${id}_T1.mnc"
  step t1_bestlinreg "$P/${id}_T1toTemplate.xfm" \
    bestlinreg_s2 "$P/${id}_T1.mnc" "$av_t1" "$P/${id}_T1toTemplate.xfm"
  step t1_mask_lin "$P/${id}_T1_Mask.mnc" \
    mincresample "$mask_tpl" -transform "$P/${id}_T1toTemplate.xfm" "$P/${id}_T1_Mask.mnc" \
    -invert_transform -like "$P/${id}_T1.mnc" -nearest -clobber
  denoise "$P/${id}_T1.mnc" "$P/${id}_T1_NLM.mnc" "$P/${id}_T1_Mask.mnc" t1
  step t1_nu_correct "$P/${id}_T1_N3.mnc" \
    nu_correct "$P/${id}_T1_NLM.mnc" "$P/${id}_T1_N3.mnc" -mask "$P/${id}_T1_Mask.mnc" \
    -iter 200 -distance 50 -clobber
  # shellcheck disable=SC2046  # volpol_args is a word list
  step t1_volume_pol "$P/${id}_T1_VP.mnc" \
    volume_pol "$P/${id}_T1_N3.mnc" "$av_t1" $(volpol_args "$P/${id}_T1_Mask.mnc") --noclamp \
    --expfile "$P/${id}_T1_norm" --clobber "$P/${id}_T1_VP.mnc"
  step t1_bestlinreg_pp "$P/${id}_T1toTemplate_pp_lin.xfm" \
    bestlinreg_s2 "$P/${id}_T1_VP.mnc" "$av_t1" "$P/${id}_T1toTemplate_pp_lin.xfm"
  step t1_resample_lin "$P/${id}_T1_lin.mnc" \
    mincresample "$P/${id}_T1_VP.mnc" -transform "$P/${id}_T1toTemplate_pp_lin.xfm" \
    "$P/${id}_T1_lin.mnc" -like "$av_t1" -clobber
  step t1_nlfit "$P/${id}_T1toTemplate_pp_nlin.xfm" \
    nlfit_s "$P/${id}_T1_lin.mnc" "$av_t1" "$P/${id}_T1toTemplate_pp_nlin.xfm" -level 2 -clobber
  step t1_xfmconcat "$P/${id}_T1toTemplate_pp_both.xfm" \
    xfmconcat "$P/${id}_T1toTemplate_pp_lin.xfm" "$P/${id}_T1toTemplate_pp_nlin.xfm" \
    "$P/${id}_T1toTemplate_pp_both.xfm"
  step t1_xfminvert "$P/${id}_TemplatetoT1_pp_both.xfm" \
    xfminvert "$P/${id}_T1toTemplate_pp_both.xfm" "$P/${id}_TemplatetoT1_pp_both.xfm"
  step mask_nl "$P/${id}_Mask_nl.mnc" \
    mincresample "$mask_tpl" -transform "$P/${id}_T1toTemplate_pp_both.xfm" "$P/${id}_Mask_nl.mnc" \
    -like "$P/${id}_T1_VP.mnc" -invert_transformation -nearest -clobber

  # FLAIR ----------------------------------------------------------------------------
  step flair_nii2mnc "$P/${id}_FLAIR.mnc" nii2mnc -clobber "$raw_flair" "$P/${id}_FLAIR.mnc"
  case $flair_reg in
    minctracc)
      step flair_bestlinreg "$P/${id}_FLAIRtoT1.xfm" \
        bestlinreg_s2 -lsq6 "$P/${id}_FLAIR.mnc" "$P/${id}_T1.mnc" "$P/${id}_FLAIRtoT1.xfm" -mi -close
      ;;
    ants)
      step flair_ants_rigid "$P/${id}_FLAIRtoT1_0GenericAffine.mat" \
        "$ants_bin/antsRegistration" -d 3 --float 1 --random-seed 1 \
        -o "[$P/${id}_FLAIRtoT1_]" -r "[$raw_t1,$raw_flair,1]" -t 'Rigid[0.1]' \
        -m "MI[$raw_t1,$raw_flair,1,32,Regular,0.25]" -c '[1000x500x250x100,1e-6,10]' \
        -f 8x4x2x1 -s 3x2x1x0vox
      step flair_itk_to_xfm "$P/${id}_FLAIRtoT1.xfm" \
        "${py[@]}" "$here/itk_to_xfm.py" "$P/${id}_FLAIRtoT1_0GenericAffine.mat" "$P/${id}_FLAIRtoT1.xfm"
      ;;
    *) echo "unknown --flair-reg $flair_reg" >&2; exit 2 ;;
  esac
  # Upstream -d never writes _FLAIR_Mask.mnc: map the template mask through
  # FLAIR -> T1 -> template (linear) inverted, onto the FLAIR grid.
  step flair_xfmconcat "$P/${id}_FLAIRtoTemplate_lin.xfm" \
    xfmconcat "$P/${id}_FLAIRtoT1.xfm" "$P/${id}_T1toTemplate.xfm" "$P/${id}_FLAIRtoTemplate_lin.xfm"
  step flair_mask_lin "$P/${id}_FLAIR_Mask.mnc" \
    mincresample "$mask_tpl" -transform "$P/${id}_FLAIRtoTemplate_lin.xfm" "$P/${id}_FLAIR_Mask.mnc" \
    -invert_transform -like "$P/${id}_FLAIR.mnc" -nearest -clobber
  denoise "$P/${id}_FLAIR.mnc" "$P/${id}_FLAIR_NLM.mnc" "$P/${id}_FLAIR_Mask.mnc" flair
  step flair_nu_correct "$P/${id}_FLAIR_N3.mnc" \
    nu_correct "$P/${id}_FLAIR_NLM.mnc" "$P/${id}_FLAIR_N3.mnc" -mask "$P/${id}_FLAIR_Mask.mnc" \
    -iter 200 -distance 50 -clobber
  # shellcheck disable=SC2046
  step flair_volume_pol "$P/${id}_FLAIR_VP.mnc" \
    volume_pol "$P/${id}_FLAIR_N3.mnc" "$av_flair" $(volpol_args "$P/${id}_FLAIR_Mask.mnc") --noclamp \
    --expfile "$P/${id}_FLAIR_norm" --clobber "$P/${id}_FLAIR_VP.mnc"
  # volume_pol keeps the FLAIR grid, so FLAIRtoT1 (raw FLAIR -> raw T1) still holds;
  # T1_VP has the raw T1 grid.
  step flair_resample "$P/${id}_FLAIR_CR.mnc" \
    mincresample "$P/${id}_FLAIR_VP.mnc" -transform "$P/${id}_FLAIRtoT1.xfm" \
    "$P/${id}_FLAIR_CR.mnc" -like "$P/${id}_T1_VP.mnc" -clobber
fi

case $xfm_choice in
  forward) xfm=$P/${id}_T1toTemplate_pp_both.xfm ;;
  inverse) xfm=$P/${id}_TemplatetoT1_pp_both.xfm ;;
  *) echo "unknown --xfm $xfm_choice" >&2; exit 2 ;;
esac

if has_stage geometry; then
  G=$out/geometry
  mkdir -p "$G"
  for cand in forward inverse; do
    case $cand in
      forward) cx=$P/${id}_T1toTemplate_pp_both.xfm ;;
      inverse) cx=$P/${id}_TemplatetoT1_pp_both.xfm ;;
    esac
    step "geom_mask_$cand" "$G/mask_$cand.mnc" \
      itk_resample "$mask_tpl" --like "$P/${id}_T1_VP.mnc" --transform "$cx" --labels "$G/mask_$cand.mnc" --clobber
    step "geom_sp1_$cand" "$G/sp1_$cand.mnc" \
      itk_resample "$L8/SP_1.mnc" --like "$P/${id}_T1_VP.mnc" --transform "$cx" "$G/sp1_$cand.mnc" --clobber
  done
  step geom_check "$G/geometry.json" "${py[@]}" "$here/geometry_check.py" \
    --t1 "$P/${id}_T1_VP.mnc" --mask-nl "$P/${id}_Mask_nl.mnc" --mask-lin "$P/${id}_T1_Mask.mnc" \
    --geometry-dir "$G" --out "$G/geometry.json"
  for cand in forward inverse; do
    step "geom_qc_$cand" "$G/sp1_$cand.jpg" \
      minc_qc.pl "$P/${id}_T1_VP.mnc" --mask "$G/sp1_$cand.mnc" "$G/sp1_$cand.jpg" --big --clobber \
      --image-range 0 200 --mask-range 0 1
  done
fi

# bison_mode <dir name> <script> <lib> <labels> <with flair>
bison_mode() {
  local name=$1 script=$2 lib=$3 nlab=$4 flair=$5
  local M=$out/$name
  mkdir -p "$M/out" "$M/tmp" "$M/warped"
  if [[ $flair == yes ]]; then
    printf 'Subjects,T1s,Masks,XFMs,FLAIRs\n%s,%s,%s,%s,%s\n' "$id" "$P/${id}_T1_VP.mnc" \
      "$P/${id}_Mask_nl.mnc" "$xfm" "$P/${id}_FLAIR_CR.mnc" > "$M/list.csv"
  else
    printf 'Subjects,T1s,Masks,XFMs\n%s,%s,%s,%s\n' "$id" "$P/${id}_T1_VP.mnc" \
      "$P/${id}_Mask_nl.mnc" "$xfm" > "$M/list.csv"
  fi
  step "${name}_bison" "$M/out/RF0_${id}_Label.mnc" \
    "${py[@]}" "$work/scripts/$script" -c RF0 -m "$lib" -p "$lib" -e PT -l "$nlab" \
    -n "$M/list.csv" -t "$M/tmp/" -o "$M/out" -j 1 --nifti
  # -t gets a random prefix (<dir><rand>_BISON_); copy to stable names.
  local f base
  for f in "$M"/tmp/*_BISON_test_0_0_*.mnc; do
    [[ -e $f ]] || continue
    base=${f##*_BISON_test_0_0_}
    [[ -e $M/warped/$base ]] || cp "$f" "$M/warped/$base"
  done
}

if has_stage bison; then
  bison_mode t1 BISON_L8.py "$L8" 8 no
  bison_mode t1-flair BISON_L9.py "$L9" 9 yes
fi

if has_stage export; then
  for mode in t1 t1-flair; do
    M=$out/$mode
    lib=$L8; nlab=8; extra=()
    if [[ $mode == t1-flair ]]; then
      lib=$L9; nlab=9
      extra=(--flair "$P/${id}_FLAIR_CR.mnc")
    fi
    step "${mode}_export" "$M/export/done" "${py[@]}" "$here/bison_export.py" \
      --lib "$lib" --labels "$nlab" --t1 "$P/${id}_T1_VP.mnc" --mask "$P/${id}_Mask_nl.mnc" \
      --warped "$M/warped" --label-mnc "$M/out/RF0_${id}_Label.mnc" --raw-t1 "$raw_t1" \
      --raw-t1-mnc "$P/${id}_T1.mnc" --preproc "$P" --id "$id" --out "$M/export" "${extra[@]}"
  done
fi

echo "done: $out"
