#!/usr/bin/env python3
"""Render a reading plan as one offline HTML file.

    render_reading.py reading-plan.json --summary pr-summary.json -o review.html
    render_reading.py --stack stack.json -o review.html

The page holds every view - the reading plan, focus mode, and for a stack the stack
overview - and switches between them in place; the URL hash says which is showing.
With --stack, every PR goes into that one file, with a stack bar linking them. See
references/stack.md for the manifest.
"""

import argparse
import html
import json
import re
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
TEMPLATE = ASSETS / "review.html"
TOKEN = re.compile(r"@@([A-Z_]+)@@")
# Authoring notes at the top of a template; removed before substitution.
TEMPLATE_NOTE = re.compile(r"<!--template\b.*?-->\n?", re.S)
PR_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
WEIGHTS = ("critical", "read", "skim", "skip")


def validate(plan):
    if plan.get("format") != "human-review/plan@1":
        raise ValueError("Not a human-review/plan@1 document")
    for key in ("target", "stats", "groups", "files", "order", "questions"):
        if key not in plan:
            raise ValueError(f"Missing required key {key!r}")
    paths = {f["path"] for f in plan["files"]}
    for entry in plan["files"]:
        if entry.get("weight") not in WEIGHTS:
            raise ValueError(f"{entry['path']}: bad weight {entry.get('weight')!r}")
        folded = entry.get("folded_into")
        if folded and folded not in paths:
            raise ValueError(f"{entry['path']}: folded into unknown path {folded!r}")
    for group in plan["groups"]:
        for path in group["files"]:
            if path not in paths:
                raise ValueError(f"group {group['key']}: unknown file {path!r}")
    for path in plan["order"]:
        if path not in paths:
            raise ValueError(f"order: unknown file {path!r}")
    if "summary" in plan:
        validate_summary(plan["summary"], plan["target"], paths)


def validate_summary(summary, target, paths):
    """Check the authored topic graph before it becomes an interactive introduction."""
    if not isinstance(summary, dict):
        raise ValueError("summary must be an object")
    if not summary.get("head_sha") or summary["head_sha"] != target.get("head_sha"):
        raise ValueError("summary.head_sha must match target.head_sha; regenerate the introduction")
    topics = summary.get("topics")
    if not isinstance(topics, list):
        raise ValueError("summary.topics must be a list")
    by_id = {}
    for topic in topics:
        if not isinstance(topic, dict):
            raise ValueError("summary topics must be objects")
        key = topic.get("id")
        if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", key):
            raise ValueError("summary topic ids must be lowercase slugs")
        if key in by_id:
            raise ValueError(f"summary: duplicate topic {key!r}")
        if not isinstance(topic.get("title"), str) or not topic["title"].strip():
            raise ValueError(f"summary topic {key!r} needs a title")
        files = topic.get("files", [])
        if not isinstance(files, list) or any(not isinstance(p, str) or p not in paths for p in files):
            raise ValueError(f"summary topic {key!r} references an unknown file")
        by_id[key] = topic

    def links(paragraph):
        if not isinstance(paragraph, list) or not paragraph:
            raise ValueError("summary paragraphs must be nonempty lists of text and topic links")
        references, text = [], []
        for part in paragraph:
            if isinstance(part, str):
                text.append(part)
            elif (isinstance(part, dict) and isinstance(part.get("text"), str)
                  and part["text"].strip() and isinstance(part.get("topic"), str)):
                if part["topic"] not in by_id:
                    raise ValueError(f"summary: unknown topic {part['topic']!r}")
                references.append(part["topic"])
                text.append(part["text"])
            else:
                raise ValueError("summary segments must be text or {text, topic} objects")
        if not "".join(text).strip():
            raise ValueError("summary paragraphs cannot be blank")
        return references

    roots = links(summary.get("overview"))
    graph = {}
    for key, topic in by_id.items():
        paragraphs = topic.get("paragraphs")
        if not isinstance(paragraphs, list) or not paragraphs:
            raise ValueError(f"summary topic {key!r} needs paragraphs")
        graph[key] = [ref for paragraph in paragraphs for ref in links(paragraph)]

    visited, active = set(), set()

    def visit(key):
        if key in active:
            raise ValueError(f"summary: topic cycle at {key!r}")
        if key in visited:
            return
        active.add(key)
        for child in graph[key]:
            visit(child)
        active.remove(key)
        visited.add(key)

    for key in roots:
        visit(key)
    if visited != set(by_id):
        raise ValueError("summary: every topic must be reachable from the overview")


def script_json(value):
    """JSON that is inert inside <script type="application/json">."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for raw, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(raw, escaped)
    return text


def load_stack(manifest_path):
    """Read a stack manifest and the plans and summaries it points at, bottom-up.

    Paths in the manifest are relative to the manifest. A `plan` or `summary` may also be
    given inline as an object. Missing ids default to pr-<number>; a missing parent is
    found by matching the PR's base branch to another PR's head branch.
    """
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("prs"), list) or not manifest["prs"]:
        raise ValueError("stack manifest needs a nonempty prs list")

    def load(value, what, index):
        if isinstance(value, dict):
            return value
        if not isinstance(value, str) or not value:
            raise ValueError(f"stack prs[{index}]: {what} must be a path or an object")
        return json.loads((manifest_path.parent / value).read_text(encoding="utf-8"))

    prs = []
    for index, item in enumerate(manifest["prs"]):
        if not isinstance(item, dict) or "plan" not in item:
            raise ValueError(f"stack prs[{index}] needs a plan")
        plan = load(item["plan"], "plan", index)
        if item.get("summary") is not None:
            plan["summary"] = load(item["summary"], "summary", index)
        validate(plan)
        number = plan["target"].get("number")
        pr_id = item.get("id") or (f"pr-{number}" if number else f"pr-{index + 1}")
        if not isinstance(pr_id, str) or not PR_ID.fullmatch(pr_id):
            raise ValueError(f"stack prs[{index}]: id {pr_id!r} must be a short slug")
        prs.append({"id": pr_id, "parent": item.get("parent", "infer"), "plan": plan})

    ids = [pr["id"] for pr in prs]
    if len(set(ids)) != len(ids):
        raise ValueError("stack: duplicate PR id")
    branches = {pr["plan"]["target"].get("branch"): pr["id"] for pr in prs
                if pr["plan"]["target"].get("branch")}
    for position, pr in enumerate(prs):
        if pr["parent"] == "infer":
            parent = branches.get(pr["plan"]["target"].get("base"))
            pr["parent"] = parent if parent != pr["id"] else None
        if pr["parent"] is None:
            continue
        if pr["parent"] not in ids:
            raise ValueError(f"stack: {pr['id']} has unknown parent {pr['parent']!r}")
        # Bottom-up means a parent is always listed first, which also rules out cycles.
        if ids.index(pr["parent"]) >= position:
            raise ValueError(f"stack: list {pr['parent']} before {pr['id']} (bottom of the stack first)")

    trunk = manifest.get("trunk") or next(
        (pr["plan"]["target"].get("base") for pr in prs if pr["parent"] is None), None) or "main"
    title = manifest.get("title") or f"Stack of {len(prs)} PRs on {trunk}"
    return {"format": "human-review/stack@1", "title": title, "trunk": trunk, "prs": prs}


def title_of(plan):
    target = plan["target"]
    label = target.get("title") or target.get("range") or "Change"
    if target.get("number"):
        label = f"#{target['number']} {label}"
    return label


def render(plan, stack=None):
    """The page. With `stack`, `plan` is ignored and every PR is embedded."""
    label = stack["title"] if stack else title_of(plan)
    values = {
        "TITLE": html.escape(f"{label} · human review", quote=True),
        "DATA_ID": "stack" if stack else "plan",
        "DATA": script_json(stack if stack else plan),
        "CORE_CSS": (ASSETS / "core.css").read_text(encoding="utf-8"),
        "CORE_JS": (ASSETS / "core.js").read_text(encoding="utf-8"),
    }

    def substitute(match):
        if match.group(1) not in values:
            raise ValueError(f"review.html uses unknown placeholder {match.group(0)}")
        return values[match.group(1)]

    # One pass, so placeholder-like text inside the plan is never substituted again.
    template = TEMPLATE_NOTE.sub("", TEMPLATE.read_text(encoding="utf-8"), count=1)
    return TOKEN.sub(substitute, template)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("plan", nargs="?", help="reading-plan.json (omit with --stack)")
    parser.add_argument("--summary", help="agent-authored introduction JSON (see references/summary.md)")
    parser.add_argument("--stack", help="stack manifest listing every PR's plan and summary "
                                        "(see references/stack.md)")
    parser.add_argument("-o", "--output", default="review.html", help="HTML file to write")
    args = parser.parse_args()
    if bool(args.plan) == bool(args.stack):
        parser.error("give either a plan or --stack")
    if args.stack and args.summary:
        parser.error("with --stack, set each PR's summary in the manifest")

    stack = plan = None
    if args.stack:
        stack = load_stack(args.stack)
    else:
        plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
        if args.summary:
            plan["summary"] = json.loads(Path(args.summary).read_text(encoding="utf-8"))
        validate(plan)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(plan, stack), encoding="utf-8")
    print(out.resolve())


if __name__ == "__main__":
    main()
