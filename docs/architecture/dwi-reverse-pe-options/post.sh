#!/usr/bin/env bash
# Score every finished method of one subject.
# Usage: post.sh <subject> <method>...
# Needs topup to have run. Writes runs/<subject>/<method>/metrics.json with the
# BBR cost added, and runs/<subject>/summary.json.
set -euo pipefail
source "$(dirname "$0")/common.sh"
sub=$1
shift
run=$ROOT/runs/$sub
cd "$run"

if [[ ! -d topup ]]; then
  echo "Reference method topup is missing for $sub" >&2
  exit 1
fi

if [[ ! -f calibration.json ]]; then
  (cd "$SCRIPTS" && py calibrate.py "$run")
fi

# One brain mask for every method: MindGrab on topup's corrected mean b0.
if [[ ! -f mask/b0_mask.nii.gz ]]; then
  mkdir -p mask
  fsl fslmaths topup/topup_iout -Tmean mask/topup_corrected_mean
  mindgrab_mask mask/topup_corrected_mean.nii.gz mask/b0_mask.nii.gz
fi

# One start for every BBR fit: topup's corrected mean b0 to the T1w brain.
if [[ ! -f mask/b0_to_t1w_init.mat ]]; then
  fsl flirt -in mask/topup_corrected_mean -ref prep/t1w_brain -dof 6 -omat mask/b0_to_t1w_init.mat
fi

for method in topup "$@"; do
  [[ -d $method ]] || continue
  if ! (cd "$SCRIPTS" && py fields.py "$run" "$method" && py evaluate.py "$run" "$method" > /dev/null); then
    rm -f "$method/metrics.json"
    if [[ $method == topup ]]; then
      echo "Reference method topup failed for $sub" >&2
      exit 1
    fi
    echo "Skipping failed method $method for $sub" >&2
    continue
  fi
  fsl flirt -in "$method/corrected_mean" -ref prep/t1w -dof 6 -cost bbr -wmseg prep/t1w_wmseg \
    -init mask/b0_to_t1w_init.mat -omat "$method/bbr.mat" -schedule /opt/fsl-6.0.7.23/etc/flirtsch/bbr.sch > /dev/null
  cost=$(fsl flirt -in "$method/corrected_mean" -ref prep/t1w -cost bbr -wmseg prep/t1w_wmseg \
    -init "$method/bbr.mat" -schedule /opt/fsl-6.0.7.23/etc/flirtsch/measurecost1.sch | awk 'NR == 1 {print $1}')
  (cd "$SCRIPTS" && py -c "
import json, re, sys
p = '$run/$method/metrics.json'
m = json.load(open(p))
m['bbr_cost'] = float('$cost')
log = open('$run/$method/time.log').read() if __import__('os').path.exists('$run/$method/time.log') else ''
w = re.search(r'Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (\S+)', log)
r = re.search(r'Maximum resident set size \(kbytes\): (\d+)', log)
if w:
    parts = [float(x) for x in w.group(1).split(':')]
    m['wall_s'] = sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
if r:
    m['peak_rss_mb'] = int(r.group(1)) / 1024
json.dump(m, open(p, 'w'), indent=2)
")
done

(cd "$SCRIPTS" && py -c "
import glob, json
rows = [json.load(open(p)) for p in sorted(glob.glob('$run/*/metrics.json'))]
json.dump(rows, open('$run/summary.json', 'w'), indent=2)
for m in rows:
    print(m['method'].ljust(16), *(f'{k}={m.get(k, float(\"nan\")):.4g}' for k in ('appa_mad', 'appa_mad_nojac', 'appa_1mncc', 'bbr_cost', 'field_vs_topup_mad_hz', 'field_vs_topup_mad_demeaned_hz', 'field_vs_topup_r', 'field_vs_gre_mad_hz', 'field_vs_gre_mad_demeaned_hz', 'wall_s', 'peak_rss_mb')))
")
