#!/usr/bin/env python3
"""Render a standalone review page using only the Python standard library."""
import argparse
import html
import json
from pathlib import Path
from string import Template
from urllib.parse import urlsplit


DISPOSITIONS = {"confirmed", "disputed", "rejected", "needs validation"}
STATES = {"completed", "failed", "timed_out", "unavailable", "not_run", "cancelled", "running", "stale"}


def esc(value):
    return html.escape(str(value), quote=True)


def text_list(items):
    return "<ul>" + "".join(f"<li>{esc(item)}</li>" for item in items) + "</ul>" if items else "<p class='muted'>None recorded.</p>"


def validate(data):
    for key in ("title", "verdict", "summary", "status", "generated_at", "target", "reviewers", "findings", "checks", "gaps", "next_steps"):
        if key not in data:
            raise ValueError(f"Missing required report field: {key}")
    if data["status"] not in {"complete", "incomplete", "setup"}:
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
        if not isinstance(snapshot, str) or not snapshot.strip() or data.get("snapshot_verified") is not True:
            raise ValueError("A complete report requires a verified target snapshot_id")
        if any(r.get("snapshot_id") != snapshot or r.get("snapshot_verified") is not True for r in data["reviewers"]):
            raise ValueError("Every reviewer must verify the same target snapshot; otherwise use incomplete")
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


def reviewer_card(reviewer):
    extra = "".join(f"<p><strong>{esc(label)}:</strong> {esc(reviewer[key])}</p>" for key, label in (("run_id", "Task / process"), ("round", "Round"), ("provider_status", "Provider state"), ("snapshot_id", "Reviewed snapshot"), ("limitations", "Limits")) if reviewer.get(key))
    if "snapshot_verified" in reviewer:
        extra += f"<p><strong>Snapshot verification:</strong> {'verified' if reviewer['snapshot_verified'] is True else 'unverified'}</p>"
    raw = f"<details><summary>Reviewer output</summary><pre>{esc(reviewer['output'])}</pre></details>" if reviewer.get("output") else ""
    return f"""<article class="reviewer"><div class="eyebrow">{esc(reviewer['transport'])}</div>
<h3>{esc(reviewer['name'])}</h3><p class="model">{esc(reviewer['model'])}</p>
<div class="tags"><span>{esc(reviewer['effort'])} effort</span><span class="state state-{esc(reviewer['status'])}">{esc(reviewer['status'].replace('_', ' '))}</span></div>
<p>{esc(reviewer['provenance'])}</p>{extra}{raw}</article>"""


def finding_card(finding, index):
    rows = "".join(f"<dt>{esc(label)}</dt><dd>{esc(finding.get(key, 'Not recorded.'))}</dd>" for key, label in (
        ("location", "Location"), ("trigger", "Trigger"), ("impact", "Impact"), ("evidence", "Evidence"),
        ("recommendation", "Suggested correction"), ("decision", "Coordinator decision"), ("validation", "Validation limits")))
    return f"""<article class="finding" data-disposition="{esc(finding['disposition'])}" id="finding-{index}">
<div class="finding-top"><span class="severity {esc(finding['severity'])}">{esc(finding['severity'])}</span>
<span class="disposition">{esc(finding['disposition'])}</span><span class="finding-id">{esc(finding['id'])}</span></div>
<h3>{esc(finding['title'])}</h3><p>{esc(finding['impact'])}</p>
<p class="muted">Raised by {esc(', '.join(finding['reviewers']))} · {esc(finding['confidence'])} confidence</p>
<details><summary>Evidence &amp; decision</summary><dl>{rows}</dl></details></article>"""


def safe_link(link):
    url = str(link["url"])
    if urlsplit(url).scheme not in {"http", "https"}:
        raise ValueError("Source links must use http or https; put local evidence paths in finding text")
    return f'<li><a href="{esc(url)}" rel="noreferrer">{esc(link["title"])}</a></li>'


def render(data):
    validate(data)
    findings = sorted(data["findings"], key=lambda item: (item["disposition"] == "rejected", item["severity"], str(item["id"])))
    confirmed = sum(f["disposition"] == "confirmed" for f in findings)
    unresolved = sum(f["disposition"] in {"disputed", "needs validation"} for f in findings)
    completed = sum(r["status"] == "completed" for r in data["reviewers"])
    empty = "No supported findings were recorded." if data["status"] == "complete" else "No findings recorded. This is not evidence of a clean completed review."
    status_note = {
        "complete": "All listed reviewers completed against the same verified snapshot. Findings still require the decisions shown below.",
        "incomplete": "Incomplete review: missing, stale, or unverified coverage remains. Do not treat this report as review clearance.",
        "setup": "Setup walkthrough only. This page does not claim a completed project review.",
    }[data["status"]]
    target = dict(data["target"])
    if data.get("snapshot_id"):
        target["Reviewed snapshot"] = data["snapshot_id"]
        target["Coordinator input verification"] = "verified" if data.get("snapshot_verified") is True else "unverified"
    template = Template((Path(__file__).resolve().parent.parent / "assets" / "report.html").read_text(encoding="utf-8"))
    return template.substitute(
        title=esc(data["title"]), verdict=esc(data["verdict"]), summary=esc(data["summary"]),
        status=esc(data["status"]), status_note=esc(status_note), generated_at=esc(data["generated_at"]),
        target="".join(f"<dt>{esc(key)}</dt><dd>{esc(value)}</dd>" for key, value in target.items()),
        reviewers="".join(reviewer_card(r) for r in data["reviewers"]), completed=completed, total=len(data["reviewers"]),
        confirmed=confirmed, unresolved=unresolved, finding_count=len(findings),
        findings="".join(finding_card(f, i) for i, f in enumerate(findings)) or f"<p class='empty'>{empty}</p>",
        checks=text_list(data["checks"]), gaps=text_list(data["gaps"]), next_steps=text_list(data["next_steps"]),
        notes="".join(f"<article><h3>{esc(n['title'])}</h3><p>{esc(n['body'])}</p></article>" for n in data.get("notes", [])),
        sources="<ul>" + "".join(safe_link(link) for link in data.get("sources", [])) + "</ul>" if data.get("sources") else "",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")
    try:
        result = render(json.loads(args.input.read_text(encoding="utf-8")))
    except (ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result, encoding="utf-8")
    print(args.output.resolve())


if __name__ == "__main__":
    main()
