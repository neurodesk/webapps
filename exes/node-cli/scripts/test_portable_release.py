#!/usr/bin/env python3
from contextlib import ExitStack
import hashlib
import zipfile
import importlib.util
import json
import os
import pathlib
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = pathlib.Path(__file__).with_name("portable_release.py")
SPEC = importlib.util.spec_from_file_location("portable_release", MODULE_PATH)
portable_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = portable_release
SPEC.loader.exec_module(portable_release)

PACKAGES = ("packages/syncro", "packages/topofit")


def package_version(package_dir):
    return json.loads((ROOT / package_dir / "package.json").read_text(encoding="utf8"))["version"]


class PortableReleaseTests(unittest.TestCase):
    def test_windows_launcher_and_node_are_signed_before_manifest_and_zip(self):
        target = portable_release.load_target(ROOT, "packages/topofit", "windows-x64")
        def deploy(stage, target):
            (stage / "app/node_modules").mkdir(parents=True)
        def extract(archive, target, stage):
            (stage / "runtime").mkdir()
            (stage / target.private_node).write_bytes(b"unsigned node")
        def launcher(stage, target):
            (stage / target.executable).write_bytes(b"unsigned launcher")
        def sign(stage, required):
            self.assertEqual(required, (target.executable, target.private_node))
            (stage / target.executable).write_bytes(b"signed launcher")
            (stage / target.private_node).write_bytes(b"signed node")
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            stack.enter_context(mock.patch.object(portable_release, "DIST", pathlib.Path(temporary)))
            for name in ("_assert_native_host", "_flatten_node_modules", "_prune_onnx_runtime", "_copy_dependency_licenses", "_run", "_download_runtime"):
                stack.enter_context(mock.patch.object(portable_release, name))
            for name, function in (("_deploy_application", deploy), ("_extract_node_files", extract), ("_build_launcher", launcher)):
                stack.enter_context(mock.patch.object(portable_release, name, side_effect=function))
            stack.enter_context(mock.patch.object(portable_release.windows_signing, "sign_tree", side_effect=sign))
            archive = portable_release.package_target(target)
            with zipfile.ZipFile(archive) as bundle:
                prefix = target.directory + "/"
                self.assertEqual(bundle.read(prefix + target.executable), b"signed launcher")
                self.assertEqual(bundle.read(prefix + target.private_node), b"signed node")
                manifest = json.loads(bundle.read(prefix + "manifest.json"))
            hashes = {record["path"]: record["sha256"] for record in manifest["files"]}
            self.assertEqual(hashes[target.executable], hashlib.sha256(b"signed launcher").hexdigest())
            self.assertEqual(hashes[target.private_node], hashlib.sha256(b"signed node").hexdigest())
            self.assertEqual(archive.with_name(archive.name + ".sha256").read_text().split()[0], hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_commands_are_resolved_with_the_supplied_path(self):
        environment = {"PATH": "portable-tools"}
        with mock.patch.object(portable_release.shutil, "which", return_value="/portable-tools/pnpm.CMD") as which:
            with mock.patch.object(portable_release.subprocess, "run") as run:
                portable_release._run(["pnpm", "--version"], env=environment)
        which.assert_called_once_with("pnpm", path="portable-tools")
        run.assert_called_once_with(
            ["/portable-tools/pnpm.CMD", "--version"],
            cwd=ROOT,
            env=environment,
            check=True,
            text=True,
            stdout=portable_release.subprocess.PIPE,
            stderr=portable_release.subprocess.STDOUT,
        )

    def test_a_failing_command_prints_its_captured_output(self):
        failure = subprocess.CalledProcessError(1, ["check"], output="FAIL lh.white mean distance\n")
        with mock.patch.object(portable_release.shutil, "which", return_value="/usr/bin/node"):
            with mock.patch.object(portable_release.subprocess, "run", side_effect=failure):
                with mock.patch.object(portable_release.sys, "stderr") as stderr:
                    with self.assertRaises(subprocess.CalledProcessError):
                        portable_release._run(["node", "check.mjs"])
        stderr.write.assert_called_once_with("FAIL lh.white mean distance\n")

    def test_verification_fails_when_a_tool_writes_into_home(self):
        target = portable_release.load_target(ROOT, "packages/topofit", "linux-x64")
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            environment = portable_release.isolated_home_environment(home)
            self.assertTrue(all(environment[name] == str(home) for name in portable_release.HOME_VARIABLES))
            portable_release.check_home_untouched(home, target)
            (home / ".cache/Microsoft/DeveloperTools/.onnxruntime").mkdir(parents=True)
            (home / ".cache/Microsoft/DeveloperTools/.onnxruntime/deviceid").write_text("id")
            with self.assertRaisesRegex(ValueError, "deviceid"):
                portable_release.check_home_untouched(home, target)

    def test_check_pkg_resolves_a_relative_package_against_the_caller(self):
        target = portable_release.load_target(ROOT, "packages/topofit", "macos-arm64")
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            (directory / "tool.pkg").write_bytes(b"xar!")
            seen = []
            def run(command, **_):
                seen.extend(argument for argument in command if argument.endswith("tool.pkg"))
                raise RuntimeError("stop")
            previous = os.getcwd()
            os.chdir(directory)
            try:
                with mock.patch.object(portable_release.subprocess, "run", side_effect=run):
                    with self.assertRaises(RuntimeError):
                        portable_release.check_pkg(target, pathlib.Path("tool.pkg"), portable_release.mac_signing({}))
            finally:
                os.chdir(previous)
        self.assertEqual(seen, [str(directory.resolve() / "tool.pkg")])

    def test_release_target_derives_safe_names(self):
        target = portable_release.load_target(ROOT, "packages/syncro", "linux-x64")
        version = package_version("packages/syncro")
        self.assertEqual(target.version, version)
        self.assertEqual(target.archive_name, f"syncro-{version}-linux-x64.tar.gz")
        self.assertEqual(target.executable, "syncro")
        self.assertEqual(target.package, "@neurodesk/syncro")
        self.assertTrue(target.build)
        windows = portable_release.load_target(ROOT, "packages/syncro", "windows-x64")
        self.assertEqual(windows.private_node, "runtime/node.exe")
        self.assertEqual(windows.node_platform, "win32")

    def test_topofit_targets_cover_apple_silicon(self):
        version = package_version("packages/topofit")
        target = portable_release.load_target(ROOT, "packages/topofit", "macos-arm64")
        self.assertEqual(target.archive_name, f"topofit-{version}-macos-arm64.pkg")
        self.assertTrue(target.installer)
        self.assertEqual(str(target.install_directory), "/usr/local/lib/neurodesk/topofit")
        self.assertEqual(str(target.command_link), "/usr/local/bin/topofit")
        self.assertEqual((target.node_platform, target.node_arch), ("darwin", "arm64"))
        self.assertEqual(target.package, "@neurodesk/topofit")
        self.assertFalse(target.build)
        self.assertEqual(target.validation, ROOT / "packages/topofit/validation/cli-check.mjs")
        self.assertTrue(target.validation.is_file())
        self.assertEqual(target.onnx_runtime, "1.29.0")

    def test_every_release_spec_loads_and_names_its_executables_after_the_tool(self):
        for package_dir in PACKAGES:
            release = json.loads((ROOT / package_dir / "release.json").read_text(encoding="utf8"))
            for target_id in release["targets"]:
                target = portable_release.load_target(ROOT, package_dir, target_id)
                self.assertTrue((ROOT / package_dir / "bin" / f"{target.tool}.js").is_file())
                self.assertTrue(target.validation.is_file())

    def test_unknown_target_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "target"):
            portable_release.load_target(ROOT, "packages/syncro", "linux-arm64")
        with self.assertRaisesRegex(ValueError, "target"):
            portable_release.load_target(ROOT, "packages/topofit", "windows-arm64")

    def test_a_tool_without_onnx_runtime_or_dependencies_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = pathlib.Path(temporary)
            (repo / "apps/tool").mkdir(parents=True)
            (repo / "packages/tool/bin").mkdir(parents=True)
            package = {"name": "@neurodesk/tool", "version": "0.1.20261005", "bin": {"tool": "bin/tool.js"}}
            (repo / "apps/tool/package.json").write_text(json.dumps(package))
            (repo / "packages/tool/package.json").write_text(json.dumps(package))
            release = {"displayName": "Tool", "app": "tool", "run": "", "readme": {"run": "Run", "notes": []}, "validation": "check.mjs", "targets": {"linux-x64": {"archive": "tar.gz", "executable": "tool"}}}
            (repo / "packages/tool/release.json").write_text(json.dumps(release))
            self.assertIsNone(portable_release.load_target(repo, "packages/tool", "linux-x64").onnx_runtime)
            app = repo / "stage/app"
            (app / "node_modules").mkdir(parents=True)
            portable_release._flatten_node_modules(app, "@neurodesk/tool")
            self.assertEqual(list((app / "node_modules").iterdir()), [])

    def test_readme_comes_from_the_release_spec(self):
        syncro = portable_release.readme_text(portable_release.load_target(ROOT, "packages/syncro", "linux-x64"))
        self.assertIn("  ./syncro input.nii.gz results --threads 4\n", syncro)
        self.assertIn("SYNcro is research software.", syncro)
        self.assertNotIn("quarantine", syncro)
        windows = portable_release.readme_text(portable_release.load_target(ROOT, "packages/topofit", "windows-x64"))
        self.assertIn("  .\\topofit.exe self-check\n", windows)
        self.assertNotIn("SYNcro", windows)
        macos = portable_release.readme_text(portable_release.load_target(ROOT, "packages/topofit", "macos-arm64"))
        self.assertIn("  topofit self-check\n", macos)
        self.assertIn("  topofit input.nii.gz results\n", macos)
        self.assertIn("  sudo rm -rf /usr/local/lib/neurodesk/topofit /usr/local/bin/topofit\n", macos)
        self.assertNotIn("quarantine", macos)
        self.assertNotIn("./topofit", macos)

    def test_host_must_match_the_target(self):
        target = portable_release.load_target(ROOT, "packages/topofit", "macos-arm64")
        with mock.patch.object(portable_release.sys, "platform", "linux"), mock.patch.object(portable_release.platform, "machine", return_value="x86_64"):
            with self.assertRaisesRegex(ValueError, "matching host"):
                portable_release._assert_native_host(target)
        with mock.patch.object(portable_release.sys, "platform", "darwin"), mock.patch.object(portable_release.platform, "machine", return_value="arm64"):
            portable_release._assert_native_host(target)

    def test_manifest_rejects_symlinks_and_path_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "file.txt").write_text("safe", encoding="utf8")
            manifest = portable_release.create_manifest(root, "0.1.20260910", "linux-x64")
            self.assertEqual([entry["path"] for entry in manifest["files"]], ["file.txt"])
            try:
                (root / "link").symlink_to(root / "file.txt")
            except OSError:
                self.skipTest("this Windows runner cannot create test symlinks")
            with self.assertRaisesRegex(ValueError, "symlink"):
                portable_release.create_manifest(root, "0.1.20260910", "linux-x64")

    def test_onnx_pruner_keeps_only_the_linux_cpu_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = pathlib.Path(temporary)
            runtime = app / "node_modules/onnxruntime-node/bin/napi-v6"
            linux = runtime / "linux/x64"
            linux.mkdir(parents=True)
            for name in (
                "onnxruntime_binding.node",
                "libonnxruntime.so.1",
                "libonnxruntime_providers_shared.so",
                "libonnxruntime_providers_cuda.so",
                "libonnxruntime_providers_tensorrt.so",
            ):
                (linux / name).write_text(name)
            (runtime / "linux/arm64").mkdir(parents=True)
            (runtime / "linux/arm64/onnxruntime_binding.node").write_text("foreign")
            windows = runtime / "win32/x64"
            windows.mkdir(parents=True)
            (windows / "onnxruntime_binding.node").write_text("foreign")
            portable_release._prune_onnx_runtime(app, portable_release.load_target(ROOT, "packages/syncro", "linux-x64"))
            self.assertEqual(
                sorted(path.name for path in linux.iterdir()),
                ["libonnxruntime.so.1", "libonnxruntime_providers_shared.so", "onnxruntime_binding.node"],
            )
            self.assertFalse((runtime / "win32").exists())
            self.assertFalse((runtime / "linux/arm64").exists())

    def test_onnx_pruner_keeps_only_the_apple_silicon_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = pathlib.Path(temporary)
            runtime = app / "node_modules/onnxruntime-node/bin/napi-v6"
            for directory in ("darwin/arm64", "darwin/x64", "linux/x64"):
                (runtime / directory).mkdir(parents=True)
                (runtime / directory / "onnxruntime_binding.node").write_text(directory)
            portable_release._prune_onnx_runtime(app, portable_release.load_target(ROOT, "packages/topofit", "macos-arm64"))
            self.assertEqual(
                sorted(path.relative_to(runtime).as_posix() for path in runtime.rglob("onnxruntime_binding.node")),
                ["darwin/arm64/onnxruntime_binding.node"],
            )

    def test_runtime_catalog_has_pinned_node_archives(self):
        catalog = json.loads((ROOT / "exes/node-cli/node-runtimes.json").read_text())
        self.assertEqual(catalog["version"], "22.22.0")
        for target in ("linux-x64", "windows-x64", "macos-arm64"):
            self.assertRegex(catalog["targets"][target]["sha256"], r"^[0-9a-f]{64}$")
            self.assertIn(f"/v{catalog['version']}/", catalog["targets"][target]["url"])


THIN_MACHO = b"\xcf\xfa\xed\xfe" + bytes(28)


def macho_with_entitlements(entitlements):
    blob = struct.pack(">2I", 0xFADE7171, 8 + len(entitlements)) + entitlements
    signature = struct.pack(">3I", 0xFADE0CC0, 12 + 8 + len(blob), 1) + struct.pack(">2I", 5, 20) + blob
    header = b"\xcf\xfa\xed\xfe" + struct.pack("<3I", 0x0100000C, 0, 2) + struct.pack("<4I", 1, 16, 0, 0)
    command = struct.pack("<4I", 0x1D, 16, 48, len(signature))
    return header + command + signature


def xar(table_of_contents):
    compressed = zlib.compress(table_of_contents)
    return struct.pack(">4sHHQQI", b"xar!", 28, 1, len(compressed), len(table_of_contents), 1) + compressed


class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.target = portable_release.load_target(ROOT, "packages/topofit", "macos-arm64")
        self.version = package_version("packages/topofit")

    def test_signing_mode_needs_both_identities_or_neither(self):
        adhoc = portable_release.mac_signing({})
        self.assertTrue(adhoc.adhoc)
        self.assertEqual(adhoc.application, "-")
        self.assertTrue(portable_release.mac_signing({"MACOS_SIGN_IDENTITY": "-", "MACOS_INSTALLER_IDENTITY": ""}).adhoc)
        signed = portable_release.mac_signing({"MACOS_SIGN_IDENTITY": "Developer ID Application: Test (ABCDE12345)", "MACOS_INSTALLER_IDENTITY": "Developer ID Installer: Test (ABCDE12345)"})
        self.assertFalse(signed.adhoc)
        for partial in ({"MACOS_SIGN_IDENTITY": "Developer ID Application: Test"}, {"MACOS_INSTALLER_IDENTITY": "Developer ID Installer: Test"}):
            with self.assertRaisesRegex(ValueError, "both"):
                portable_release.mac_signing(partial)

    def test_only_signed_installers_carry_the_release_name(self):
        signed = portable_release.MacSigning("Developer ID Application: Test", "Developer ID Installer: Test")
        self.assertEqual(portable_release.artifact_name(self.target, signed), f"topofit-{self.version}-macos-arm64.pkg")
        self.assertEqual(portable_release.artifact_name(self.target, portable_release.mac_signing({})), f"topofit-{self.version}-macos-arm64-adhoc.pkg")
        linux = portable_release.load_target(ROOT, "packages/topofit", "linux-x64")
        self.assertEqual(portable_release.artifact_name(linux, None), f"topofit-{self.version}-linux-x64.tar.gz")

    def test_macos_targets_must_ship_an_installer_and_others_must_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = pathlib.Path(temporary)
            (repo / "apps/tool").mkdir(parents=True)
            (repo / "packages/tool/bin").mkdir(parents=True)
            package = {"name": "@neurodesk/tool", "version": "0.1.20261005", "bin": {"tool": "bin/tool.js"}, "dependencies": {"onnxruntime-node": "1.29.0"}}
            (repo / "apps/tool/package.json").write_text(json.dumps(package))
            (repo / "packages/tool/package.json").write_text(json.dumps(package))
            for target, archive in (("macos-arm64", "tar.gz"), ("linux-x64", "pkg")):
                release = {"displayName": "Tool", "app": "tool", "run": "", "readme": {"run": "Run", "notes": []}, "validation": "check.mjs", "targets": {target: {"archive": archive, "executable": "tool"}}}
                (repo / "packages/tool/release.json").write_text(json.dumps(release))
                with self.assertRaisesRegex(ValueError, "must ship as"):
                    portable_release.load_target(repo, "packages/tool", target)

    def stage(self, root):
        files = {
            "topofit": THIN_MACHO,
            "runtime/node": THIN_MACHO,
            "app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node": THIN_MACHO,
            "app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.29.0.dylib": THIN_MACHO,
            "app/node_modules/fat/prebuilds/addon.node": b"\xca\xfe\xba\xbe\x00\x00\x00\x02",
            "app/node_modules/java/Main.class": b"\xca\xfe\xba\xbe\x00\x00\x00\x34",
            "app/bin/topofit.js": b"#!/usr/bin/env node\n",
            "models/topofit.onnx": b"\x08\x07",
        }
        for relative, contents in files.items():
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_bytes(contents)

    def test_signing_plan_signs_every_mach_o_inside_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.stage(root)
            plan = portable_release.signing_plan(root, self.target)
            self.assertEqual(
                [step.path.relative_to(root).as_posix() for step in plan],
                [
                    "app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.29.0.dylib",
                    "app/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
                    "app/node_modules/fat/prebuilds/addon.node",
                    "runtime/node",
                    "topofit",
                ],
            )
            self.assertEqual([step.entitlements for step in plan], [None, None, None, portable_release.NODE_ENTITLEMENTS, None])

    def test_signing_plan_requires_the_runtime_and_launcher(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.stage(root)
            (root / "runtime/node").write_bytes(b"#!/bin/sh\n")
            with self.assertRaisesRegex(ValueError, r"runtime[/\\]node"):
                portable_release.signing_plan(root, self.target)

    def test_codesign_uses_the_hardened_runtime_and_entitles_only_node(self):
        node = portable_release.SigningStep(pathlib.Path("runtime", "node"), portable_release.NODE_ENTITLEMENTS)
        addon = portable_release.SigningStep(pathlib.Path("binding.node"), None)
        signed = portable_release.MacSigning("Developer ID Application: Test", "Developer ID Installer: Test")
        self.assertEqual(
            portable_release.codesign_command(node, signed),
            ["codesign", "--force", "--options", "runtime", "--timestamp", "--entitlements", str(portable_release.NODE_ENTITLEMENTS), "--sign", "Developer ID Application: Test", str(node.path)],
        )
        self.assertEqual(
            portable_release.codesign_command(addon, portable_release.mac_signing({})),
            ["codesign", "--force", "--options", "runtime", "--timestamp=none", "--sign", "-", "binding.node"],
        )

    def test_committed_entitlements_are_the_official_ones_without_debugging(self):
        committed = plistlib.loads(portable_release.NODE_ENTITLEMENTS.read_bytes())
        self.assertIn("com.apple.security.cs.allow-jit", committed)
        self.assertNotIn("com.apple.security.get-task-allow", committed)
        official = plistlib.dumps({**committed, "com.apple.security.get-task-allow": True})
        self.assertEqual(plistlib.loads(portable_release.macho_entitlements(macho_with_entitlements(official))), {**committed, "com.apple.security.get-task-allow": True})
        with tempfile.TemporaryDirectory() as temporary:
            node = pathlib.Path(temporary) / "node"
            node.write_bytes(macho_with_entitlements(official))
            portable_release.check_node_entitlements(node)
            node.write_bytes(macho_with_entitlements(plistlib.dumps({"com.apple.security.cs.allow-jit": True})))
            with self.assertRaisesRegex(ValueError, "differs"):
                portable_release.check_node_entitlements(node)

    def test_preinstall_replaces_only_this_tool(self):
        script = portable_release.preinstall_script(self.target)
        self.assertIn('rm -rf "$3/usr/local/lib/neurodesk/topofit"\n', script)
        self.assertEqual(script.count("rm "), 1)

    def release_set(self, directory, *, signed=True, notarized=True):
        for target_id in ("linux-x64", "windows-x64", "macos-arm64"):
            target = portable_release.load_target(ROOT, "packages/topofit", target_id)
            archive = directory / target.archive_name
            signature = b'<signature style="RSA"/>' if signed else b""
            archive.write_bytes(xar(b"<xar><toc>" + signature + b"</toc></xar>") if target.installer else target_id.encode())
            (directory / (archive.name + ".sha256")).write_text(f"{portable_release._sha256(archive)}  {archive.name}\n")
            evidence = "source=Notarized Developer ID\n" if notarized and target.installer else ""
            (directory / (archive.name + ".validation.txt")).write_text(f"PASS {target_id}\n{evidence}")

    def test_release_set_accepts_a_notarized_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            self.release_set(directory)
            portable_release.verify_release_set(ROOT, "packages/topofit", directory)

    def test_release_set_rejects_ad_hoc_and_unsigned_installers(self):
        for change, message in (
            (lambda directory: (directory / f"topofit-{self.version}-macos-arm64-adhoc.pkg").write_bytes(b""), "ad hoc"),
            (lambda directory: self.release_set(directory, signed=False), "unsigned"),
            (lambda directory: self.release_set(directory, notarized=False), "notarization"),
        ):
            with tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                self.release_set(directory)
                change(directory)
                with self.assertRaisesRegex(ValueError, message):
                    portable_release.verify_release_set(ROOT, "packages/topofit", directory)


@unittest.skipIf(sys.platform == "win32", "the macOS release Makefile runs on Unix")
class ReleaseMakefileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = pathlib.Path(temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()

    def executable(self, path, source):
        path.write_text("#!/bin/sh\nset -eu\n" + source)
        path.chmod(0o755)
        return path

    def make(self, *arguments, **environment):
        return subprocess.run(
            ["make", "-j4", "-C", str(ROOT / "exes/node-cli"), *arguments],
            env={**os.environ, **environment},
            capture_output=True,
            text=True,
        )

    def test_release_phases_run_in_order_and_stop_at_a_failure(self):
        log = self.directory / "phases"
        make = self.executable(self.bin / "record-make", 'printf \'%s\\n\' "$1" >> "$PHASE_LOG"\n[ "$1" != "$FAIL_PHASE" ]\n')
        phases = ["check-notary-profile", "macos-pkg", "macos-notarize", "macos-verify"]
        for failing in ["", *phases]:
            with self.subTest(failing=failing):
                log.write_text("")
                result = self.make("macos-release", f"MAKE={make}", PHASE_LOG=str(log), FAIL_PHASE=failing)
                recorded = log.read_text().splitlines()
                if failing:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(recorded, phases[: phases.index(failing) + 1])
                else:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(recorded, phases)

    def test_notarization_reuses_synthsr_with_the_node_cli_verifier(self):
        scripts = self.directory / "synthsr-scripts"
        scripts.mkdir()
        record = self.directory / "notarize.log"
        self.executable(scripts / "notarize_macos.sh", 'printf \'%s\\n\' "$PWD" "$1" "$2" "$PACKAGE" "$VERIFY_MACOS_PKG" > "$RECORD"\n')
        result = self.make(
            "macos-notarize",
            "PACKAGE=packages/topofit",
            "MACOS_SIGN_IDENTITY=Developer ID Application: Test (ABCDE12345)",
            "MACOS_INSTALLER_IDENTITY=Developer ID Installer: Test (ABCDE12345)",
            f"SYNTHSR_SCRIPTS={scripts}",
            f"DIST={self.directory}",
            "NOTARY_PROFILE=node-cli-ci",
            RECORD=str(record),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            record.read_text().splitlines(),
            [
                str(self.directory),
                f"topofit-{package_version('packages/topofit')}-macos-arm64.pkg",
                "node-cli-ci",
                "packages/topofit",
                str(ROOT / "exes/node-cli/scripts/verify_macos_pkg.sh"),
            ],
        )

    def test_packaging_needs_a_package_directory(self):
        result = self.make("macos-pkg-adhoc")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Set PACKAGE", result.stderr)


if __name__ == "__main__":
    unittest.main()
