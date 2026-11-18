"""Run the isolated cleanup-order protocol suite without importing its CLI modules globally."""
import subprocess
import sys
import unittest
from pathlib import Path


class CleanupOrderProtocol(unittest.TestCase):
    def test_synthetic_protocol(self):
        folder = Path(__file__).parent / "cleanup-order-1"
        subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(folder), "-p", "test_contract.py"], check=True)
