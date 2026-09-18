import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).with_name("portable_release.py")
SPEC = importlib.util.spec_from_file_location("portable_release", SCRIPT)
portable_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portable_release)


class PortableReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "target"
        self.dist = self.root / "dist"
        self.docs = self.root / "docs"
        self.target.mkdir()
        self.docs.mkdir()
        for name in portable_release.DOCUMENTS:
            (self.docs / name).write_text(name + "\n")

    def payload(self, platform):
        spec = portable_release.PLATFORMS[platform]
        executable = self.target / spec["executable"]
        executable.write_bytes(b"executable")
        executable.chmod(0o755)
        real_library = self.root / spec["library"]
        real_library.write_bytes(b"dawn")
        packaged_library = self.target / spec["library"]
        if platform == "linux-x64" and os.name != "nt":
            packaged_library.symlink_to(real_library)
        else:
            packaged_library.write_bytes(real_library.read_bytes())

    def test_linux_archive_is_flat_deterministic_and_dereferences_dawn(self):
        self.payload("linux-x64")
        first = portable_release.build_archive(
            "linux-x64", "1.2.3", self.target, self.docs, self.dist
        )
        first_hash = hashlib.sha256(first.read_bytes()).hexdigest()
        second = portable_release.build_archive(
            "linux-x64", "1.2.3", self.target, self.docs, self.dist
        )
        self.assertEqual(hashlib.sha256(second.read_bytes()).hexdigest(), first_hash)
        with tarfile.open(first, "r:gz") as archive:
            self.assertEqual(
                sorted(member.name for member in archive.getmembers()),
                sorted(["synthsr", "libwebgpu_dawn.so", *portable_release.DOCUMENTS]),
            )
            self.assertTrue(all(member.isfile() for member in archive.getmembers()))
            self.assertEqual(archive.extractfile("libwebgpu_dawn.so").read(), b"dawn")

    def test_windows_archive_has_the_executable_and_dawn_dll(self):
        self.payload("windows-x64")
        archive_path = portable_release.build_archive(
            "windows-x64", "1.2.3", self.target, self.docs, self.dist
        )
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(
                sorted(archive.namelist()),
                sorted(["synthsr.exe", "webgpu_dawn.dll", *portable_release.DOCUMENTS]),
            )

    def test_windows_checksum_manifest_uses_portable_lf_line_endings(self):
        self.payload("windows-x64")
        write_text = Path.write_text

        def windows_write_text(path, text, *args, **kwargs):
            return write_text(path, text.replace("\n", "\r\n"), *args, **kwargs)

        with patch.object(Path, "write_text", windows_write_text):
            archive_path = portable_release.build_archive(
                "windows-x64", "1.2.3", self.target, self.docs, self.dist
            )
        checksum = archive_path.with_name(archive_path.name + ".sha256").read_bytes()
        self.assertTrue(checksum.endswith(b"\n"))
        self.assertNotIn(b"\r", checksum)

    def test_version_and_archive_names_reject_unsafe_values(self):
        self.assertEqual(
            portable_release.archive_name("linux-x64", "1.2.3"),
            "synthsr-1.2.3-linux-x64.tar.gz",
        )
        for invalid in ["", "v1.2.3", "1.2/3", "../1.2.3"]:
            with self.assertRaisesRegex(ValueError, "version"):
                portable_release.archive_name("linux-x64", invalid)

    def test_verified_package_cleanup_retries_a_windows_sharing_violation(self):
        self.payload("windows-x64")
        archive = portable_release.build_archive(
            "windows-x64", "1.2.3", self.target, self.docs, self.dist
        )
        cleanup = tempfile.TemporaryDirectory.cleanup
        failures = []
        extracted_paths = []

        def locked_cleanup(directory):
            if not failures:
                error = PermissionError("executable is still in use")
                error.winerror = 32
                failures.append(error)
                raise error
            return cleanup(directory)

        def verified_process(command, **kwargs):
            extracted = Path(kwargs["cwd"])
            extracted_paths.append(extracted)
            if "--self-check" in command:
                return SimpleNamespace(stdout="synthsr 1.2.3\ntarget: x86_64-windows\ncpu: ok\n")
            (extracted / "validation-output.nii.gz").write_bytes(b"output")
            (extracted / "validation-output.json").write_text(json.dumps({
                "executionProvider": "cpu", "threads": 2,
            }))
            return SimpleNamespace(stdout="")

        with patch.object(portable_release.sys, "platform", "win32"), \
             patch.object(portable_release, "release_version", return_value="1.2.3"), \
             patch.object(portable_release.subprocess, "run", side_effect=verified_process), \
             patch.object(tempfile.TemporaryDirectory, "cleanup", autospec=True, side_effect=locked_cleanup):
            validation = portable_release.verify_archive("windows-x64", archive)

        self.assertEqual(len(failures), 1)
        self.assertIn("packaged CPU inference: ok", validation.read_text())
        self.assertTrue(extracted_paths)
        self.assertTrue(all(not path.exists() for path in extracted_paths))

    def test_package_cleanup_does_not_hide_persistent_locks_or_other_errors(self):
        cleanup = tempfile.TemporaryDirectory.cleanup
        for winerror, attempts in [(32, 6), (5, 1), (None, 1)]:
            with self.subTest(winerror=winerror):
                error = PermissionError("cannot delete package")
                error.winerror = winerror
                directories = []

                def fail_cleanup(directory):
                    directories.append(directory)
                    raise error

                try:
                    with patch.object(tempfile.TemporaryDirectory, "cleanup", autospec=True, side_effect=fail_cleanup), \
                         patch.object(portable_release.time, "sleep") as sleep:
                        with self.assertRaises(PermissionError) as raised:
                            with portable_release.package_directory():
                                pass
                        self.assertIs(raised.exception, error)
                        self.assertEqual(len(directories), attempts)
                        self.assertEqual(sleep.call_count, attempts - 1)
                finally:
                    if directories:
                        cleanup(directories[0])

    def test_package_directory_preserves_verification_failures(self):
        with self.assertRaisesRegex(ValueError, "inference failed"):
            with portable_release.package_directory() as directory:
                raise ValueError("inference failed")
        self.assertFalse(directory.exists())


if __name__ == "__main__":
    unittest.main()
