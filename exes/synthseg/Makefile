# synthseg: build, test and package the native SynthSeg 2.0 executable.
# `make help` lists targets. Release signing needs two Developer ID identities;
# notarization credentials live only in Keychain (make macos-notary-profile).
VERSION ?= $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml)
MACOS_SIGN_IDENTITY ?= $(shell security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
MACOS_INSTALLER_IDENTITY ?= $(shell security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)
NOTARY_PROFILE ?= synthseg-notary
SYNTHSEG_REFERENCE_DIR ?= $(HOME)/src/synthseg-references
FS_MODEL ?= /Applications/freesurfer/8.1.0/models/synthseg_2.0.h5
MANIFEST = ../../packages/synthseg/model.manifest.json
GRAPH = ../../packages/synthseg/src/gpu-model.json
MODEL = models/synthseg-2.0.onnx
BIN = target/release/synthseg
MACOS_PKG = dist/synthseg-$(VERSION)-macos-arm64.pkg
VALIDATION = T1_head T1_head_2mm T1_head_default T1_head_fast T1_head_2mm_default T1_head_2mm_fast
VALIDATION_FILES = $(addprefix $(SYNTHSEG_REFERENCE_DIR)/,$(addsuffix .nii.gz,$(VALIDATION)))
manifest_url = $$(python3 -c 'import json;m=json.load(open("$(MANIFEST)"));print(m$(1))')

.PHONY: help export check-model fetch-validation build test test-real test-keras references fmt lint clean \
	macos-pkg-adhoc macos-pkg macos-notary-profile check-notary-profile macos-notarize macos-release

help:
	@echo "check-model            download (if missing) and verify the pinned ONNX model"
	@echo "fetch-validation       download benchmark inputs and FreeSurfer goldens to SYNTHSEG_REFERENCE_DIR"
	@echo "export                 FreeSurfer synthseg_2.0.h5 -> $(MODEL) + $(GRAPH) (python3 + h5py + onnx)"
	@echo "build                  release build -> $(BIN)"
	@echo "test                   fixture parity, CLI behaviour, self-check"
	@echo "test-real              benchmark volumes vs goldens in SYNTHSEG_REFERENCE_DIR -> validation/report.json"
	@echo "test-keras             preprocessing vs the Keras dump in SYNTHSEG_REFERENCE_DIR/keras"
	@echo "references             regenerate FreeSurfer goldens and Keras dumps (needs the fs environment)"
	@echo "fmt / lint             cargo fmt --check / cargo clippy"
	@echo "macos-pkg-adhoc        unsigned dist/*-adhoc.pkg for local testing"
	@echo "macos-pkg              signed .pkg (MACOS_SIGN_IDENTITY, MACOS_INSTALLER_IDENTITY)"
	@echo "macos-notary-profile   store notarytool credentials (APPLE_ID, TEAM_ID)"
	@echo "macos-notarize         notarize + staple + validate $(MACOS_PKG)"
	@echo "macos-release          check-notary-profile, test, test-real, macos-pkg, macos-notarize"

export:
	python3 scripts/export_model.py $(FS_MODEL)

# ponytail: the URL is revision-pinned on Hugging Face, so a fetch is reproducible; build.rs re-verifies.
check-model: $(MODEL)
	@printf '%s  %s\n' "$(call manifest_url,["assets"][0]["sha256"])" "$(MODEL)" | shasum -a 256 -c
$(MODEL):
	mkdir -p models
	curl -fL --retry 3 -o "$@.partial" "$(call manifest_url,["base_url"]+m["assets"][0]["filename"])"
	mv "$@.partial" "$@"

fetch-validation: $(VALIDATION_FILES)
	@python3 -c 'import hashlib, json, sys; m = json.load(open("$(MANIFEST)"))["validation"]["sha256"]; bad = [f for f, h in m.items() if hashlib.sha256(open(sys.argv[1] + "/" + f, "rb").read()).hexdigest() != h]; sys.exit("checksum mismatch, delete and refetch: " + ", ".join(bad) if bad else 0)' "$(SYNTHSEG_REFERENCE_DIR)"
$(SYNTHSEG_REFERENCE_DIR)/%.nii.gz:
	mkdir -p "$(SYNTHSEG_REFERENCE_DIR)"
	curl -fL --retry 3 -o "$@.partial" "$(call manifest_url,["validation"]["base_url"])$*.nii.gz"
	mv "$@.partial" "$@"

build: check-model
	cargo build --release
	@echo "built $(BIN)"

fmt:
	cargo fmt --check

lint: check-model
	cargo clippy --release --all-targets -- -D warnings

test: check-model
	cargo test --release

test-real: check-model fetch-validation
	SYNTHSEG_REFERENCE_DIR="$(SYNTHSEG_REFERENCE_DIR)" cargo test --release -- --ignored real_volumes
	@echo "report: validation/report.json"

# Preprocessing vs the Keras dump (make references writes it to $(SYNTHSEG_REFERENCE_DIR)/keras).
test-keras: check-model fetch-validation
	SYNTHSEG_REFERENCE_DIR="$(SYNTHSEG_REFERENCE_DIR)" cargo test --release -- --ignored preprocess_matches_keras

references: fetch-validation
	for f in T1_head_2mm T1_head; do scripts/generate_reference.sh "$(SYNTHSEG_REFERENCE_DIR)" "$(SYNTHSEG_REFERENCE_DIR)/$$f.nii.gz"; done
	scripts/generate_reference.sh test/fixtures test/fixtures/small.nii.gz
	sh -c 'export FREESURFER_HOME=/Applications/freesurfer/8.1.0; . $$FREESURFER_HOME/SetUpFreeSurfer.sh >/dev/null; \
		for f in T1_head_2mm T1_head; do fspython scripts/keras_reference.py "$(SYNTHSEG_REFERENCE_DIR)/$$f.nii.gz" "$(SYNTHSEG_REFERENCE_DIR)/keras"; done'

clean:
	cargo clean
	rm -rf dist

macos-pkg-adhoc: build
	env MACOS_SIGN_IDENTITY=- MACOS_INSTALLER_IDENTITY= scripts/package_macos.sh "$(VERSION)"
	scripts/verify_macos_pkg.sh dist/synthseg-$(VERSION)-macos-arm64-adhoc.pkg --allow-adhoc

macos-pkg: build
	@test -n "$(MACOS_SIGN_IDENTITY)" || { echo "Set MACOS_SIGN_IDENTITY to a Developer ID Application identity or SHA-1." >&2; exit 2; }
	@test -n "$(MACOS_INSTALLER_IDENTITY)" || { echo "Set MACOS_INSTALLER_IDENTITY to a Developer ID Installer identity or SHA-1 (security find-identity -v)." >&2; exit 2; }
	env MACOS_SIGN_IDENTITY="$(MACOS_SIGN_IDENTITY)" MACOS_INSTALLER_IDENTITY="$(MACOS_INSTALLER_IDENTITY)" scripts/package_macos.sh "$(VERSION)"
	scripts/verify_macos_pkg.sh "$(MACOS_PKG)"

macos-notarize:
	scripts/notarize_macos.sh "$(MACOS_PKG)" "$(NOTARY_PROFILE)"

macos-notary-profile:
	@test -n "$(APPLE_ID)" || { echo "Set APPLE_ID to your Developer Apple ID." >&2; exit 2; }
	@test -n "$(TEAM_ID)" || { echo "Set TEAM_ID to your 10-character Developer Team ID." >&2; exit 2; }
	scripts/store_notary_credentials.sh "$(NOTARY_PROFILE)" "$(APPLE_ID)" "$(TEAM_ID)"

# Credentials are checked first so a missing profile fails before the build, not after it.
macos-release:
	+$(MAKE) check-notary-profile
	+$(MAKE) test
	+$(MAKE) test-real
	+$(MAKE) macos-pkg
	+$(MAKE) macos-notarize

check-notary-profile:
	@xcrun notarytool history --keychain-profile "$(NOTARY_PROFILE)" >/dev/null 2>&1 || { \
		echo "No notarization credentials for profile '$(NOTARY_PROFILE)'. Store them once with:" >&2; \
		echo "  make macos-notary-profile APPLE_ID='you@example.com' TEAM_ID='ABCDE12345'" >&2; \
		echo "(prompts for an app-specific password from appleid.apple.com, not your Apple ID password)" >&2; \
		exit 2; }
	@echo "notarization credentials found for profile '$(NOTARY_PROFILE)'"
