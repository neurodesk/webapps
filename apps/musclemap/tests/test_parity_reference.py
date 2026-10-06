import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "fetch_parity_reference.py"
spec = importlib.util.spec_from_file_location("fetch_parity_reference", SCRIPT)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class ReferenceFetchTests(unittest.TestCase):
    def setUp(self):
        self.bytes = b"pinned reference"
        self.entry = {
            "path": "references/example.nii.gz",
            "bytes": len(self.bytes),
            "sha256": hashlib.sha256(self.bytes).hexdigest(),
        }
        self.manifest = {
            "repository": "neurodeskorg/webapps",
            "revision": "a" * 40,
            "prefix": "musclemap/parity/20261004",
            "files": [self.entry],
            "cases": [{"id": "example", "input": self.entry["path"], "reference": self.entry["path"]}],
        }

    def test_corrupt_cached_file_is_downloaded_again_and_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            path = destination / self.entry["path"]
            path.parent.mkdir(parents=True)
            path.write_bytes(b"corrupt")
            with patch.object(reference.urllib.request, "urlopen", return_value=io.BytesIO(self.bytes)) as request:
                reference.fetch(destination, self.manifest, ["example"])
            self.assertEqual(path.read_bytes(), self.bytes)
            self.assertIn("/resolve/" + "a" * 40 + "/", request.call_args.args[0])
            with patch.object(reference.urllib.request, "urlopen") as request:
                reference.fetch(destination, self.manifest, ["example"])
            request.assert_not_called()

    def test_bad_download_is_rejected_without_replacing_cached_file(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            path = destination / self.entry["path"]
            path.parent.mkdir(parents=True)
            path.write_bytes(b"old corrupt cache")
            with patch.object(reference.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong")):
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    reference.fetch(destination, self.manifest)
            self.assertEqual(path.read_bytes(), b"old corrupt cache")
            self.assertFalse(path.with_name(path.name + ".part").exists())

    def test_unknown_case_fails_before_network_access(self):
        with patch.object(reference.urllib.request, "urlopen") as request:
            with self.assertRaisesRegex(ValueError, "Unknown parity cases"):
                reference.fetch(Path("unused"), self.manifest, ["missing"])
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
