#!/bin/sh
# Pin models/disconnectome.manifest.json to a dataset revision.
#   repoint_manifest.sh              # use the current head of neurodeskorg/webapps
#   repoint_manifest.sh <40-hex sha> # pin an explicit revision
set -eu
rev=${1:-}
if [ -z "$rev" ]; then
  rev=$(curl -fsSL https://huggingface.co/api/datasets/neurodeskorg/webapps \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
  echo "head of neurodeskorg/webapps is $rev"
fi
case "$rev" in *[!0-9a-fA-F]*|'') echo "Revision must be 40 hexadecimal characters" >&2; exit 2 ;; esac
[ "${#rev}" -eq 40 ] || { echo "Revision must be 40 hexadecimal characters" >&2; exit 2; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
python3 - "$root/models/disconnectome.manifest.json" "$rev" <<'PY'
import json, sys
path, rev = sys.argv[1], sys.argv[2]
m = json.load(open(path))
m['revision'] = rev
m['base_url'] = f'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/{rev}/disconnectome/'
json.dump(m, open(path, 'w'), indent=2); open(path, 'a').write('\n')
PY
echo "pinned models/disconnectome.manifest.json to $rev"
