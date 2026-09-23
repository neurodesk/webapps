"""Exercise file boundaries against the actual native converter."""
import gzip
import importlib.util
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test/fixtures"
spec = importlib.util.spec_from_file_location("lesion2tvx", ROOT / "lesion2tvx.py")
lesion2tvx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lesion2tvx)


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)

    def convert(self, path):
        return subprocess.run(
            [str(ROOT / "nii2tvx"), str(FIXTURES / "template.nii.gz"), str(path)],
            capture_output=True, text=True,
        )

    def tck(self, name, offset=1024, datatype="Float32LE"):
        header = (f"mrtrix tracks\ncount: 1\ndatatype: {datatype}\n"
                  f"file: . {offset:04d}\nEND\n").encode()
        if offset == 0:
            offset = len(header)
            header = header.replace(b"0000", f"{offset:04d}".encode())
        points = (0, 0, 0, 20, 0, 0, *([float("nan")] * 3), *([float("inf")] * 3))
        path = self.work / f"{name}.tck"
        path.write_bytes(header.ljust(offset, b"\0") + struct.pack("<12f", *points))
        return path

    def test_tck_padding_preserves_lesion_fraction(self):
        paths = [self.tck("packed", 0), self.tck("padded")]
        for path in paths:
            result = self.convert(path)
            self.assertEqual(result.returncode, 0, result.stderr)
        image = bytearray(gzip.decompress((FIXTURES / "template.nii.gz").read_bytes()))
        offset = int(struct.unpack_from("<f", image, 108)[0])
        struct.pack_into("<hh", image, 70, 2, 8)
        image = image[:offset] + bytearray(8000)
        image[offset + 5 + 10 * 20 + 10 * 400] = 1
        lesion = self.work / "lesion.nii"
        lesion.write_bytes(image)
        result = subprocess.run(
            [str(ROOT / "nii2tvx"), str(lesion), *[str(p.with_suffix(".tvx")) for p in paths]],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(result.stdout, "id\tpacked\tpadded\nlesion\t1\t1\n")

    def test_tck_invalid_offsets_and_datatypes_are_refused(self):
        for offset, datatype in [(1, "Float32LE"), (1024, "Float32BE"), (1024, "Float64LE")]:
            with self.subTest(offset=offset, datatype=datatype):
                path = self.tck("invalid", offset, datatype)
                self.assertNotEqual(self.convert(path).returncode, 0)
                self.assertFalse(path.with_suffix(".tvx").exists())
        path = self.tck("past_end")
        path.write_bytes(path.read_bytes().replace(b"1024", b"9999"))
        self.assertNotEqual(self.convert(path).returncode, 0)

    def test_tck_whitespace_and_crlf_header(self):
        path = self.tck("whitespace")
        original = path.read_bytes()
        header = original[:original.index(b"END\n") + 4]
        header = header.replace(b"datatype: ", b"datatype:\t  ").replace(b"\n", b"\r\n")
        path.write_bytes(header.ljust(1024, b"\0") + original[1024:])
        result = self.convert(path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_truncated_and_mixed_tck_vertices_are_refused(self):
        original = self.tck("source").read_bytes()
        cases = {
            "missing_end": original[:-12],
            "partial_triplet": original[:-4],
            "partial_float": original[:-1],
            "mixed_nan": original[:1024] + struct.pack("<3f", 0, float("nan"), 0) + original[1036:],
            "mixed_inf": original[:1024] + struct.pack("<3f", float("inf"), float("inf"), 0) + original[1036:],
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                path = self.work / f"{name}.tck"
                path.write_bytes(data)
                self.assertNotEqual(self.convert(path).returncode, 0)
                self.assertFalse(path.with_suffix(".tvx").exists())

    def test_truncated_trk_never_writes_partial_atlas(self):
        original = (FIXTURES / "all_hit.trk").read_bytes()
        count = struct.unpack_from("<i", original, 988)[0]
        missing_record = bytearray(original)
        struct.pack_into("<i", missing_record, 988, count + 1)
        # A single record with one declared property, but no property bytes.
        first_points = struct.unpack_from("<i", original, 1000)[0]
        missing_property = bytearray(original[:1004 + first_points * 12])
        struct.pack_into("<i", missing_property, 988, 1)
        struct.pack_into("<h", missing_property, 238, 1)
        for name, data in [("header", original[:100]), ("vertices", original[:-1]),
                           ("record", missing_record), ("property", missing_property)]:
            with self.subTest(name=name):
                path = self.work / f"{name}.trk"
                path.write_bytes(data)
                self.assertNotEqual(self.convert(path).returncode, 0)
                self.assertFalse(path.with_suffix(".tvx").exists())

    def test_subject_session_ids_include_normalized_prefix(self):
        for name, expected in [
            ("wsub-AB12_ses-02_desc-lesion_mask", ("AB12", "02")),
            ("sub-123_ses-followup_desc-lesion_mask", ("123", "followup")),
            ("wsub-42_desc-lesion_mask", ("42", "1")),
            ("/data/sub-27/random.nii.gz", ("27", "1")),
            ("unknown", ("unknown", "1")),
        ]:
            with self.subTest(name=name):
                self.assertEqual(lesion2tvx.extract_subject_session(name), expected)


if __name__ == "__main__":
    unittest.main()
