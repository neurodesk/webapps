#!/bin/bash
set -euo pipefail

[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Apple ARM macOS is required' >&2; exit 2; }
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$root/apps/greedy/package.json').version")
identity=${MACOS_SIGN_IDENTITY:--}
installer_identity=${MACOS_INSTALLER_IDENTITY:-}
suffix=-adhoc
if [[ "$identity" != - ]]; then
    : "${installer_identity:?Set MACOS_INSTALLER_IDENTITY}"
    : "${EXPECTED_TEAM_ID:?Set EXPECTED_TEAM_ID}"
    : "${NOTARY_PROFILE:?Set NOTARY_PROFILE}"
    suffix=
fi
work=$(mktemp -d "${TMPDIR:?}/greedy-pkg.XXXXXX")
trap 'rm -rf "$work"' EXIT
exe="$work/root/usr/local/bin/greedy-rs"
mkdir -p "$(dirname "$exe")" "$root/exes/greedy/dist"
cp "$root/exes/greedy/target/release/greedy-rs" "$exe"
chmod 755 "$exe"
foreign=$(otool -L "$exe" | tail -n +2 | awk '{print $1}' | grep -v '^/usr/lib/' | grep -v '^/System/' || true)
[[ -z "$foreign" ]] || { echo "Non-system dependencies: $foreign" >&2; exit 1; }
if [[ "$identity" == - ]]; then
    codesign --force --sign - "$exe"
else
    codesign --force --options runtime --timestamp --sign "$identity" "$exe"
fi
codesign --verify --strict "$exe"
if [[ "$identity" != - ]]; then
    codesign -dv --verbose=4 "$exe" 2>&1 | grep -Fx "TeamIdentifier=$EXPECTED_TEAM_ID"
fi
mkdir -p "$work/root/usr/local/share/greedy-rs"
cp "$root/exes/greedy/README.md" "$root/exes/greedy/LICENSE" "$root/exes/greedy/NOTICE" "$root/exes/greedy/THIRD_PARTY_NOTICES.md" "$work/root/usr/local/share/greedy-rs/"
pkg="$root/exes/greedy/dist/greedy-$version-macos-arm64$suffix.pkg"
pkgbuild --root "$work/root" --identifier org.neurodesk.greedy-rs --version "$version" --install-location / "$work/component.pkg"
if [[ "$identity" == - ]]; then
    productbuild --package "$work/component.pkg" "$pkg"
else
    productbuild --package "$work/component.pkg" --sign "$installer_identity" "$pkg"
    pkgutil --check-signature "$pkg" | grep -F "($EXPECTED_TEAM_ID)"
    xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$pkg"
    xcrun stapler validate "$pkg"
    spctl --assess --type install --verbose=4 "$pkg"
fi
pkgutil --expand-full "$pkg" "$work/expanded"
extracted=$(find "$work/expanded" -type f -path '*/usr/local/bin/greedy-rs' -print -quit)
[[ -n "$extracted" ]]
codesign --verify --strict "$extracted"
python3 "$root/scripts/package-greedy.py" verify "$extracted" > "$pkg.validation.txt"
(cd "$(dirname "$pkg")" && shasum -a 256 "$(basename "$pkg")") > "$pkg.sha256"
if [[ "$identity" != - ]]; then
    pkgutil --check-signature "$pkg" >> "$pkg.validation.txt"
    xcrun stapler validate "$pkg" >> "$pkg.validation.txt" 2>&1
fi
# The digest of the stapled package; the Standalone catalog accepts a receipt only when it records it.
printf 'sha256: %s\n' "$(cat "$pkg.sha256")" >> "$pkg.validation.txt"

if [[ "$identity" != - ]]; then
    mkdir -p "$root/packages/greedy/native/macos-arm64"
    cp "$extracted" "$root/packages/greedy/native/macos-arm64/greedy-rs"
fi
