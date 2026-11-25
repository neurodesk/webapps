MACOS_SIGN_IDENTITY ?= $(shell security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
MACOS_INSTALLER_IDENTITY ?= $(shell security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)

.PHONY: macos-release
macos-release:
	@test -n "$(MACOS_SIGN_IDENTITY)" && test -n "$(MACOS_INSTALLER_IDENTITY)"
	MACOS_SIGN_IDENTITY="$(MACOS_SIGN_IDENTITY)" MACOS_INSTALLER_IDENTITY="$(MACOS_INSTALLER_IDENTITY)" NOTARY_PROFILE="$(NOTARY_PROFILE)" python3 ../../scripts/package-syncro.py package macos-arm64
