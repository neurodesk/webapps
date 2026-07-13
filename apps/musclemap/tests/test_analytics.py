import re
import unittest
from pathlib import Path


INDEX_HTML = Path(__file__).parents[1] / "web" / "index.html"
GA4_MEASUREMENT_ID = "G-4Z9774J59Y"


class AnalyticsMarkupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = INDEX_HTML.read_text(encoding="utf-8")

    def test_uses_neurodesk_ga4_measurement_id(self):
        self.assertIn(
            f"https://www.googletagmanager.com/gtag/js?id={GA4_MEASUREMENT_ID}",
            self.html,
        )
        self.assertIn(f"gtag('config', '{GA4_MEASUREMENT_ID}')", self.html)

    def test_ga4_config_honors_do_not_track(self):
        guarded_config = re.compile(
            r"var dnt = navigator\.doNotTrack \|\| window\.doNotTrack \|\| "
            r"navigator\.msDoNotTrack;\s*"
            r"if \(dnt !== '1' && dnt !== 'yes'\) \{\s*"
            rf"gtag\('config', '{GA4_MEASUREMENT_ID}'\);\s*\}}"
        )
        self.assertRegex(self.html, guarded_config)

    def test_cloudflare_analytics_is_absent(self):
        self.assertNotIn("static.cloudflareinsights.com", self.html)
        self.assertNotIn("data-cf-beacon", self.html)
        self.assertNotIn("Cloudflare Web Analytics", self.html)

    def test_privacy_disclosure_is_current(self):
        self.assertIn("uses Google Analytics to collect site usage metrics", self.html)
        self.assertIn(
            "Analytics is disabled when your browser sends a Do Not Track setting",
            self.html,
        )
        self.assertIn(
            "Patient images, voxel values, screenshots, and generated segmentations "
            "are not sent to Google Analytics",
            self.html,
        )


if __name__ == "__main__":
    unittest.main()
