#!/usr/bin/env python3
"""Render a reading plan as offline HTML.

    render_reading.py reading-plan.json --output-dir review/

Writes plan.html (what to read, in order), review.html (the diff + comment tool),
and index.html. Both pages read the same embedded JSON, so they stay consistent.
"""

import argparse
import html
import json
import re
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
PAGES = {
    "plan": ("Reading plan", "What to read, what to skim, what the rules folded away."),
    "review": ("Review tool", "Monaco diff per file, line comments, export as JSON."),
}
TOKEN = re.compile(r"@@([A-Z_]+)@@")
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


def script_json(value):
    """JSON that is inert inside <script type="application/json">."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for raw, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(raw, escaped)
    return text


def title_of(plan):
    target = plan["target"]
    label = target.get("title") or target.get("range") or "Change"
    if target.get("number"):
        label = f"#{target['number']} {label}"
    return label


def render(plan, page):
    values = {
        "TITLE": html.escape(f"{title_of(plan)} · {PAGES[page][0]}", quote=True),
        "DATA": script_json(plan),
        "CORE_CSS": (ASSETS / "core.css").read_text(encoding="utf-8"),
        "CORE_JS": (ASSETS / "core.js").read_text(encoding="utf-8"),
    }

    def substitute(match):
        if match.group(1) not in values:
            raise ValueError(f"{page}.html uses unknown placeholder {match.group(0)}")
        return values[match.group(1)]

    # One pass, so placeholder-like text inside the plan is never substituted again.
    return TOKEN.sub(substitute, (ASSETS / f"{page}.html").read_text(encoding="utf-8"))


def render_index(plan, pages):
    esc = lambda value: html.escape(str(value), quote=True)
    stats = plan["stats"]
    target = plan["target"]
    cards = "".join(
        f'<a class="card" href="{esc(name)}"><span class="kicker">{esc(page)}.html</span>'
        f'<strong>{esc(PAGES[page][0])}</strong><span>{esc(PAGES[page][1])}</span>'
        f'<span class="open">Open &rarr;</span></a>' for page, name in pages)
    meta = " · ".join(filter(None, [
        esc(target.get("repo", "")),
        f"#{target['number']}" if target.get("number") else "",
        esc(str(target.get("head_sha", ""))[:10]),
        f"rules: {esc(plan['config']['name'])}"]))
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>{esc(title_of(plan))} &middot; human review</title>
<style>
:root{{--ink:#0a0a0a;--paper:#fff;--wash:#f3f3f0;--line:#d6d6cf;--muted:#56564f;--p0:#e5202e;
--sans:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;color-scheme:light}}
:root[data-mode="dark"]{{--ink:#ecece7;--paper:#13130f;--wash:#1c1c18;--line:#34342c;
--muted:#a3a39a;--p0:#ff4b55;color-scheme:dark}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.45 var(--sans);-webkit-font-smoothing:antialiased}}
.wrap{{max-width:900px;margin:0 auto;padding:clamp(28px,6vw,72px) clamp(16px,4vw,40px)}}
.kicker{{display:block;font:800 10.5px/1.15 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}}
h1{{margin:10px 0 0;font:800 clamp(24px,4vw,38px)/1.08 var(--sans);letter-spacing:-.025em}}
.meta{{margin:10px 0 0;font:500 12.5px/1.5 var(--mono);color:var(--muted)}}
.metrics{{display:flex;flex-wrap:wrap;margin:26px 0 0;border:2px solid var(--ink)}}
.metric{{flex:1 1 120px;padding:10px 14px 12px;border-right:2px solid var(--ink)}}
.metric:last-child{{border-right:0}}
.metric b{{display:block;font:800 25px/1 var(--sans);letter-spacing:-.02em;margin-top:5px}}
.metric.hot b{{color:var(--p0)}}
.cards{{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));margin:28px 0 0}}
.card{{display:flex;flex-direction:column;gap:7px;padding:18px;border:2px solid var(--ink);text-decoration:none;color:inherit;background:var(--paper)}}
.card:hover{{background:var(--ink);color:var(--paper)}}
.card:hover .kicker{{color:inherit}}
.card strong{{font:800 19px/1.2 var(--sans);letter-spacing:-.01em}}
.card span:nth-of-type(2){{font-size:13.5px;color:var(--muted)}}
.card:hover span{{color:inherit}}
.open{{margin-top:auto;font:800 10.5px/1 var(--sans);letter-spacing:.11em;text-transform:uppercase}}
footer{{margin:34px 0 0;padding-top:16px;border-top:2px solid var(--line);font-size:12.5px;color:var(--muted)}}
</style>
<script>
/* The chooser has no state of its own; it just honours the theme the tool stored. */
(function () {{
  var choice;
  try {{ choice = localStorage.getItem("human-review:theme") || "system"; }} catch (e) {{ choice = "system"; }}
  var dark = choice === "dark" || (choice === "system" && window.matchMedia &&
             window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
}})();
</script>
</head>
<body><div class="wrap">
<span class="kicker">Human review</span>
<h1>{esc(title_of(plan))}</h1>
<p class="meta">{meta}</p>
<div class="metrics">
  <div class="metric"><span class="kicker">Changed files</span><b>{stats['files']}</b></div>
  <div class="metric hot"><span class="kicker">Need your eyes</span><b>{stats['critical'] + stats['read']}</b></div>
  <div class="metric"><span class="kicker">Stop and read</span><b>{stats['critical']}</b></div>
  <div class="metric"><span class="kicker">Folded away</span><b>{stats['skip'] + stats['folded']}</b></div>
</div>
<div class="cards">{cards}</div>
<footer>Generated {esc(plan['generated_at'])} from {esc(plan['config']['source'])}.
Weights are a reading heuristic, not a verdict on the change.</footer>
</div></body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("plan", help="reading-plan.json")
    parser.add_argument("--output-dir", default="review", help="directory to write into")
    parser.add_argument("--pages", default="plan,review", help="comma-separated subset")
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    validate(plan)

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for page in [p.strip() for p in args.pages.split(",") if p.strip()]:
        if page not in PAGES:
            raise SystemExit(f"Unknown page {page!r}; choose from {', '.join(PAGES)}")
        name = f"{page}.html"
        (out / name).write_text(render(plan, page), encoding="utf-8")
        written.append((page, name))
    (out / "index.html").write_text(render_index(plan, written), encoding="utf-8")

    for _, name in written + [("index", "index.html")]:
        print((out / name).resolve())


if __name__ == "__main__":
    main()
