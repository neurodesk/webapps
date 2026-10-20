#!/usr/bin/env bash
# Fetch the evaluation inputs from OpenNeuro at pinned tags.
# The git tree at each tag pins every annexed file by its SHA256E or MD5E key.
# The bytes come from the public OpenNeuro bucket and must match that key.
# Usage: fetch.sh <work-dir>
set -euo pipefail
work=${1:?work dir}
mkdir -p "$work/bids"
cd "$work/bids"

clone() {
  local ds=$1 tag=$2 sha=$3
  [[ -d $ds ]] || git clone -q "https://github.com/OpenNeuroDatasets/$ds.git" "$ds"
  git -C "$ds" checkout -q "$tag"
  [[ $(git -C "$ds" rev-parse HEAD) == "$sha" ]] || { echo "$ds: $tag is not $sha" >&2; exit 1; }
}

# get <dataset> <path>: replace the annex symlink with verified bytes.
get() {
  local ds=$1 path=$2 key want got sum
  [[ -L $ds/$path ]] || return 0
  key=$(basename "$(readlink "$ds/$path")")
  want=${key#*--}
  want=${want%%.*}
  case $key in
    SHA256E-*) sum=sha256sum ;;
    MD5E-*) sum=md5sum ;;
    *) echo "$ds/$path: unknown annex key $key" >&2; exit 1 ;;
  esac
  aws s3 cp --quiet --no-sign-request "s3://openneuro.org/$ds/$path" "$ds/$path.part"
  got=$($sum "$ds/$path.part" | cut -d' ' -f1)
  [[ $got == "$want" ]] || { echo "$ds/$path: $sum $got, expected $want" >&2; exit 1; }
  mv -f "$ds/$path.part" "$ds/$path"
}

clone ds005134 1.0.0 34e971d327602b5c55db4a3474321677337195ab
clone ds004146 1.0.4 a0844ee37c25e691c870417830bb6290d4e05533

for f in dwi/sub-01_dir-AP_run-001_dwi.nii.gz \
         fmap/sub-01_dir-PA_run-001_epi.nii.gz \
         fmap/sub-01_run-001_magnitude1.nii.gz \
         fmap/sub-01_run-001_magnitude2.nii.gz \
         fmap/sub-01_run-001_phasediff.nii.gz \
         anat/sub-01_run-001_T1w.nii.gz; do
  get ds005134 "sub-01/$f"
done

for s in 0001 0002 0003 0004 0005; do
  for f in dwi/sub-${s}_ses-01_dir-AP_run-01_dwi.nii.gz \
           dwi/sub-${s}_ses-01_dir-PA_run-01_dwi.nii.gz \
           anat/sub-${s}_ses-01_UNIT1_denoised.nii.gz; do
    get ds004146 "sub-$s/ses-01/$f"
  done
done
echo fetched
