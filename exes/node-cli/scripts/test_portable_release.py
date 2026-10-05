#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = pathlib.Path(__file__).with_name("portable_release.py")
SPEC = importlib.util.spec_from_file_location("portable_release", MODULE_PATH)
portable_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = portable_release
SPEC.loader.exec_module(portable_release)

PACKAGES = ("packages/syncro",)


def package_version(package_dir):
    return json.loads((ROOT / package_dir / "package.json").read_text(encoding="utf8"))["version"]


class PortableReleaseTests(unittest.TestCase):
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
            portable_release.load_target(ROOT, "packages/syncro", "macos-arm64")

    def test_readme_comes_from_the_release_spec(self):
        syncro = portable_release.readme_text(portable_release.load_target(ROOT, "packages/syncro", "linux-x64"))
        self.assertIn("  ./syncro input.nii.gz results --threads 4\n", syncro)
        self.assertIn("SYNcro is research software.", syncro)
        self.assertNotIn("quarantine", syncro)
        windows = portable_release.readme_text(portable_release.load_target(ROOT, "packages/syncro", "windows-x64"))
        self.assertIn("  .\\syncro.exe self-check\n", windows)

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

    def test_runtime_catalog_has_pinned_node_archives(self):
        catalog = json.loads((ROOT / "exes/node-cli/node-runtimes.json").read_text())
        self.assertEqual(catalog["version"], "22.22.0")
        for target in ("linux-x64", "windows-x64"):
            self.assertRegex(catalog["targets"][target]["sha256"], r"^[0-9a-f]{64}$")
            self.assertIn(f"/v{catalog['version']}/", catalog["targets"][target]["url"])


if __name__ == "__main__":
    unittest.main()
