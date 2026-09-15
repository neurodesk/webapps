#!/bin/sh
set -eu
# Apptainer supplies its own user namespace; Chromium's setuid helper is not
# usable inside it. Keep this container unprivileged and bind only needed data.
unset ELECTRON_RUN_AS_NODE
if [ -z "${DISPLAY:-}" ]; then
  exec xvfb-run -a /opt/neurodesk/neurodesk-webapps --no-sandbox "$@"
fi
exec /opt/neurodesk/neurodesk-webapps --no-sandbox "$@"
