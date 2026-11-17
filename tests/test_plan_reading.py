"""Exercise the reading-plan rules, the seven modifiers, and the renderer."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "human-review"
sys.path.insert(0, str(SKILL / "scripts"))
import plan_reading  # noqa: E402
import render_reading  # noqa: E402

CONFIG = json.loads((SKILL / "configs/rails.json").read_text(encoding="utf-8"))
EXAMPLE = json.loads((SKILL / "assets/example-plan.json").read_text(encoding="utf-8"))
DATA = re.compile(r'<script type="application/json" id="plan">(.*?)</script>', re.S)
TARGET = {"kind": "pr", "repo": "acme/example", "number": 1, "title": "t",
          "base": "main", "head_sha": "0" * 40}


def plan(files, config=None):
    """Build a plan from (path, additions, deletions) triples."""
    entries = [{"path": p, "add": a, "del": d, "status": "modified",
                "patch": "@@ -1,1 +1,1 @@\n context", "previous": None} for p, a, d in files]
    return plan_reading.build_plan(dict(TARGET), entries, config or copy.deepcopy(CONFIG))


def weights(built):
    return {f["path"]: f["weight"] for f in built["files"]}


class GlobMatching(unittest.TestCase):
    def test_double_star_crosses_directories_single_star_does_not(self):
        self.assertTrue(plan_reading.glob_re("app/**").match("app/models/deep/user.rb"))
        self.assertTrue(plan_reading.glob_re("docs/**.md").match("docs/a/b.md"))
        self.assertFalse(plan_reading.glob_re("*.lock").match("sub/Gemfile.lock"))
        self.assertTrue(plan_reading.glob_re("*.lock").match("Gemfile.lock"))

    def test_patterns_are_anchored_at_both_ends(self):
        self.assertFalse(plan_reading.glob_re("db/migrate/**").match("x/db/migrate/a.rb"))
        self.assertFalse(plan_reading.glob_re("config/routes.rb").match("config/routes.rb.bak"))

    def test_first_matching_rule_wins(self):
        built = plan([("app/components/card/component.rb", 9, 0),
                      ("app/models/user.rb", 9, 0)])
        self.assertEqual(weights(built)["app/components/card/component.rb"], "skim")
        self.assertEqual(weights(built)["app/models/user.rb"], "read")


class Modifiers(unittest.TestCase):
    def test_shape_collapse_folds_identical_signatures_regardless_of_size(self):
        small = plan([(f"config/locales/{x}.yml", 7, 0) for x in "abcde"])
        large = plan([(f"config/locales/{x}.yml", 200, 1) for x in "abcde"])
        for built in (small, large):
            folded = [f for f in built["files"] if f.get("folded_into")]
            self.assertEqual(len(folded), 4, "one representative, the rest folded")
            self.assertEqual(built["stats"]["folded"], 4)

    def test_shape_collapse_needs_an_identical_signature(self):
        built = plan([("config/locales/a.yml", 7, 0), ("config/locales/b.yml", 8, 0),
                      ("config/locales/c.yml", 9, 0)])
        self.assertEqual(built["stats"]["folded"], 0)

    def test_test_file_on_a_critical_path_caps_at_read(self):
        built = plan([("scripts/cdn/worker.ts", 50, 0), ("scripts/cdn/worker.test.ts", 90, 0)])
        self.assertEqual(weights(built)["scripts/cdn/worker.ts"], "critical")
        self.assertEqual(weights(built)["scripts/cdn/worker.test.ts"], "read")

    def test_spec_covering_critical_code_is_promoted(self):
        built = plan([("lib/token_redaction.rb", 20, 0), ("spec/lib/token_redaction_spec.rb", 40, 0)])
        self.assertEqual(weights(built)["spec/lib/token_redaction_spec.rb"], "read")

    def test_pure_deletion_demotes_and_is_annotated(self):
        built = plan([("app/jobs/sync_job.rb", 0, 120), ("app/jobs/other_job.rb", 5, 120)])
        found = {f["path"]: f for f in built["files"]}
        self.assertEqual(found["app/jobs/sync_job.rb"]["weight"], "skim")
        self.assertIn("pure deletion - check for dangling references",
                      found["app/jobs/sync_job.rb"]["notes"])
        self.assertEqual(found["app/jobs/other_job.rb"]["weight"], "read")

    def test_mechanical_wiring_collapses_five_tiny_files_of_one_rule(self):
        built = plan([(f"app/serializers/s{i}.rb", 1, 0) for i in range(5)] +
                     [("app/controllers/big_controller.rb", 90, 0)])
        self.assertTrue(all(w == "skim" for p, w in weights(built).items() if "/s" in p))
        self.assertEqual([q["kind"] for q in built["questions"]], ["wiring"])

    def test_mechanical_wiring_never_demotes_critical(self):
        built = plan([(f"app/serializers/s{i}.rb", 1, 0) for i in range(5)] +
                     [("Gemfile", 1, 0), ("config/permissions.json", 2, 0)])
        self.assertEqual(weights(built)["Gemfile"], "critical")
        self.assertEqual(weights(built)["config/permissions.json"], "critical")

    def test_mechanical_wiring_needs_a_shared_rule(self):
        built = plan([("app/jobs/a.rb", 1, 0), ("app/helpers/b.rb", 1, 0),
                      ("config/routes.rb", 1, 0), ("app/serializers/c.rb", 1, 0),
                      ("docs/API.md", 1, 0)])
        self.assertEqual(built["questions"], [])

    def test_spotlight_promotes_a_tiny_change_in_a_focused_pr(self):
        built = plan([("app/models/user.rb", 1, 1), ("spec/models/user_spec.rb", 20, 0)])
        self.assertEqual(weights(built)["app/models/user.rb"], "critical")

    def test_spotlight_does_not_fire_in_a_wide_pr(self):
        built = plan([("app/models/user.rb", 1, 1)] +
                     [(f"app/services/s{i}.rb", 40, 0) for i in range(3)])
        self.assertEqual(weights(built)["app/models/user.rb"], "read")

    def test_coverage_removed_is_flagged(self):
        built = plan([("spec/requests/a_spec.rb", 10, 300)])
        self.assertIn("coverage removed - intentional?", built["files"][0]["notes"])
        self.assertIn("coverage", [q["kind"] for q in built["questions"]])

    def test_generated_files_report_their_delta_without_being_read(self):
        built = plan([("db/schema.rb", 30, 1)])
        self.assertEqual(weights(built)["db/schema.rb"], "skip")
        self.assertEqual([q["kind"] for q in built["questions"]], ["generated"])

    def test_oversized_change_raises_a_question(self):
        built = plan([(f"app/services/s{i}.rb", 40, 0) for i in range(30)])
        self.assertIn("oversized", [q["kind"] for q in built["questions"]])


class NeverDemote(unittest.TestCase):
    """`never_demote` rules accept promotion but refuse every demotion."""

    def test_a_two_line_model_change_is_not_mechanical_wiring(self):
        built = plan([(f"app/models/m{i}.rb", 2, 0) for i in range(6)])
        self.assertTrue(all(w == "read" for w in weights(built).values()))
        self.assertEqual(built["questions"], [])

    def test_a_deleted_model_keeps_its_weight_but_still_gets_the_warning(self):
        built = plan([("app/models/setting.rb", 0, 4)])
        self.assertEqual(built["files"][0]["weight"], "read")
        self.assertIn("pure deletion - check for dangling references", built["files"][0]["notes"])

    def test_models_of_an_identical_shape_are_not_folded_away(self):
        built = plan([(f"app/models/m{i}.rb", 7, 0) for i in range(5)])
        self.assertEqual(built["stats"]["folded"], 0)
        self.assertEqual(len(built["order"]), 5)

    def test_promotion_still_reaches_a_protected_rule(self):
        built = plan([("app/models/user.rb", 1, 1), ("spec/models/user_spec.rb", 20, 0)])
        self.assertEqual(weights(built)["app/models/user.rb"], "critical")


class GeneratedQuestions(unittest.TestCase):
    """A generated file earns a question only when its delta is not already explained."""

    def test_schema_paired_with_a_migration_says_nothing(self):
        built = plan([("db/schema.rb", 30, 1), ("db/migrate/20260101_add_x.rb", 12, 0)])
        self.assertEqual([q["kind"] for q in built["questions"]], [])

    def test_schema_without_a_migration_is_suspicious(self):
        built = plan([("db/schema.rb", 30, 1)])
        self.assertEqual([q["kind"] for q in built["questions"]], ["generated"])

    def test_a_shrinking_schema_is_asked_about_even_with_a_migration(self):
        built = plan([("db/schema.rb", 0, 40), ("db/migrate/20260101_drop_x.rb", 9, 0)])
        self.assertIn("loses 40 lines", built["questions"][0]["text"])

    def test_brakeman_asks_about_added_ignores_only(self):
        self.assertEqual(plan([("config/brakeman.ignore", 0, 21)])["questions"], [])
        self.assertEqual([q["kind"] for q in plan([("config/brakeman.ignore", 4, 0)])["questions"]],
                         ["generated"])

    def test_a_shrinking_api_snapshot_is_asked_about(self):
        self.assertEqual(plan([("swagger/v1/swagger.json", 40, 2)])["questions"], [])
        self.assertIn("loses 136 lines",
                      plan([("swagger/v1/swagger.json", 28, 136)])["questions"][0]["text"])


class PlanShape(unittest.TestCase):
    def test_order_holds_only_unfolded_critical_and_read(self):
        built = plan([("db/migrate/1_x.rb", 9, 0), ("app/models/user.rb", 9, 0),
                      ("spec/models/user_spec.rb", 9, 0)] +
                     [(f"config/locales/{x}.yml", 7, 0) for x in "abc"])
        self.assertEqual(built["order"], ["db/migrate/1_x.rb", "app/models/user.rb"])

    def test_groups_cover_every_file_exactly_once(self):
        built = plan([("db/migrate/1_x.rb", 9, 0), ("app/models/user.rb", 9, 0),
                      ("config/locales/en.yml", 4, 0), ("Gemfile.lock", 2, 0)])
        grouped = [p for group in built["groups"] for p in group["files"]]
        self.assertEqual(sorted(grouped), sorted(f["path"] for f in built["files"]))

    def test_critical_sorts_before_read_before_skim_before_skip(self):
        built = plan([("config/locales/en.yml", 4, 0), ("spec/models/a_spec.rb", 9, 0),
                      ("app/models/user.rb", 9, 0), ("db/migrate/1_x.rb", 9, 0)])
        self.assertEqual([g["weight"] for g in built["groups"]],
                         ["critical", "read", "skim", "skip"])

    def test_rank_beats_size_when_ordering_groups(self):
        """A huge request spec still reads after the small model it covers."""
        built = plan([("spec/requests/users_spec.rb", 400, 0), ("app/models/user.rb", 3, 0),
                      ("docs/DESIGN.md", 90, 0)])
        self.assertEqual(built["order"],
                         ["app/models/user.rb", "docs/DESIGN.md", "spec/requests/users_spec.rb"])

    def test_views_are_skimmed_before_unit_specs(self):
        built = plan([("spec/models/user_spec.rb", 40, 0), ("app/views/users/show.html.erb", 8, 0)])
        skim = [f["path"] for f in built["files"] if f["weight"] == "skim"]
        self.assertEqual(skim, ["app/views/users/show.html.erb", "spec/models/user_spec.rb"])


class Rendering(unittest.TestCase):
    def test_one_file_round_trips_the_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nested" / "review.html"
            path = Path(tmp) / "plan.json"
            path.write_text(json.dumps(EXAMPLE), encoding="utf-8")
            with patch.object(sys, "argv", ["render_reading.py", str(path), "-o", str(out)]):
                render_reading.main()
            self.assertEqual(sorted(p.name for p in out.parent.iterdir()), ["review.html"])
            page = out.read_text(encoding="utf-8")
            found = DATA.search(page)
            self.assertIsNotNone(found)
            self.assertEqual(json.loads(found.group(1))["stats"], EXAMPLE["stats"])
            for view in ("view-plan", "view-focus", "view-stack"):
                self.assertIn(f'id="{view}"', page)

    def test_embedded_json_cannot_close_its_script_tag(self):
        hostile = copy.deepcopy(EXAMPLE)
        hostile["files"][0]["patch"] = "</script><script>alert(1)</script>"
        page = render_reading.render(hostile)
        self.assertNotIn("<script>alert(1)", page)
        found = DATA.search(page)
        self.assertEqual(json.loads(found.group(1))["files"][0]["patch"],
                         "</script><script>alert(1)</script>")

    def test_validation_rejects_a_broken_plan(self):
        for mutate in (lambda p: p.update(format="other"),
                       lambda p: p.pop("groups"),
                       lambda p: p["files"][0].update(weight="urgent"),
                       lambda p: p["order"].append("nope.rb"),
                       lambda p: p["groups"][0]["files"].append("nope.rb"),
                       lambda p: p["files"][0].update(folded_into="nope.rb")):
            broken = copy.deepcopy(EXAMPLE)
            mutate(broken)
            with self.assertRaises(ValueError):
                render_reading.validate(broken)

    def test_example_plan_is_valid(self):
        render_reading.validate(EXAMPLE)


class SummaryRendering(unittest.TestCase):
    def test_legacy_plan_without_an_introduction_still_renders(self):
        legacy = copy.deepcopy(EXAMPLE)
        legacy.pop("summary")
        render_reading.validate(legacy)
        self.assertNotIn("summary", json.loads(DATA.search(render_reading.render(legacy)).group(1)))

    def test_external_summary_is_attached_without_mutating_the_plan_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "plan.json"
            summary = Path(tmp) / "summary.json"
            out = Path(tmp) / "review.html"
            original = copy.deepcopy(EXAMPLE)
            original.pop("summary")
            source.write_text(json.dumps(original), encoding="utf-8")
            summary.write_text(json.dumps(EXAMPLE["summary"]), encoding="utf-8")
            with patch.object(sys, "argv", ["render_reading.py", str(source), "--summary",
                                            str(summary), "-o", str(out)]):
                render_reading.main()
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")), original)
            embedded = json.loads(DATA.search(out.read_text(encoding="utf-8")).group(1))
            self.assertEqual(embedded["summary"], EXAMPLE["summary"])
            self.assertEqual(embedded["order"], original["order"])

    def test_invalid_topics_and_stale_summaries_are_rejected(self):
        cases = {
            "stale revision": lambda s: s.update(head_sha="1" * 40),
            "missing revision": lambda s: s.pop("head_sha"),
            "unknown topic": lambda s: s["overview"].append({"text": "x", "topic": "missing"}),
            "duplicate id": lambda s: s["topics"].append(copy.deepcopy(s["topics"][0])),
            "unreachable topic": lambda s: s["topics"].append(
                {"id": "unused", "title": "Unused", "paragraphs": [["Unused."]]}),
            "cycle": lambda s: s["topics"][1]["paragraphs"][0].append(
                {"text": "back", "topic": "tokens"}),
            "unknown file": lambda s: s["topics"][0].update(files=["missing.rb"]),
            "empty overview": lambda s: s.update(overview=[]),
            "blank paragraph": lambda s: s["topics"][0].update(paragraphs=[[" "]]),
            "malformed segment": lambda s: s["overview"].append({"text": "x", "topic": []}),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                broken = copy.deepcopy(EXAMPLE)
                mutate(broken["summary"])
                with self.assertRaises(ValueError):
                    render_reading.validate(broken)

    def test_summary_prose_round_trips_without_becoming_executable_markup(self):
        hostile = copy.deepcopy(EXAMPLE)
        payload = '</script><img src=x onerror="alert(1)"> @@CORE_JS@@'
        hostile["summary"]["overview"].append(payload)
        render_reading.validate(hostile)
        page = render_reading.render(hostile)
        self.assertNotIn('<img src=x', page)
        self.assertEqual(json.loads(DATA.search(page).group(1))["summary"]["overview"][-1], payload)


STACK_MANIFEST = SKILL / "assets/example-stack/stack.json"
STACK_DATA = re.compile(r'<script type="application/json" id="stack">(.*?)</script>', re.S)


class StackRendering(unittest.TestCase):
    def manifest(self, tmp, prs, **extra):
        path = Path(tmp) / "stack.json"
        path.write_text(json.dumps({"prs": prs, **extra}), encoding="utf-8")
        return path

    def plans(self):
        source = json.loads(STACK_MANIFEST.read_text(encoding="utf-8"))
        return [json.loads((STACK_MANIFEST.parent / pr["plan"]).read_text(encoding="utf-8"))
                for pr in source["prs"]]

    def test_example_stack_renders_every_pr_into_one_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "stack.html"
            with patch.object(sys, "argv", ["render_reading.py", "--stack", str(STACK_MANIFEST),
                                            "-o", str(out)]):
                render_reading.main()
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["stack.html"])
            page = out.read_text(encoding="utf-8")
            self.assertIsNone(DATA.search(page), "a stack page embeds the stack, not one plan")
            stack = json.loads(STACK_DATA.search(page).group(1))
            self.assertEqual(stack["format"], "human-review/stack@1")
            self.assertEqual([pr["id"] for pr in stack["prs"]],
                             ["pr-411", "pr-412", "pr-413", "pr-414"])
            self.assertEqual([pr["parent"] for pr in stack["prs"]],
                             [None, "pr-411", "pr-412", "pr-412"])
            self.assertNotIn("<!--template", page)
            self.assertNotIn("@@", page.split('id="stack">')[0])
            self.assertIn("<title>Account API keys, as a stack · human review</title>", page)

    def test_single_plan_pages_keep_the_plan_script_and_drop_template_notes(self):
        page = render_reading.render(EXAMPLE)
        self.assertIsNotNone(DATA.search(page))
        self.assertIsNone(STACK_DATA.search(page))
        self.assertNotIn("<!--template", page)

    def test_parent_is_inferred_from_branches_and_trunk_from_the_lowest_base(self):
        lower, upper = self.plans()[:2]
        with tempfile.TemporaryDirectory() as tmp:
            path = self.manifest(tmp, [{"plan": lower}, {"plan": upper}])
            stack = render_reading.load_stack(path)
        self.assertEqual([pr["id"] for pr in stack["prs"]], ["pr-411", "pr-412"])
        self.assertEqual(stack["prs"][1]["parent"], "pr-411")
        self.assertIsNone(stack["prs"][0]["parent"])
        self.assertEqual(stack["trunk"], "main")
        self.assertEqual(stack["title"], "Stack of 2 PRs on main")

    def test_an_external_summary_is_attached_and_validated_per_pr(self):
        lower = self.plans()[0]
        summary = lower.pop("summary")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "s.json").write_text(json.dumps(summary), encoding="utf-8")
            stack = render_reading.load_stack(self.manifest(tmp, [{"plan": lower, "summary": "s.json"}]))
            self.assertEqual(stack["prs"][0]["plan"]["summary"], summary)
            stale = dict(summary, head_sha="f" * 40)
            with self.assertRaises(ValueError):
                render_reading.load_stack(self.manifest(tmp, [{"plan": lower, "summary": stale}]))

    def test_a_broken_stack_is_rejected(self):
        lower, upper = self.plans()[:2]
        cases = {
            "empty": [],
            "duplicate id": [{"id": "a", "plan": lower}, {"id": "a", "plan": upper, "parent": None}],
            "unknown parent": [{"plan": lower, "parent": "pr-999"}],
            "parent listed after child": [{"plan": upper, "parent": "pr-411"}, {"plan": lower}],
            "unsafe id": [{"id": "a b\"", "plan": lower}],
            "invalid plan": [{"plan": dict(lower, format="other")}],
            "missing plan": [{"id": "x"}],
        }
        for name, prs in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError):
                    render_reading.load_stack(self.manifest(tmp, prs))

    def test_stack_data_cannot_close_its_script_tag(self):
        lower = self.plans()[0]
        lower["files"][0]["patch"] = "</script><script>alert(1)</script>"
        with tempfile.TemporaryDirectory() as tmp:
            stack = render_reading.load_stack(self.manifest(tmp, [{"plan": lower}]))
        page = render_reading.render(None, stack)
        self.assertNotIn("<script>alert(1)", page)
        self.assertEqual(json.loads(STACK_DATA.search(page).group(1))["prs"][0]["plan"]["files"][0]["patch"],
                         "</script><script>alert(1)</script>")

    def test_stack_title_is_escaped_in_the_page_title(self):
        lower = self.plans()[0]
        with tempfile.TemporaryDirectory() as tmp:
            stack = render_reading.load_stack(self.manifest(
                tmp, [{"plan": lower}], title="</title><script>alert(1)</script>"))
        page = render_reading.render(None, stack)
        self.assertNotIn("<script>alert(1)", page)
        self.assertIn("&lt;/title&gt;", page)

    def test_plan_and_stack_are_mutually_exclusive(self):
        for argv in (["render_reading.py"],
                     ["render_reading.py", "plan.json", "--stack", "stack.json"],
                     ["render_reading.py", "--stack", "stack.json", "--summary", "s.json"]):
            with self.subTest(argv=argv), patch.object(sys, "argv", argv), \
                    patch("sys.stderr"), self.assertRaises(SystemExit):
                render_reading.main()


if __name__ == "__main__":
    unittest.main()
