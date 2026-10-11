"""Exercise the review renderer's validation, normalization, and theme output."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "multi-agent-review"
sys.path.insert(0, str(SKILL / "scripts"))
import render_report  # noqa: E402

STACK = json.loads((SKILL / "assets/example-stack-report.json").read_text(encoding="utf-8"))
SETUP = json.loads((SKILL / "assets/example-report.json").read_text(encoding="utf-8"))
DATA = re.compile(r'<script type="application/json" id="report-data">(.*?)</script>', re.S)


def embedded(page):
    return json.loads(DATA.search(page).group(1))


class RenderTests(unittest.TestCase):
    def test_every_theme_renders_both_examples(self):
        self.assertIn(render_report.DEFAULT_THEME, render_report.THEMES)
        for theme in render_report.THEMES:
            for name, report in (("stack", STACK), ("setup", SETUP)):
                with self.subTest(theme=theme, report=name):
                    page = render_report.render(report, theme)
                    self.assertNotRegex(page, r"@@[A-Z_]+@@")
                    self.assertIn("Content-Security-Policy", page)
                    self.assertIn("MultiAgentReview.create()", page)
                    self.assertNotRegex(page, r"<(?:script|link|img)[^>]+(?:src|href)=[\"']https?:", "themes must stay offline")
                    self.assertEqual(embedded(page)["title"], report["title"])

    def test_every_theme_offers_answers_and_a_resizable_drawer(self):
        removed = ("showHidden", "isHidden", "hiddenCount", "toggleHidden", "clearMarks", "hidden-by-user")
        for theme, path in render_report.THEMES.items():
            source = Path(path).read_text(encoding="utf-8")
            with self.subTest(theme=theme):
                for builder in ("ui.answer(", "ui.copyAnswers(", "ui.resizer(", "ui.facet('answer'"):
                    self.assertIn(builder, source)
                for name in removed:
                    self.assertNotIn(name, source)

    def test_normalizes_pr_tags_and_target(self):
        page = embedded(render_report.render(STACK))
        by_id = {f["id"]: f for f in page["findings"]}
        self.assertEqual(by_id["F-001"]["prs"], ["pr-413"])
        self.assertEqual(by_id["F-005"]["prs"], ["pr-412", "pr-413"])
        self.assertNotIn("pr", by_id["F-001"])
        self.assertEqual(embedded(render_report.render(SETUP))["stack"], [])
        self.assertIsInstance(page["target"], list)
        self.assertEqual(page["meta"]["confirmed"], sum(f["disposition"] == "confirmed" for f in STACK["findings"]))

    def test_single_pr_becomes_part_of_the_target(self):
        report = copy.deepcopy(STACK)
        report["stack"] = [dict(STACK["stack"][1], parent=None)]
        for finding in report["findings"]:
            finding.pop("prs", None)
            finding["pr"] = report["stack"][0]["id"]
        page = embedded(render_report.render(report))
        target = dict(page["target"])
        self.assertEqual(target["Pull request"], "#413 " + report["stack"][0]["title"])
        self.assertEqual(target["Branch"], f"{report['stack'][0]['branch']} into {report['stack'][0]['base']}")
        self.assertEqual(page["target"][:3], [[k, target[k]] for k in ("Pull request", "Branch", "Head")])
        self.assertEqual(page["sources"][0]["url"], report["stack"][0]["url"])
        self.assertNotIn("Pull request", dict(embedded(render_report.render(STACK))["target"]), "stacks keep their own target")

    def test_report_text_cannot_close_the_data_script(self):
        report = copy.deepcopy(STACK)
        report["findings"][0]["evidence"] = "</script><script>alert(1)</script> @@CORE_JS@@  "
        page = render_report.render(report)
        self.assertNotIn("</script><script>alert", page)
        self.assertEqual(embedded(page)["findings"][0]["evidence"], report["findings"][0]["evidence"])

    def test_stack_validation(self):
        cases = {
            "unknown parent": lambda r: r["stack"][1].update(parent="pr-999"),
            "cycle": lambda r: r["stack"][0].update(parent="pr-414"),
            "duplicate": lambda r: r["stack"][1].update(id="pr-412"),
            "unsafe url": lambda r: r["stack"][0].update(url="javascript:alert(1)"),
            "unknown finding pr": lambda r: r["findings"][0].update(pr="pr-999"),
            "bad tags": lambda r: r["findings"][0].update(tags="security"),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                report = copy.deepcopy(STACK)
                mutate(report)
                with self.assertRaises(ValueError):
                    render_report.render(report)

    def test_findings_cannot_reference_prs_without_a_stack(self):
        report = copy.deepcopy(SETUP)
        report["findings"] = [dict(STACK["findings"][0])]
        with self.assertRaises(ValueError):
            render_report.render(report)

    def test_complete_status_still_requires_verified_snapshots(self):
        report = copy.deepcopy(STACK)
        report["status"] = "complete"
        with self.assertRaises(ValueError):
            render_report.render(report)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SKILL / "scripts/render_report.py"), *map(str, args)], capture_output=True, text=True)

    def test_output_dir_renders_trial_designs_and_index(self):
        self.assertTrue(set(render_report.TRIAL_THEMES) <= set(render_report.THEMES))
        for theme in render_report.TRIAL_THEMES:
            self.assertTrue((SKILL / "references/designs" / f"{theme}.md").is_file(), f"missing design notes for {theme}")
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "review"
            result = self.run_cli(SKILL / "assets/example-stack-report.json", "--output-dir", out)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(sorted(p.name for p in out.iterdir()), sorted([*(f"{t}.html" for t in render_report.TRIAL_THEMES), "index.html"]))
            index = (out / "index.html").read_text(encoding="utf-8")
            for theme in render_report.TRIAL_THEMES:
                self.assertIn(f'href="{theme}.html"', index)
                self.assertIn(f'content="multi-agent-review · {theme}"', (out / f"{theme}.html").read_text(encoding="utf-8"))
            self.assertNotIn("<script", index)

    def test_output_dir_honors_themes_and_rejects_mixed_flags(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "review"
            self.assertEqual(self.run_cli(SKILL / "assets/example-report.json", "--output-dir", out, "--themes", "board").returncode, 0)
            self.assertEqual(sorted(p.name for p in out.iterdir()), ["board.html", "index.html"])
            for args in (("--output-dir", out, "--theme", "board"), ("--output", out / "x.html", "--themes", "board"), ("--output-dir", out, "--themes", "nope")):
                with self.subTest(args=args):
                    self.assertNotEqual(self.run_cli(SKILL / "assets/example-report.json", *args).returncode, 0)

    def test_index_escapes_report_text(self):
        report = copy.deepcopy(STACK)
        report["verdict"] = "<img src=x onerror=alert(1)>"
        page = render_report.render_index(report, [("command", "command.html")])
        self.assertNotIn("<img", page)
        self.assertIn("&lt;img", page)

    def test_cli_rejects_unknown_theme(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run([sys.executable, str(SKILL / "scripts/render_report.py"), str(SKILL / "assets/example-report.json"),
                                     "--output", str(Path(temp) / "out.html"), "--theme", "nope"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid choice", result.stderr)


if __name__ == "__main__":
    unittest.main()
