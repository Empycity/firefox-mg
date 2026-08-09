import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL_REFERENCES = ROOT / "skills/firefox-trace-agent/references"

MANUALS = {
    "PRODUCT_MANUAL.md": "product-manual.md",
    "TRACE_MODE_PLAYBOOK.md": "trace-mode-operation-manual.md",
    "AGENT_TRACE_GUIDE.md": "agent-trace-guide.md",
    "BROWSER_RUNTIME_REVIEW.md": "browser-runtime-review.md",
}


class SkillManualSyncTest(unittest.TestCase):
    def test_published_manuals_match_repository_docs(self):
        for source_name, published_name in MANUALS.items():
            with self.subTest(manual=source_name):
                self.assertEqual(
                    (ROOT / "docs" / source_name).read_bytes(),
                    (SKILL_REFERENCES / published_name).read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
