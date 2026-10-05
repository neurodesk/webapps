#!/bin/sh
# Notarize, staple and validate a signed installer package.
#
#   notarize_macos.sh FILE.pkg [KEYCHAIN_PROFILE]
#
# VERIFY_MACOS_PKG names the payload verifier, run as VERIFIER FILE.pkg; it defaults to
# this directory's verify_macos_pkg.sh. exes/node-cli supplies its own.
set -eu
set -o pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
verify=${VERIFY_MACOS_PKG:-$root/scripts/verify_macos_pkg.sh}
pkg=${1:?usage: notarize_macos.sh FILE.pkg [KEYCHAIN_PROFILE]}
profile=${2:-synthsr-notary}
: "${EXPECTED_TEAM_ID:?set EXPECTED_TEAM_ID to the release signing team}"
[ -f "$pkg" ] || { echo "notarize_macos.sh: file not found: $pkg" >&2; exit 2; }
# pkgutil exits successfully for an unsigned package, so inspect its status too.
signature=$(pkgutil --check-signature "$pkg" 2>&1) || {
	echo "$signature" >&2; exit 2; }
case "$signature" in
*"Status: signed by a developer certificate"*) ;;
*) echo "notarize_macos.sh: $pkg is unsigned or invalid. Set MACOS_INSTALLER_IDENTITY and run 'make macos-pkg'." >&2; exit 2;;
esac
xcrun notarytool submit "$pkg" --keychain-profile "$profile" --wait
xcrun stapler staple "$pkg"
# Every validation below must pass (set -e); its output is kept beside the artifact as release evidence.
log="$pkg.validation.txt"
{
	date -u +"%Y-%m-%dT%H:%M:%SZ notarize_macos.sh $pkg"
	xcrun stapler validate "$pkg"
	pkgutil --check-signature "$pkg"
	"$verify" "$pkg"
	# Installer packages are assessed under the "install" policy; "open" is for applications.
	spctl --assess --type install --verbose=4 "$pkg" 2>&1
	shasum -a 256 "$pkg" | tee "$pkg.sha256"
} | tee "$log"
echo "Notarized, stapled and Gatekeeper-validated $pkg (evidence: $log)"
