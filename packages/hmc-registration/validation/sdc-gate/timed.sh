#!/usr/bin/env bash
# timed.sh TOOL COMMAND... -- ARGV... : run COMMAND ARGV under /usr/bin/time -v and append one
# JSON line (tool, command, cwd, argv, wall s, max RSS kB, exit status) to $SDC_TIMELOG, as the
# reference's scripts/ants-wrapper.sh records the native runs. stdout and stderr pass through.
tool=$1
shift
command=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done
shift
log=$(mktemp "${TMPDIR:-/var/tmp}/anttime.XXXXXX")
/usr/bin/time -v -o "$log" "${command[@]}" "$@"
status=$?
if [ -n "${SDC_TIMELOG:-}" ]; then
  python3 -I - "$log" "$tool" "$status" "$PWD" "${command[*]}" "$@" >> "$SDC_TIMELOG" <<'EOF'
import json
import sys

log, tool, status, cwd, command, *argv = sys.argv[1:]
wall = rss = None
for line in open(log):
    line = line.strip()
    if line.startswith("Elapsed (wall clock) time"):
        parts = line.rsplit(" ", 1)[1].split(":")
        wall = sum(float(p) * 60**i for i, p in enumerate(reversed(parts)))
    elif line.startswith("Maximum resident set size"):
        rss = int(line.rsplit(" ", 1)[1])
print(json.dumps({"tool": tool, "command": command, "cwd": cwd, "argv": argv, "wall_s": wall, "max_rss_kb": rss, "exit": int(status)}))
EOF
fi
rm -f "$log"
exit $status
