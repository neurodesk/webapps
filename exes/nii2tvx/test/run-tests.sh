#!/bin/sh
# Round trip on the committed fixtures: TRK -> TVX -> pack -> query, compared with
# test/expected.tsv. The fixtures are a 20 mm template and four bundles chosen so the query
# returns a full hit, a fraction, a miss and an empty tract (nan), rather than only the 0 and
# 1 a simpler fixture would give.
#
# The WASM module goes through the same comparison whenever node and a built nii2tvx.mjs are
# present, so the two engines cannot drift apart silently.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
bin=$root/nii2tvx
[ -x "$bin" ] || { echo "build first: make" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here"/fixtures/* "$work"/            # conversion writes each .tvx beside its input
cd "$work"

# 1. TRK -> TVX on the template grid, then pack them into one atlas.
"$bin" template.nii.gz all_hit.trk some_hit.trk none_hit.trk outside.trk >/dev/null
"$bin" -p atlas.tvx all_hit.tvx some_hit.tvx none_hit.tvx outside.tvx >/dev/null

# 2. Query the packed atlas with both lesions.
"$bin" lesion.nii.gz lesion_empty.nii.gz atlas.tvx > packed.tsv
diff -u "$here/expected.tsv" packed.tsv || { echo "packed atlas query differs" >&2; exit 1; }

# 3. The same query against the unpacked per-tract files must agree column for column.
"$bin" lesion.nii.gz lesion_empty.nii.gz all_hit.tvx some_hit.tvx none_hit.tvx outside.tvx > loose.tsv
diff -u packed.tsv loose.tsv || { echo "packed and per-tract queries differ" >&2; exit 1; }

# 4. A lesion on a different grid must be refused, not silently answered.
if "$bin" wrong_grid.nii.gz atlas.tvx >/dev/null 2>&1; then
  echo "a lesion on a different grid was accepted" >&2; exit 1
fi

# 5. WASM parity, when the module is built.
if [ -f "$root/nii2tvx.mjs" ] && command -v node >/dev/null 2>&1; then
  node "$root/wasm_demo.mjs" lesion.nii.gz atlas.tvx > wasm.tsv
  "$bin" lesion.nii.gz atlas.tvx > native.tsv
  diff -u native.tsv wasm.tsv || { echo "WASM and native disagree" >&2; exit 1; }
  echo "ok: fixtures, packed vs per-tract, grid refusal, WASM parity"
else
  echo "ok: fixtures, packed vs per-tract, grid refusal (WASM skipped: run make wasm)"
fi
