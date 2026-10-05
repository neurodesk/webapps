#!/bin/sh
# Payload verifier for exes/synthsr/scripts/notarize_macos.sh (VERIFY_MACOS_PKG).
#
#   PACKAGE=packages/topofit verify_macos_pkg.sh FILE.pkg
set -eu
exec python3 "$(dirname -- "$0")/portable_release.py" check-pkg "${PACKAGE:?set PACKAGE to the package directory}" "$1"
