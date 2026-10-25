#!/usr/bin/env python3
"""Turn a change into a reading plan: what a human must read, skim, or skip.

    plan_reading.py --pr 412 --repo-path ~/work/app -o reading-plan.json
    plan_reading.py --range main...HEAD --repo-path . -o reading-plan.json

Rules are deterministic and run first. The agent then authors the layered introduction
for render_reading.py; it never silently demotes what the config marked critical.
"""

import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE.parent / "configs" / "rails.json"

WEIGHTS = ["critical", "read", "skim", "skip"]
TEST_FILE = re.compile(r"(_spec\.rb|_test\.rb|\.test\.[tj]sx?|\.spec\.[tj]sx?)$")


def demote(weight, steps=1):
    return WEIGHTS[min(WEIGHTS.index(weight) + steps, len(WEIGHTS) - 1)]


def promote(weight, steps=1):
    return WEIGHTS[max(WEIGHTS.index(weight) - steps, 0)]


def rank_of(rule, index):
    """Reading order within a weight. Explicit beats position in the file."""
    if "rank" in rule:
        return rule["rank"]
    return -1 if rule.get("order") == "first" else index


def step_down(entry, note):
    """Demote and explain - unless the rule forbids it, in which case only explain.

    `never_demote` exists because a two-line change to a model is not plumbing: it is a
    change to the data contract. The advice ("check for dangling references") is still
    worth showing, so the note is attached either way.
    """
    entry["notes"].append(note)
    if not entry.get("never_demote"):
        entry["weight"] = demote(entry["weight"])


def glob_re(pattern):
    """`**` crosses directories, `*` does not. Anchored at both ends."""
    out, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 2] == "**":
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        i += 1
    return re.compile("".join(out) + r"\Z")


def subject_of(path):
    """Bare name both sides of a test pairing agree on.

    spec/models/user_spec.rb -> user, and app/models/user.rb -> user, so a spec can be
    matched against the file it covers.
    """
    name = path.split("/")[-1]
    stripped = TEST_FILE.sub("", name)
    if stripped != name:
        return stripped
    return name.rsplit(".", 1)[0] if "." in name else name


def load_config(repo_path, explicit):
    for candidate in filter(None, [explicit,
                                   repo_path / ".claude" / "reading-rules.json",
                                   repo_path / ".reading-rules.json"]):
        candidate = Path(candidate).expanduser()
        if candidate.is_file():
            config = json.loads(candidate.read_text(encoding="utf-8"))
            config["_source"] = str(candidate)
            return config
    config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
    config["_source"] = f"{DEFAULT_CONFIG} (fallback)"
    return config


def gh(repo_path, *args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, cwd=repo_path)
    if result.returncode:
        raise SystemExit(f"gh {' '.join(args)} failed:\n{result.stderr.strip()}")
    return json.loads(result.stdout)


def from_pr(repo_path, number):
    meta = gh(repo_path, "pr", "view", str(number), "--json",
              "number,title,author,baseRefName,headRefName,headRefOid,url,isDraft,body")
    slug = subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                          capture_output=True, text=True, cwd=repo_path).stdout.strip()
    files, page = [], 1
    while True:
        batch = gh(repo_path, "api", f"repos/{slug}/pulls/{number}/files?per_page=100&page={page}")
        files.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    target = {
        "kind": "pr", "repo": slug, "number": meta["number"], "title": meta["title"],
        "author": meta["author"]["login"], "base": meta["baseRefName"], "branch": meta["headRefName"],
        "head_sha": meta["headRefOid"], "url": meta["url"], "draft": meta["isDraft"],
    }
    return target, [{"path": f["filename"], "add": f["additions"], "del": f["deletions"],
                     "status": f["status"], "patch": f.get("patch", ""),
                     "previous": f.get("previous_filename")} for f in files]


def from_range(repo_path, rev_range):
    def git(*args):
        return subprocess.run(["git", *args], capture_output=True, text=True, cwd=repo_path).stdout

    files = []
    for line in git("diff", "--numstat", rev_range).splitlines():
        add, dele, path = (line.split("\t") + ["", "", ""])[:3]
        if not path:
            continue
        patch = git("diff", "--unified=3", rev_range, "--", path)
        patch = patch.split("@@", 1)
        patch = "@@" + patch[1] if len(patch) > 1 else ""
        files.append({"path": path, "add": int(add) if add.isdigit() else 0,
                      "del": int(dele) if dele.isdigit() else 0,
                      "status": "modified", "patch": patch, "previous": None})
    head = git("rev-parse", "HEAD").strip()
    return {"kind": "range", "repo": str(repo_path), "title": rev_range, "range": rev_range,
            "head_sha": head}, files


def classify(files, config):
    rules = [{**rule, "_re": [glob_re(p) for p in rule["match"]], "_rank": rank_of(rule, i)}
             for i, rule in enumerate(config["rules"])]
    mods = config.get("modifiers", {})

    for entry in files:
        for rule in rules:
            if any(pattern.match(entry["path"]) for pattern in rule["_re"]):
                entry.update(rule_id=rule["id"], weight=rule["weight"], why=rule.get("why", ""),
                             label=rule.get("label", rule["id"]), collapse=rule.get("collapse"),
                             report=rule.get("report"), rank=rule["_rank"],
                             never_demote=bool(rule.get("never_demote")))
                break
        else:
            entry.update(rule_id="other", weight="skim", why="", label="Unclassified",
                         collapse=None, report=None, rank=999, never_demote=False)
        entry["notes"] = []

    total_add = sum(e["add"] for e in files)
    total_del = sum(e["del"] for e in files)
    deletion_pr = total_del > 2 * max(total_add, 1)
    critical_subjects = {subject_of(e["path"]) for e in files
                         if e["weight"] == "critical" and not TEST_FILE.search(e["path"])}

    # A test never outranks `read`, even sitting on a critical path.
    cap = mods.get("test_caps_at", "read")
    for entry in files:
        if TEST_FILE.search(entry["path"]) and WEIGHTS.index(entry["weight"]) < WEIGHTS.index(cap):
            entry["weight"] = cap
            entry["notes"].append("test for critical code")
        # ... but a spec whose subject is critical gets pulled up to meet it.
        elif mods.get("spec_inherits_subject") and TEST_FILE.search(entry["path"]) \
                and subject_of(entry["path"]) in critical_subjects:
            entry["weight"] = promote(entry["weight"])
            entry["notes"].append("covers critical code")

    # Pure deletion is verification, not reading.
    if mods.get("pure_deletion_demotes"):
        for entry in files:
            if entry["add"] == 0 and entry["del"] > 0 and entry["weight"] in ("critical", "read"):
                step_down(entry, "pure deletion - check for dangling references")
            elif deletion_pr and entry["weight"] == "read" and entry["add"] * 4 < entry["del"]:
                entry["notes"].append("mostly removal")

    # Many near-empty edits of the same kind are wiring: collapse them into one question.
    # Never applied to `critical`: a one-line Gemfile bump is still the supply-chain event,
    # and two lines of permissions.json is still the authorization change.
    wiring = mods.get("mechanical_wiring")
    if wiring:
        tiny = defaultdict(list)
        for entry in files:
            if entry["weight"] == "read" and entry["add"] + entry["del"] <= wiring["max_lines"] \
                    and not entry["never_demote"] and not TEST_FILE.search(entry["path"]):
                tiny[entry["rule_id"]].append(entry)
        for members in tiny.values():
            if len(members) >= wiring["min_files"]:
                for entry in members:
                    entry["weight"] = "skim"
                    entry["notes"].append("mechanical wiring")
                    entry["wiring"] = True

    # A change this small in a change this focused IS the whole fix.
    spot = mods.get("spotlight")
    if spot:
        # Any production code the rules kept, whatever the project calls those directories.
        code = [e for e in files if e["weight"] == "read" and not TEST_FILE.search(e["path"])
                and not e["path"].endswith(".md")]
        if len(code) <= spot["max_code_files"]:
            for entry in code:
                if entry["add"] + entry["del"] <= spot["max_lines"]:
                    entry["weight"] = "critical"
                    entry["notes"].append("tiny change - this is the whole fix")

    ratio = (mods.get("coverage_removed") or {}).get("deletion_ratio")
    if ratio:
        for entry in files:
            if TEST_FILE.search(entry["path"]) and entry["del"] > ratio * max(entry["add"], 1):
                entry["notes"].append("coverage removed - intentional?")

    # Identical (rule, +, -) across several files is a fan-out: show one, fold the rest.
    shape = mods.get("shape_collapse", {}).get("min_files", 3)
    buckets = defaultdict(list)
    for entry in files:
        buckets[(entry["rule_id"], entry["add"], entry["del"])].append(entry)
    for members in buckets.values():
        if len(members) >= shape and not members[0]["never_demote"]:
            members.sort(key=lambda e: e["path"])
            for entry in members[1:]:
                entry["folded_into"] = members[0]["path"]
            members[0]["folds"] = len(members) - 1
    return files


def generated_question(entry, files):
    """Why a generated file is worth asking about - or None, which is the common case.

    "db/schema.rb changed" is not a question; of course it did, there is a migration. The
    question is whether it changed in a way the migrations do not explain: edited by hand,
    or shrinking, which means something upstream was dropped.
    """
    spec = entry.get("report")
    if not spec:
        return None
    if spec == "delta":
        return (f"{entry['path']} is generated: {entry['add']}+ / {entry['del']}-. "
                f"Does that delta match the change you expected?")
    pair = spec.get("unless_paired_with")
    if pair and not any(glob_re(pair).match(other["path"]) for other in files if other is not entry):
        return (f"{entry['path']} changed, but nothing here matches {pair}. "
                f"Regenerate it, or confirm it was not hand-edited.")
    limit = spec.get("deletions_over")
    if limit is not None and entry["del"] > limit:
        return (f"{entry['path']} loses {entry['del']} lines. Generated output shrinking means "
                f"something upstream was removed - confirm that was deliberate.")
    limit = spec.get("additions_over")
    if limit is not None and entry["add"] > limit:
        return (f"{entry['path']} gains {entry['add']} lines. Confirm every new entry is wanted.")
    return None


def build_questions(files, config, stats):
    questions = []
    wiring = [e for e in files if e.get("wiring")]
    if wiring:
        questions.append({
            "id": "q-wiring", "kind": "wiring",
            "text": f"{len(wiring)} files changed by one or two lines each - registration or include "
                    f"wiring. Do not read the diffs; check the list is complete.",
            "files": [e["path"] for e in wiring]})
    for entry in files:
        text = generated_question(entry, files)
        if text:
            questions.append({"id": f"q-gen-{entry['path']}", "kind": "generated",
                              "text": text, "files": [entry["path"]]})
    removed = [e for e in files if "coverage removed - intentional?" in e["notes"]]
    if removed:
        questions.append({
            "id": "q-coverage", "kind": "coverage",
            "text": (f"{len(removed)} test file{'s' if len(removed) > 1 else ''} lose"
                     f"{'' if len(removed) > 1 else 's'} far more than "
                     f"{'they' if len(removed) > 1 else 'it'} gain"
                     f"{'' if len(removed) > 1 else 's'}. Confirm the behaviour went away, "
                     f"not just its test."),
            "files": [e["path"] for e in removed]})
    limit = (config.get("oversized") or {}).get("read_files")
    if limit and stats["critical"] + stats["read"] > limit:
        questions.append({
            "id": "q-oversized", "kind": "oversized",
            "text": f"{stats['critical'] + stats['read']} files still need eyes after filtering, over "
                    f"the {limit} this project considers one sitting. Consider splitting the change.",
            "files": []})
    return questions


def build_plan(target, files, config):
    files = classify(files, config)
    rank = {w: i for i, w in enumerate(WEIGHTS)}
    files.sort(key=lambda e: (rank[e["weight"]], e["rank"], -(e["add"] + e["del"]), e["path"]))

    groups, seen = [], {}
    for entry in files:
        key = (entry["weight"], entry["rule_id"])
        if key not in seen:
            seen[key] = {"key": f"{entry['weight']}:{entry['rule_id']}", "rule": entry["rule_id"],
                         "label": entry["label"], "weight": entry["weight"], "why": entry["why"],
                         "files": []}
            groups.append(seen[key])
        seen[key]["files"].append(entry["path"])

    stats = Counter(e["weight"] for e in files)
    stats = {w: stats.get(w, 0) for w in WEIGHTS}
    stats.update(files=len(files), additions=sum(e["add"] for e in files),
                 deletions=sum(e["del"] for e in files),
                 folded=sum(1 for e in files if e.get("folded_into")))

    order = [e["path"] for e in files
             if e["weight"] in ("critical", "read") and not e.get("folded_into")]
    for entry in files:
        entry.pop("_re", None)
    return {
        "format": "human-review/plan@1",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target": target,
        "config": {"name": config.get("name", "default"), "source": config.get("_source", "")},
        "stats": stats,
        "questions": build_questions(files, config, stats),
        "groups": groups,
        "order": order,
        "files": files,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--pr", type=int, help="pull request number")
    source.add_argument("--range", dest="rev_range", help="git revision range, e.g. main...HEAD")
    parser.add_argument("--repo-path", default=".", help="repository checkout (default: .)")
    parser.add_argument("--config", help="rules file (default: <repo>/.claude/reading-rules.json)")
    parser.add_argument("-o", "--output", default="reading-plan.json")
    args = parser.parse_args()

    repo_path = Path(args.repo_path).expanduser().resolve()
    config = load_config(repo_path, args.config)
    target, files = (from_pr(repo_path, args.pr) if args.pr
                     else from_range(repo_path, args.rev_range))
    if not files:
        raise SystemExit("No changed files.")
    plan = build_plan(target, files, config)

    Path(args.output).write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n",
                                 encoding="utf-8")
    stats = plan["stats"]
    print(f"{args.output}: {stats['files']} files -> "
          f"{stats['critical']} critical, {stats['read']} read, "
          f"{stats['skim']} skim, {stats['skip']} skip "
          f"({stats['folded']} folded into fan-outs)", file=sys.stderr)


if __name__ == "__main__":
    main()
