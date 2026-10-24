#!/usr/bin/env bash
# Stage the BISON pretrained libraries, the unmodified upstream scripts and the
# Python environment for the native MINC reference.
#
# Usage: setup_native.sh <work-dir> <BISON checkout> <BISON-WMH checkout>
#
# <work-dir>/lib/L8      Pretrained_Library contents + Av_T1.mnc (BISON 94dd5f8)
# <work-dir>/lib/L9      BISON-WMH root assets + unzipped RF0 classifier (ee973df)
# <work-dir>/scripts     BISON_L8.py and BISON_L9.py, copied byte for byte
# <work-dir>/venv        Python 3.10, pinned by requirements.txt
set -euo pipefail

work=$(realpath -m "$1")
bison=$(realpath "$2")
wmh=$(realpath "$3")
here=$(dirname "$(realpath "$0")")
uv=${UV:-$HOME/.local/bin/uv}

expect_bison=94dd5f81ad1f0956dc9492195bae050b45a2c6dd
expect_wmh=ee973dfefd017edbab3f20a8206cbce0e9d060c2
got_bison=$(git -C "$bison" rev-parse HEAD)
got_wmh=$(git -C "$wmh" rev-parse HEAD)
if [[ $got_bison != "$expect_bison" || $got_wmh != "$expect_wmh" ]]; then
  echo "unexpected upstream commits: BISON $got_bison, BISON-WMH $got_wmh" >&2
  exit 1
fi
if [[ -n $(git -C "$bison" status --porcelain) || -n $(git -C "$wmh" status --porcelain) ]]; then
  echo "upstream checkouts have local changes" >&2
  exit 1
fi

mkdir -p "$work/lib/L8" "$work/lib/L9" "$work/scripts"

# L8 (T1 only, 8 classes): Pretrained_Library has no Av_T1.mnc; the repository root has it.
unzip -o -j -q "$bison/Pretrained_Library.zip" 'Pretrained_Library/*' -d "$work/lib/L8"
cp "$bison/Av_T1.mnc" "$work/lib/L8/"

# L9 (T1 + FLAIR, 9 classes): assets sit at the BISON-WMH repository root.
for f in Av_T1.mnc Av_FLAIR.mnc Mask.mnc T1_Label.pkl FLAIR_Label.pkl SP_{1..9}.mnc; do
  cp "$wmh/$f" "$work/lib/L9/"
done
unzip -o -q "$wmh/RF0_T1exists_T2_PD_FLAIRexists.pkl.zip" -d "$work/lib/L9"

cp "$bison/BISON_L8.py" "$wmh/BISON_L9.py" "$work/scripts/"
cmp "$bison/BISON_L8.py" "$work/scripts/BISON_L8.py"
cmp "$wmh/BISON_L9.py" "$work/scripts/BISON_L9.py"

{
  echo "BISON $got_bison"
  echo "BISON-WMH $got_wmh"
} > "$work/lib/UPSTREAM"
(cd "$work" && sha256sum lib/L8/* lib/L9/* scripts/*) > "$work/lib/MANIFEST.sha256"

if [[ ! -x $work/venv/bin/python ]]; then
  "$uv" venv -q --python 3.10 "$work/venv"
fi
VIRTUAL_ENV="$work/venv" "$uv" pip install -q -r "$here/requirements.txt"
VIRTUAL_ENV="$work/venv" "$uv" pip freeze > "$work/venv-freeze.txt"
cat "$work/lib/MANIFEST.sha256"
