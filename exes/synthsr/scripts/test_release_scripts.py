#!/usr/bin/env python3
"""Exercise release failure handling without Apple tools or credentials."""
import os
import json
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ReleaseScripts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.environment = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}"}

    def executable(self, name, source):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + source)
        path.chmod(0o755)
        return path

    def verify_package(self, *, adhoc=False, **overrides):
        self.executable("pkgutil", '''
if [ "$1" = --check-signature ]; then
    if [ "$PACKAGE_TEAM" = unsigned ]; then
        echo 'Status: no signature'; exit 1
    fi
    echo 'Status: signed by a developer certificate'
    echo "1. Developer ID Installer: Test ($PACKAGE_TEAM)"
else
    mkdir -p "$3/usr/local/bin" "$3/usr/local/lib/synthsr"
    printf '#!/bin/sh\\ntouch "$RUN_MARKER"\\nexit "$PAYLOAD_EXIT"\\n' > "$3/usr/local/bin/synthsr"
    touch "$3/usr/local/lib/synthsr/libwebgpu_dawn.dylib"
fi
''')
        self.executable("codesign", '''
if [ "$1" = -dv ]; then
    echo "TeamIdentifier=$BINARY_TEAM"
    echo 'Authority=Developer ID Application: Test'
fi
''')
        self.executable("otool", '''
if [ "$1" = -l ]; then
    printf 'cmd LC_RPATH\\n path %s (offset 12)\\n' "$RPATH"
else
    printf 'test:\\n /usr/lib/libSystem.B.dylib\\n'
fi
''')
        package = self.directory / "test.pkg"
        package.touch()
        marker = self.directory / "executed"
        environment = {**self.environment, "EXPECTED_TEAM_ID": "ABCDE12345",
                       "PACKAGE_TEAM": "ABCDE12345", "BINARY_TEAM": "ABCDE12345",
                       "RPATH": "@executable_path/../lib/synthsr", "PAYLOAD_EXIT": "0",
                       "RUN_MARKER": str(marker), **overrides}
        result = subprocess.run(
            ["sh", str(ROOT / "scripts/verify_macos_pkg.sh"), str(package)]
            + (["--allow-adhoc"] if adhoc else []),
            env=environment, capture_output=True, text=True,
        )
        return result, marker.exists()

    def test_package_execution_failure_fails_verification(self):
        result, executed = self.verify_package(PAYLOAD_EXIT="42")
        self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
        self.assertTrue(executed)
        self.assertNotIn("Verified", result.stdout)

    def test_signed_package_executes_only_with_matching_identities(self):
        for values in [{"PACKAGE_TEAM": "unsigned"}, {"PACKAGE_TEAM": "WRONG12345"},
                       {"BINARY_TEAM": "WRONG12345"}]:
            result, executed = self.verify_package(**values)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(executed)
        result, executed = self.verify_package()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(executed)

    def test_unsigned_local_build_requires_explicit_opt_in(self):
        result, executed = self.verify_package(adhoc=True, PACKAGE_TEAM="unsigned")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(executed)

    def test_invalid_runtime_paths_never_execute(self):
        for rpath in ["/Users/builder/target/release", "@executable_path"]:
            result, executed = self.verify_package(RPATH=rpath)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(executed)

    def notarize(self, verifier_exit):
        self.executable("pkgutil", "echo 'Status: signed by a developer certificate'\n")
        self.executable("xcrun", "echo \"xcrun $*\"\n")
        self.executable("spctl", "echo 'source=Notarized Developer ID'\n")
        verifier = self.executable("node-cli-verifier", f'echo "verified $1"\nexit {verifier_exit}\n')
        package = self.directory / "tool.pkg"
        package.touch()
        result = subprocess.run(
            ["sh", str(ROOT / "scripts/notarize_macos.sh"), str(package), "tool-ci"],
            env={**self.environment, "EXPECTED_TEAM_ID": "ABCDE12345", "VERIFY_MACOS_PKG": str(verifier)},
            capture_output=True, text=True,
        )
        return result, self.directory / "tool.pkg.validation.txt"

    def test_notarization_runs_the_named_payload_verifier(self):
        result, evidence = self.notarize(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"verified {self.directory / 'tool.pkg'}", evidence.read_text())
        self.assertIn("source=Notarized Developer ID", evidence.read_text())
        result, _ = self.notarize(7)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Notarized, stapled", result.stdout)

    def test_reference_generation_creates_new_output_directory(self):
        out = self.directory / "new output"
        source = self.directory / "input.nii.gz"
        source.touch()
        self.executable("node", 'touch "$3"\n')
        self.executable("zsh", 'touch "$REFERENCE_OUTPUT"\n')
        result = subprocess.run(
            ["sh", str(ROOT / "scripts/generate_reference.sh"), str(out), str(source)],
            env={**self.environment, "SYNTHSR_THREADS": "1", "REFERENCE_OUTPUT": str(out / "input_fs.nii.gz")},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len((out / "manifest.jsonl").read_text().splitlines()), 2)

    def test_manifest_repoint_requires_immutable_revision(self):
        root = self.directory / "repo"
        script = root / "exes/synthsr/scripts/repoint_model_manifest.sh"
        script.parent.mkdir(parents=True)
        shutil.copy(ROOT / "scripts/repoint_model_manifest.sh", script)
        manifests = [root / "models/synthsr.manifest.json", root / "packages/synthsr/model.manifest.json"]
        for path in manifests:
            path.parent.mkdir(parents=True)
            path.write_text('{}\n')
        self.executable("make", "exit 0\n")
        for revision in ["main", "abc123", "x" * 40, "a" * 41]:
            result = subprocess.run(["sh", str(script), revision], env=self.environment, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertTrue(all(path.read_text() == '{}\n' for path in manifests))
        revision = "ab" * 20
        result = subprocess.run(["sh", str(script), revision], env=self.environment, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in manifests:
            self.assertEqual(json.loads(path.read_text())["revision"], revision)

    def test_ci_signing_requires_credentials(self):
        environment = {key: value for key, value in self.environment.items()
                       if not key.startswith(("APPLE", "CSC_"))}
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/ci_macos_release.sh")],
            env=environment, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Missing signing secret: APPLEID", result.stderr)

    def test_ci_signing_cleans_keychain_after_release_failure(self):
        log = self.directory / "security.log"
        self.executable("security", '''
printf '%s\\n' "$*" >> "$SECURITY_LOG"
if [ "$*" = 'default-keychain -d user' ]; then
    printf '"/tmp/original.keychain-db"\\n'
fi
''')
        self.executable("xcrun", "exit 0\n")
        self.executable("make", "exit 19\n")
        environment = {**self.environment, "SECURITY_LOG": str(log),
                       "RUNNER_TEMP": str(self.directory)}
        for key in ["APPLEID", "APPLEIDPASS", "APPLE_TEAM_ID", "CSC_KEY_PASSWORD",
                    "CSC_INSTALLER_KEY_PASSWORD"]:
            environment[key] = "test-value"
        environment["CSC_LINK"] = environment["CSC_INSTALLER_LINK"] = "dGVzdA=="
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/ci_macos_release.sh")],
            env=environment, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 19, result.stdout + result.stderr)
        calls = log.read_text()
        self.assertIn("default-keychain -d user -s /tmp/original.keychain-db", calls)
        self.assertIn("delete-keychain", calls)
        self.assertEqual(list(self.directory.glob("synthsr-signing.*")), [])

    def release(self, fail_phase=""):
        log = self.directory / "phases"
        log.write_text("")
        make = self.executable("record-make", '''
printf '%s\\n' "$1" >> "$PHASE_LOG"
[ "$1" != "$FAIL_PHASE" ]
''')
        result = subprocess.run(
            ["make", "-j4", "-f", str(ROOT / "Makefile"), "macos-release", f"MAKE={make}"],
            cwd=ROOT,
            env={**self.environment, "PHASE_LOG": str(log), "FAIL_PHASE": fail_phase},
            capture_output=True, text=True,
        )
        return result, log.read_text().splitlines()

    def test_parallel_make_preserves_release_order(self):
        result, phases = self.release()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(phases, ["check-notary-profile", "test", "macos-pkg", "macos-notarize"])

    def test_failed_phase_prevents_later_release_actions(self):
        phases = ["check-notary-profile", "test", "macos-pkg", "macos-notarize"]
        for index, phase in enumerate(phases):
            with self.subTest(phase=phase):
                result, recorded = self.release(phase)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(recorded, phases[:index + 1])


if __name__ == "__main__":
    unittest.main()
