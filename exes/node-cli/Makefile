# node-cli: the macOS installer of a portable Node command line.
# PACKAGE names the package directory from the repository root, for example
# PACKAGE=packages/topofit. Signing and notarization reuse SynthSR's release
# scripts: exes/synthsr/scripts/ci_macos_release.sh exes/node-cli runs
# macos-release with the CI identities.
PACKAGE ?=
TARGET = macos-arm64
# Default to the Developer ID certificates in the Keychain (first match of each kind).
MACOS_SIGN_IDENTITY ?= $(shell security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
MACOS_INSTALLER_IDENTITY ?= $(shell security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)
NOTARY_PROFILE ?= node-cli-notary
RELEASE = python3 $(CURDIR)/scripts/portable_release.py
SIGNED = env MACOS_SIGN_IDENTITY="$(MACOS_SIGN_IDENTITY)" MACOS_INSTALLER_IDENTITY="$(MACOS_INSTALLER_IDENTITY)"
SYNTHSR_SCRIPTS = $(CURDIR)/../synthsr/scripts
DIST = $(CURDIR)/dist

.PHONY: help check-package macos-pkg-adhoc macos-verify-adhoc macos-pkg macos-notary-profile \
	check-notary-profile macos-notarize macos-verify macos-release

help:
	@echo "macos-pkg-adhoc        unsigned dist/*-adhoc.pkg for local testing"
	@echo "macos-verify-adhoc     install the ad hoc package and run its validation"
	@echo "macos-pkg              signed .pkg (MACOS_SIGN_IDENTITY, MACOS_INSTALLER_IDENTITY)"
	@echo "macos-notary-profile   store notarytool credentials (APPLE_ID, TEAM_ID)"
	@echo "macos-notarize         notarize + staple + validate the signed .pkg"
	@echo "macos-verify           install the signed .pkg and run its validation"
	@echo "macos-release          check-notary-profile, macos-pkg, macos-notarize, macos-verify"

check-package:
	@test -n "$(PACKAGE)" || { echo "Set PACKAGE to a package directory, for example PACKAGE=packages/topofit." >&2; exit 2; }

macos-pkg-adhoc: check-package
	env MACOS_SIGN_IDENTITY=- MACOS_INSTALLER_IDENTITY= $(RELEASE) package "$(PACKAGE)" $(TARGET)

macos-verify-adhoc: check-package
	env MACOS_SIGN_IDENTITY=- MACOS_INSTALLER_IDENTITY= $(RELEASE) verify "$(PACKAGE)" $(TARGET)

macos-pkg: check-package
	@test -n "$(MACOS_SIGN_IDENTITY)" || { echo "Set MACOS_SIGN_IDENTITY to a Developer ID Application identity or SHA-1." >&2; exit 2; }
	@test -n "$(MACOS_INSTALLER_IDENTITY)" || { echo "Set MACOS_INSTALLER_IDENTITY to a Developer ID Installer identity or SHA-1 (security find-identity -v)." >&2; exit 2; }
	$(SIGNED) $(RELEASE) package "$(PACKAGE)" $(TARGET)

# Notarized from dist/ so the .sha256 file names the package without a directory.
macos-notarize: check-package
	cd "$(DIST)" && $(SIGNED) PACKAGE="$(PACKAGE)" VERIFY_MACOS_PKG="$(CURDIR)/scripts/verify_macos_pkg.sh" \
		"$(SYNTHSR_SCRIPTS)/notarize_macos.sh" "$$($(SIGNED) $(RELEASE) artifact "$(PACKAGE)" $(TARGET))" "$(NOTARY_PROFILE)"

macos-verify: check-package
	$(SIGNED) $(RELEASE) verify "$(PACKAGE)" $(TARGET)

macos-notary-profile:
	@test -n "$(APPLE_ID)" || { echo "Set APPLE_ID to your Developer Apple ID." >&2; exit 2; }
	@test -n "$(TEAM_ID)" || { echo "Set TEAM_ID to your 10-character Developer Team ID." >&2; exit 2; }
	"$(SYNTHSR_SCRIPTS)/store_notary_credentials.sh" "$(NOTARY_PROFILE)" "$(APPLE_ID)" "$(TEAM_ID)"

# Credentials are checked first so a missing profile fails before the build, not after it.
macos-release:
	+$(MAKE) check-notary-profile
	+$(MAKE) macos-pkg
	+$(MAKE) macos-notarize
	+$(MAKE) macos-verify

check-notary-profile:
	@xcrun notarytool history --keychain-profile "$(NOTARY_PROFILE)" >/dev/null 2>&1 || { \
		echo "No notarization credentials for profile '$(NOTARY_PROFILE)'. Store them once with:" >&2; \
		echo "  make macos-notary-profile APPLE_ID='you@example.com' TEAM_ID='ABCDE12345'" >&2; \
		echo "(prompts for an app-specific password from appleid.apple.com, not your Apple ID password)" >&2; \
		exit 2; }
	@echo "notarization credentials found for profile '$(NOTARY_PROFILE)'"
