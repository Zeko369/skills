#!/usr/bin/env python3
"""Render a standalone, offline review page from report.json using only the Python standard library."""
import argparse
import copy
import hashlib
import html
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


ASSETS = Path(__file__).resolve().parent.parent / "assets"
THEMES = {path.stem: path for path in sorted((ASSETS / "themes").glob("*.html"))}
DEFAULT_THEME = "train"
DISPOSITIONS = {"confirmed", "disputed", "rejected", "needs validation"}
STATES = {"completed", "failed", "timed_out", "unavailable", "not_run", "cancelled", "running", "stale"}
TOKEN = re.compile(r"@@([A-Z_]+)@@")
STATUS_NOTES = {
    "complete": "All listed reviewers completed against the same verified snapshot. Findings still require the decisions shown below.",
    "incomplete": "Incomplete review: missing, stale, or unverified coverage remains. Do not treat this report as review clearance.",
    "setup": "Setup walkthrough only. This page does not claim a completed project review.",
}


def is_text(value):
    return isinstance(value, str) and value.strip() != ""


def check_url(url, context):
    if urlsplit(str(url)).scheme not in {"http", "https"}:
        raise ValueError(f"{context} must use http or https; put local evidence paths in finding text")


def finding_prs(finding):
    prs = finding.get("prs", finding.get("pr", []))
    if prs is None:
        return []
    return [prs] if isinstance(prs, str) else prs


def validate_stack(stack):
    if not isinstance(stack, list):
        raise ValueError("stack must be an array of pull requests")
    parents = {}
    for entry in stack:
        if not isinstance(entry, dict) or not is_text(entry.get("id")) or not is_text(entry.get("title")):
            raise ValueError("Every stack entry needs a nonempty id and title")
        if entry["id"] in parents:
            raise ValueError(f"Duplicate stack PR id: {entry['id']}")
        if entry.get("url"):
            check_url(entry["url"], f"Stack PR {entry['id']} url")
        parents[entry["id"]] = entry.get("parent")
    for pr_id, parent in parents.items():
        if parent is not None and parent not in parents:
            raise ValueError(f"Stack PR {pr_id} has unknown parent {parent}")
        seen, current = set(), pr_id
        while current is not None:
            if current in seen:
                raise ValueError(f"Stack parents form a cycle at {pr_id}")
            seen.add(current)
            current = parents[current]
    return set(parents)


def validate(data):
    for key in ("title", "verdict", "summary", "status", "generated_at", "target", "reviewers", "findings", "checks", "gaps", "next_steps"):
        if key not in data:
            raise ValueError(f"Missing required report field: {key}")
    if data["status"] not in STATUS_NOTES:
        raise ValueError("status must be complete, incomplete, or setup")
    if not isinstance(data["target"], dict):
        raise ValueError("target must be an object of labels and values")
    for field in ("reviewers", "findings", "checks", "gaps", "next_steps"):
        if not isinstance(data[field], list):
            raise ValueError(f"{field} must be an array")
    for reviewer in data["reviewers"]:
        for field in ("name", "model", "effort", "transport", "status", "provenance"):
            if field not in reviewer:
                raise ValueError(f"Reviewer missing {field}")
        if reviewer["status"] not in STATES:
            raise ValueError(f"Unknown reviewer state: {reviewer['status']}")
    if data["status"] == "complete":
        if not data["reviewers"] or any(r["status"] != "completed" for r in data["reviewers"]):
            raise ValueError("A complete report requires all listed reviewers to have completed; otherwise use incomplete")
        snapshot = data.get("snapshot_id")
        if not is_text(snapshot) or data.get("snapshot_verified") is not True:
            raise ValueError("A complete report requires a verified target snapshot_id")
        if any(r.get("snapshot_id") != snapshot or r.get("snapshot_verified") is not True for r in data["reviewers"]):
            raise ValueError("Every reviewer must verify the same target snapshot; otherwise use incomplete")
    stack_ids = validate_stack(data.get("stack", []))
    ids = set()
    for finding in data["findings"]:
        for field in ("id", "title", "severity", "disposition", "location", "trigger", "impact", "evidence", "recommendation", "confidence", "reviewers", "decision"):
            if field not in finding:
                raise ValueError(f"Finding missing {field}")
        if finding["severity"] not in {"P0", "P1", "P2", "P3"} or finding["disposition"] not in DISPOSITIONS:
            raise ValueError("Invalid finding severity or disposition")
        if not isinstance(finding["reviewers"], list):
            raise ValueError("Finding reviewers must be an array")
        if finding["id"] in ids:
            raise ValueError(f"Duplicate finding ID: {finding['id']}")
        ids.add(finding["id"])
        prs = finding_prs(finding)
        if not isinstance(prs, list) or not all(isinstance(p, str) for p in prs):
            raise ValueError(f"Finding {finding['id']} pr/prs must be a stack id or an array of stack ids")
        unknown = [p for p in prs if p not in stack_ids]
        if unknown:
            raise ValueError(f"Finding {finding['id']} references unknown stack PR: {', '.join(unknown)}")
        tags = finding.get("tags", [])
        if not isinstance(tags, list) or not all(is_text(t) for t in tags):
            raise ValueError(f"Finding {finding['id']} tags must be an array of strings")
    for link in data.get("sources", []):
        check_url(link["url"], "Source links")


def normalize(data):
    """Return the page payload: validated input plus derived fields the themes rely on."""
    page = copy.deepcopy(data)
    page.setdefault("stack", [])
    page.setdefault("notes", [])
    page.setdefault("sources", [])
    for finding in page["findings"]:
        finding["prs"] = finding_prs(finding)
        finding.pop("pr", None)
        finding["tags"] = finding.get("tags", [])
        finding["confidence"] = str(finding["confidence"])
    target = [[str(k), str(v)] for k, v in page["target"].items()]
    if len(page["stack"]) == 1:
        # A one-PR review shows no stack views, so the PR itself becomes part of the target.
        pr = page["stack"][0]
        number = f"#{pr['number']} " if pr.get("number") is not None else ""
        branch = " into ".join(str(b) for b in (pr.get("branch"), pr.get("base")) if b)
        known = {k.strip().lower() for k, _ in target}
        solo = [[k, str(v)] for k, v in (("Pull request", f"{number}{pr['title']}"), ("Branch", branch), ("Head", pr.get("head"))) if v and k.lower() not in known]
        target = solo + target
        if pr.get("url") and all(link["url"] != pr["url"] for link in page["sources"]):
            page["sources"].insert(0, {"title": f"{number}{pr['title']}", "url": pr["url"]})
    if page.get("snapshot_id"):
        target.append(["Reviewed snapshot", str(page["snapshot_id"])])
        target.append(["Coordinator input verification", "verified" if page.get("snapshot_verified") is True else "unverified"])
    page["target"] = target
    findings = page["findings"]
    identity = json.dumps([page["title"], page["generated_at"], page.get("snapshot_id"), sorted(f["id"] for f in findings)], sort_keys=True)
    page["meta"] = {
        "key": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16],
        "status_note": STATUS_NOTES[page["status"]],
        "empty_message": "No supported findings were recorded." if page["status"] == "complete" else "No findings recorded. This is not evidence of a clean completed review.",
        "completed": sum(r["status"] == "completed" for r in page["reviewers"]),
        "confirmed": sum(f["disposition"] == "confirmed" for f in findings),
        "unresolved": sum(f["disposition"] in {"disputed", "needs validation"} for f in findings),
    }
    return page


def script_json(value):
    """JSON that is inert inside <script type="application/json">."""
    text = json.dumps(value, ensure_ascii=False, indent=None, separators=(",", ":"))
    for raw, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"), (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(raw, escaped)
    return text


def render(data, theme=DEFAULT_THEME):
    validate(data)
    if theme not in THEMES:
        raise ValueError(f"Unknown theme {theme!r}; choose from {', '.join(THEMES)}")
    page = normalize(data)
    values = {
        "TITLE": html.escape(page["title"], quote=True),
        "THEME": theme,
        "DATA": script_json(page),
        "CORE_CSS": (ASSETS / "core.css").read_text(encoding="utf-8"),
        "CORE_JS": (ASSETS / "core.js").read_text(encoding="utf-8"),
    }

    def substitute(match):
        if match.group(1) not in values:
            raise ValueError(f"Theme {theme} uses unknown placeholder {match.group(0)}")
        return values[match.group(1)]

    # One pass, so placeholder-like text inside report data is never substituted again.
    return TOKEN.sub(substitute, THEMES[theme].read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="page to write")
    parser.add_argument("--theme", choices=sorted(THEMES), default=DEFAULT_THEME, help=f"design (default: {DEFAULT_THEME})")
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")
    try:
        page = render(json.loads(args.input.read_text(encoding="utf-8")), args.theme)
    except (ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page, encoding="utf-8")
    print(args.output.resolve())


if __name__ == "__main__":
    main()
